# -*- coding: utf-8 -*-
"""各到期系列的逐履約價未平倉量與昨對前的增減（期交所每日收盤檔）。

即時報價（MIS）沒有未平倉量，只有成交量，所以這一定是「前一個交易日收盤」的快照。
牆不在這裡挑——同一天到期的深價外常有幾千口殘留部位，挑全系列最大會選到 4,000 點外，
所以只回傳整條梯子，由頁面在現價附近的窗口裡找。
"""
import datetime as dt
import json
import os
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".walls_cache.json")
URL = "https://www.taifex.com.tw/cht/3/optDataDown"
MAX_DAYS = 45          # 只留近月，遠月的梯子沒人看、白佔頻寬
_last_try = {"at": 0.0}


def _fetch_day(d):
    q = d.strftime("%Y/%m/%d")
    body = urllib.parse.urlencode({"down_type": "1", "commodity_id": "TXO", "commodity_idt": "TXO",
                                   "queryStartDate": q, "queryEndDate": q, "queryType": "2",
                                   "marketCode": "0", "MarketCode": "0"}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "User-Agent": "Mozilla/5.0", "Referer": "https://www.taifex.com.tw/cht/3/optDailyMarketReport"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("big5", "replace")


def _parse(text):
    """{到期日 ISO: {'call': {K: OI}, 'put': {K: OI}}}，只取一般交易時段。"""
    out = {}
    for line in text.splitlines()[1:]:
        f = [x.strip() for x in line.split(",")]
        if len(f) < 21 or f[1] != "TXO" or f[17] != "一般":
            continue
        exp = f[-1]
        if len(exp) != 8 or not exp.isdigit():
            continue
        try:
            K, oi = float(f[3]), float(f[11])
        except ValueError:
            continue
        if oi <= 0:
            continue
        iso = exp[:4] + "-" + exp[4:6] + "-" + exp[6:]
        side = "call" if f[4] == "買權" else "put"
        out.setdefault(iso, {"call": {}, "put": {}})[side][K] = oi
    return out


def _day_with_data(start, tries=8):
    """往前找最近一個有未平倉資料的交易日；盤中的檔案未平倉欄是空的，也會被跳過。"""
    for back in range(tries):
        d = start - dt.timedelta(days=back)
        if d.weekday() >= 5:
            continue
        try:
            rows = _parse(_fetch_day(d))
        except Exception:
            return None, None
        if rows:
            return d, rows
    return None, None


def _ladder(today, prev, horizon):
    """每個到期日一條梯子：[{K, c, p, dc, dp}]，d* 是與前一交易日的增減。"""
    out = {}
    for iso, sides in today.items():
        if dt.date.fromisoformat(iso) > horizon:
            continue
        old = prev.get(iso, {"call": {}, "put": {}})
        rows = []
        for K in sorted(set(list(sides["call"]) + list(sides["put"]))):
            c, p = sides["call"].get(K, 0), sides["put"].get(K, 0)
            rows.append({"K": K, "c": c, "p": p,
                         "dc": c - old["call"].get(K, 0), "dp": p - old["put"].get(K, 0)})
        out[iso] = {"rows": rows,
                    "callOI": sum(sides["call"].values()), "putOI": sum(sides["put"].values())}
    return out


def snapshot(ttl=3600):
    """{'date', 'prevDate', 'series': {到期日: {'rows': [...], 'callOI', 'putOI'}}}。"""
    cache = {}
    try:
        cache = json.load(open(CACHE, encoding="utf-8"))
    except Exception:
        pass
    if cache.get("fetchedAt", 0) + ttl > time.time() or time.time() - _last_try["at"] < 600:
        return cache.get("data")
    _last_try["at"] = time.time()
    d1, today = _day_with_data(dt.date.today())
    if not today:
        return cache.get("data")
    d0, prev = _day_with_data(d1 - dt.timedelta(days=1))
    data = {"date": d1.isoformat(), "prevDate": d0.isoformat() if d0 else None,
            "series": _ladder(today, prev or {}, d1 + dt.timedelta(days=MAX_DAYS))}
    try:
        json.dump({"fetchedAt": time.time(), "data": data}, open(CACHE, "w", encoding="utf-8"))
    except Exception:
        pass
    return data


if __name__ == "__main__":
    s = snapshot(ttl=0)
    print(s["date"], "對照", s["prevDate"])
    for iso in sorted(s["series"])[:3]:
        w = s["series"][iso]
        big = sorted(w["rows"], key=lambda r: -(r["c"] + r["p"]))[:3]
        print(iso, "%d 檔" % len(w["rows"]),
              " ".join("%d C%d(%+d)/P%d(%+d)" % (r["K"], r["c"], r["dc"], r["p"], r["dp"]) for r in big))
