# -*- coding: utf-8 -*-
"""台指期歷史波動：ATR 與已實現波動度，拿來跟選擇權的 IV 對照。

IV 是市場開的保險價，這裡算的是過去真的走出來多少。兩者的比值才是資訊。
日線一天只變一次，所以結果快取到當天結束。
"""
import datetime as dt
import json
import math
import os
import statistics as st
import urllib.parse
import urllib.request

API = "https://api.finmindtrade.com/api/v4/data"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".hist_cache.json")


def _fetch(lookback_days=200):
    q = urllib.parse.urlencode({
        "dataset": "TaiwanFuturesDaily", "data_id": "TX",
        "start_date": (dt.date.today() - dt.timedelta(days=lookback_days)).isoformat(),
        "end_date": dt.date.today().isoformat(),
    })
    req = urllib.request.Request(API + "?" + q, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8")).get("data") or []


def _front_month(rows):
    """每天取近月、日盤、成交量最大的那一口，避開價差商品與盤後重複。"""
    best = {}
    for r in rows:
        if "/" in (r.get("contract_date") or ""):
            continue
        if r.get("trading_session") not in (None, "position"):
            continue
        if not r.get("close"):
            continue
        d = r["date"]
        if d not in best or r["volume"] > best[d]["volume"]:
            best[d] = r
    return [best[d] for d in sorted(best)]


def compute(days):
    if len(days) < 25:
        return None
    tr = []
    for i in range(1, len(days)):
        h, l, pc = days[i]["max"], days[i]["min"], days[i - 1]["close"]
        tr.append(max(h - l, abs(h - pc), abs(l - pc)))
    rets = [math.log(days[i]["close"] / days[i - 1]["close"]) for i in range(1, len(days))]

    def hv(n):
        return st.pstdev(rets[-n:]) * math.sqrt(252) * 100

    last = days[-1]
    return {
        "asOf": last["date"],
        "close": last["close"],
        "atr14": round(st.mean(tr[-14:]), 1),
        "atr60": round(st.mean(tr[-60:]), 1) if len(tr) >= 60 else None,
        "range14": round(st.mean([d["max"] - d["min"] for d in days[-14:]]), 1),
        "hv10": round(hv(10), 1),
        "hv20": round(hv(20), 1),
        "hv60": round(hv(60), 1) if len(rets) >= 60 else None,
        "n": len(days),
    }


def stats(force=False):
    """有快取就用快取；抓不到資料就回 None，看台照常運作。"""
    today = dt.date.today().isoformat()
    if not force and os.path.exists(CACHE):
        try:
            c = json.load(open(CACHE, encoding="utf-8"))
            if c.get("cachedOn") == today:
                return c.get("data")
        except Exception:
            pass
    try:
        data = compute(_front_month(_fetch()))
    except Exception:
        data = None
    if data:
        try:
            json.dump({"cachedOn": today, "data": data}, open(CACHE, "w", encoding="utf-8"),
                      ensure_ascii=False)
        except Exception:
            pass
    return data


if __name__ == "__main__":
    s = stats(force=True)
    if not s:
        raise SystemExit("抓不到歷史日線")
    print("台指期近月日線 %d 天，最後 %s 收 %.0f" % (s["n"], s["asOf"], s["close"]))
    print("ATR(14) %.0f 點   ATR(60) %s   近14日平均日內區間 %.0f 點"
          % (s["atr14"], s["atr60"], s["range14"]))
    print("已實現波動度（年化）  10日 %.1f%%   20日 %.1f%%   60日 %s"
          % (s["hv10"], s["hv20"], s["hv60"]))
