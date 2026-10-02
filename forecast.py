# -*- coding: utf-8 -*-
"""區間預測練習：只追加的紀錄，結算後用期交所最後結算價自動評分。

forecasts/forecasts.jsonl  每一筆預測（你的區間、把握度、理由，以及當下市場同把握度的區間）
forecasts/events.jsonl     結算評分、刪除

評分用區間分數（interval score）：區間寬度＋沒中時的罰款，罰款＝差幾點 × 2/(1−把握度)。
數字越小越好；同一套公式也替市場的區間打分，再除以當時的 1σ，不同週才能放在一起比。
"""
import datetime as dt
import json
import os
import threading

import settle_ref

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "forecasts")
FC = os.path.join(DIR, "forecasts.jsonl")
EV = os.path.join(DIR, "events.jsonl")
CONFS = (50, 68, 80, 90)
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
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def interval_score(lo, hi, y, conf):
    a = 1 - conf / 100.0
    s = hi - lo
    if y < lo:
        s += 2 / a * (lo - y)
    elif y > hi:
        s += 2 / a * (y - hi)
    return s


def add(rec):
    try:
        lo, hi, conf = float(rec["lo"]), float(rec["hi"]), int(rec["conf"])
        mlo, mhi, sigma = float(rec["mlo"]), float(rec["mhi"]), float(rec["sigma"])
        dt.date.fromisoformat(rec["expiry"])
    except (KeyError, TypeError, ValueError):
        return {"error": "預測資料不完整"}
    if not (0 < lo < hi) or conf not in CONFS or not sigma > 0:
        return {"error": "區間或把握度不合理"}
    rec = dict(rec, lo=lo, hi=hi, conf=conf, mlo=mlo, mhi=mhi, sigma=sigma,
               reason=str(rec.get("reason", ""))[:500], wrong=str(rec.get("wrong", ""))[:300])
    rec["id"] = "F" + dt.datetime.now().strftime("%Y%m%d%H%M%S%f")[:-3]
    rec["savedAt"] = _now()
    _append(FC, rec)
    return {"id": rec["id"]}


def delete(fid):
    _append(EV, {"type": "delete", "id": fid, "ts": _now()})
    return {"ok": True}


def _settle(f):
    """到期日 13:30 過後去期交所拿結算價；拿不到就下次再試（settle_ref 自己會擋重複打）。"""
    if dt.datetime.now() < dt.datetime.fromisoformat(f["expiry"] + "T13:45:00"):
        return None
    y = settle_ref.price_on(f["expiry"])
    if y is None:
        return None
    ev = {"type": "settle", "id": f["id"], "ts": _now(), "S": y,
          "hit": f["lo"] <= y <= f["hi"], "mhit": f["mlo"] <= y <= f["mhi"],
          "score": round(interval_score(f["lo"], f["hi"], y, f["conf"]) / f["sigma"], 3),
          "mscore": round(interval_score(f["mlo"], f["mhi"], y, f["conf"]) / f["sigma"], 3)}
    _append(EV, ev)
    return ev


def state():
    fs = {f["id"]: dict(f) for f in _read(FC)}
    for ev in _read(EV):
        f = fs.get(ev.get("id"))
        if not f:
            continue
        if ev["type"] == "delete":
            f["deleted"] = True
        elif ev["type"] == "settle":
            f["result"] = ev
    out = []
    for f in fs.values():
        if f.get("deleted"):
            continue
        if "result" not in f:
            r = _settle(f)
            if r:
                f["result"] = r
        out.append(f)
    out.sort(key=lambda f: f["savedAt"], reverse=True)
    return out
