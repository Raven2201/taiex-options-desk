# -*- coding: utf-8 -*-
"""模擬單（前測）：只追加、不改寫的紀錄檔。

paper/orders.jsonl   下單當下的完整紀錄（腳位的可成交價、決策脈絡、你的看法）
paper/events.jsonl   平倉／結算／刪除
paper/marks.jsonl    伺服器定時估值（只記持倉那幾檔）

狀態一律由這三個檔「重播」出來，檔案本身就是稽核軌跡。
"""
import datetime as dt
import json
import os
import threading
import time

import settle_ref

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "paper")
ORDERS = os.path.join(DIR, "orders.jsonl")
EVENTS = os.path.join(DIR, "events.jsonl")
MARKS = os.path.join(DIR, "marks.jsonl")
OPT_MULT = 50
TAX_OPT = 0.001        # 選擇權交易稅：權利金金額千分之一
TAX_FUT = 0.00002      # 期貨交易稅、選擇權履約：契約金額十萬分之二
_lock = threading.Lock()


def _now():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _append(path, rec):
    os.makedirs(DIR, exist_ok=True)
    with _lock, open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _read(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    return out


def _mult(leg):
    if leg["kind"] == "fut":
        return leg.get("fmult") or OPT_MULT
    return OPT_MULT


# ---------- 成本 ----------
def _side_cost(legs, prices, fee):
    """一次進場或出場的手續費＋交易稅。prices 對應每一腳該邊的成交價。"""
    c = 0.0
    for leg, px in zip(legs, prices):
        lots = leg["qty"]
        c += fee * lots
        if leg["kind"] == "fut":
            c += TAX_FUT * px * _mult(leg) * lots
        else:
            c += TAX_OPT * px * OPT_MULT * lots
    return c


def _settle_cost(legs, S, fee):
    c = 0.0
    for leg in legs:
        if leg["kind"] == "fut":
            c += (fee + TAX_FUT * S * _mult(leg)) * leg["qty"]
        elif (leg["kind"] == "call" and S > leg["K"]) or (leg["kind"] == "put" and S < leg["K"]):
            c += (fee + TAX_FUT * S * OPT_MULT) * leg["qty"]
    return c


# ---------- 損益 ----------
def pnl_at_settle(order, S):
    gross = 0.0
    for leg in order["legs"]:
        if leg["kind"] == "fut":
            val = S
        elif leg["kind"] == "call":
            val = max(0.0, S - leg["K"])
        else:
            val = max(0.0, leg["K"] - S)
        gross += leg["dir"] * leg["qty"] * (val - leg["fill"]) * _mult(leg)
    fee = order.get("fee", 0)
    entry = _side_cost(order["legs"], [l["fill"] for l in order["legs"]], fee)
    return gross - entry - _settle_cost(order["legs"], S, fee), gross


def exit_prices(order, quotes):
    """平倉吃得到的價：原本買的現在賣（收買價），原本賣的現在買回（付賣價）。"""
    fut_px = quotes["future"]["last"]
    chain = None
    for c in quotes.get("contracts", []):
        if c["expiry"] == order["expiry"]:
            chain = {r["K"]: r for r in c["rows"]}
    if chain is None:
        return None
    out = []
    for leg in order["legs"]:
        if leg["kind"] == "fut":
            out.append({"exit": fut_px, "mid": fut_px})
            continue
        r = chain.get(leg["K"])
        if not r:
            return None
        k = leg["kind"]
        bid, ask, mid = r.get(k + "_bid"), r.get(k + "_ask"), r.get(k)
        if mid is None:
            return None
        ex = (bid if leg["dir"] > 0 else ask) or mid
        out.append({"exit": ex, "mid": mid})
    return out


def pnl_from_exits(order, exits, use="exit"):
    gross = 0.0
    for leg, e in zip(order["legs"], exits):
        gross += leg["dir"] * leg["qty"] * (e[use] - leg["fill"]) * _mult(leg)
    return gross


# ---------- 狀態重播 ----------
def state():
    orders = {o["id"]: dict(o, status="open") for o in _read(ORDERS)}
    for ev in _read(EVENTS):
        o = orders.get(ev.get("id"))
        if not o:
            continue
        if ev["type"] == "delete":
            o["status"] = "deleted"
        elif ev["type"] in ("close", "settle") and o["status"] == "open":
            o["status"] = "closed" if ev["type"] == "close" else "settled"
            o["result"] = ev
    marks = {}
    for m in _read(MARKS):
        marks.setdefault(m["id"], []).append([m["ts"], m["mtm"], m["F"]])
    live = [o for o in orders.values() if o["status"] != "deleted"]
    for o in live:
        ms = marks.get(o["id"], [])
        o["marks"] = ms[-300:]
        o["worstMark"] = min([x[1] for x in ms]) if ms else None
        o["bestMark"] = max([x[1] for x in ms]) if ms else None
    live.sort(key=lambda o: o["createdAt"], reverse=True)
    return live


def add(rec):
    rec = dict(rec)
    rec["id"] = "P" + dt.datetime.now().strftime("%Y%m%d%H%M%S%f")[:-3]
    rec["savedAt"] = _now()
    _append(ORDERS, rec)
    return rec["id"]


def close(order_id, quotes):
    o = next((x for x in state() if x["id"] == order_id), None)
    if not o or o["status"] != "open":
        return {"error": "找不到這筆持倉，或它已經平倉／結算"}
    exits = exit_prices(o, quotes)
    if not exits:
        return {"error": "目前報價裡找不到這筆的到期系列或履約價，無法平倉（可能已過期，等結算）"}
    gross = pnl_from_exits(o, exits)
    fee = o.get("fee", 0)
    cost = (_side_cost(o["legs"], [l["fill"] for l in o["legs"]], fee)
            + _side_cost(o["legs"], [e["exit"] for e in exits], fee))
    ev = {"type": "close", "id": order_id, "ts": _now(), "F": quotes["future"]["last"],
          "exits": [e["exit"] for e in exits], "gross": round(gross, 1),
          "cost": round(cost, 1), "pnl": round(gross - cost, 1)}
    _append(EVENTS, ev)
    return ev


def delete(order_id):
    _append(EVENTS, {"type": "delete", "id": order_id, "ts": _now()})
    return {"ok": True}


# ---------- 背景：估值與結算 ----------
def mark_and_settle(get_quotes):
    open_orders = [o for o in state() if o["status"] == "open"]
    if not open_orders:
        return
    now = dt.datetime.now()
    quotes = None
    for o in open_orders:
        exp_dt = dt.datetime.fromisoformat(o["expiry"] + "T13:30:00")
        if now >= exp_dt:
            S = settle_ref.price_on(o["expiry"])
            if S is None:
                continue
            pnl, gross = pnl_at_settle(o, S)
            view = o.get("view") or {}
            hit = None
            if view.get("lo") and view.get("hi"):
                hit = view["lo"] <= S <= view["hi"]
            elif view.get("t") and view.get("b"):
                hit = abs(S - view["t"]) <= view["b"]
            _append(EVENTS, {"type": "settle", "id": o["id"], "ts": _now(), "S": S,
                             "gross": round(gross, 1), "cost": round(gross - pnl, 1),
                             "pnl": round(pnl, 1), "viewHit": hit})
            continue
        if quotes is None:
            try:
                quotes = get_quotes()
            except Exception:
                return
        exits = exit_prices(o, quotes)
        if not exits:
            continue
        _append(MARKS, {"id": o["id"], "ts": _now(), "F": quotes["future"]["last"],
                        "mtm": round(pnl_from_exits(o, exits), 1)})


def start_worker(get_quotes, every=300):
    def loop():
        while True:
            try:
                mark_and_settle(get_quotes)
            except Exception:
                pass
            time.sleep(every)
    threading.Thread(target=loop, daemon=True).start()
