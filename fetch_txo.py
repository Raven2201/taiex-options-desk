# -*- coding: utf-8 -*-
"""抓台指期／台指選擇權即時報價（期交所 MIS），輸出看台用的 latest.json。

用法:
    python fetch_txo.py                # 寫入 latest.json
    python fetch_txo.py --span 3000    # 只留標的價 ±3000 點的履約價
    python fetch_txo.py --series 3     # 只留最近 3 個到期系列
"""
import argparse
import datetime as dt
import json
import os
import re
import urllib.request

API = "https://mis.taifex.com.tw/futures/api/getQuoteList"
HEAD = {
    "Content-Type": "application/json",
    "Origin": "https://mis.taifex.com.tw",
    "Referer": "https://mis.taifex.com.tw/futures/RegularSession/EquityIndices/OptionQuotes/",
    "User-Agent": "Mozilla/5.0",
}
# 盤後商品代號的後綴不同：期貨 -F/-M、選擇權 -O/-N
SYM = re.compile(r"^(.{3})(\d{4,6})([A-X])(\d)-[ON]$")
FUT = re.compile(r"^TXF[A-L]\d-[FM]$")
SESSIONS = [("0", "day", "日盤"), ("1", "night", "盤後")]
DATE_IN_NAME = re.compile(r"(\d{4})/(\d{2})/(\d{2})")


def post(cid, symbol_type, market_type="0"):
    body = json.dumps({
        "MarketType": market_type, "SymbolType": symbol_type, "KindID": "1", "CID": cid,
        "ExpireMonth": "", "RowSize": "全部", "PageNo": "", "SortColumn": "", "SortOrder": "",
    }).encode("utf-8")
    req = urllib.request.Request(API, data=body, headers=HEAD)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))["RtData"]["QuoteList"]


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def px(q):
    """兩邊都有報價就用中價當標記價——冷門履約價的「成交價」常是幾十分鐘前的
    殘影，會讓整條鏈的 IV 跳來跳去；只有單邊或無報價時才退回成交價。"""
    bid, ask = num(q.get("CBestBidPrice")), num(q.get("CBestAskPrice"))
    if bid and ask:
        return round((bid + ask) / 2, 1)
    return num(q.get("CLastPrice"))


def third_wednesday(year, month):
    d = dt.date(year, month, 1)
    d += dt.timedelta(days=(2 - d.weekday()) % 7)
    return d + dt.timedelta(days=14)


def expiry_of(prefix, name, month, year):
    m = DATE_IN_NAME.search(name or "")
    if m:
        return "%s-%s-%s" % m.groups()
    return third_wednesday(year, month).isoformat()


def front_future(quotes):
    """近月台指期：代號合格且有報價的當中，取成交量最大的那口。"""
    best = None
    for q in quotes:
        if not FUT.match(q.get("SymbolID", "")):
            continue
        if not (num(q.get("CLastPrice")) or num(q.get("CBestBidPrice"))):
            continue
        vol = num(q.get("CTotalVolume")) or 0
        if best is None or vol > best[0]:
            best = (vol, q)
    return best[1] if best else None


def stamp(q):
    d, t = q.get("CDate") or "", q.get("CTime") or ""
    return int(d + t) if len(d) == 8 and len(t) == 6 else 0


def build(span, keep_series):
    # 日盤與盤後各問一次，誰的報價時間新就用誰——不必自己判斷現在幾點、是不是交易日
    found = []
    for mt, code, label in SESSIONS:
        try:
            f = front_future(post("TXF", "F", mt))
        except Exception:
            f = None
        if f:
            found.append((stamp(f), mt, code, label, f))
    if not found:
        raise SystemExit("找不到台指期近月報價")
    found.sort(key=lambda x: x[0])
    _, mt, session, session_name, f = found[-1]

    opts = post("TXO", "O", mt)
    F = num(f.get("CLastPrice")) or num(f.get("CBestBidPrice")) or num(f.get("CRefPrice"))

    series = {}
    for q in opts:
        m = SYM.match(q.get("SymbolID", ""))
        if not m:
            continue
        prefix, strike, letter, ydigit = m.group(1), int(m.group(2)), m.group(3), int(m.group(4))
        is_call = letter <= "L"
        month = (ord(letter) - ord("A") + 1) if is_call else (ord(letter) - ord("M") + 1)
        year = 2020 + ydigit
        if abs(strike - F) > span:
            continue
        name = q.get("DispCName") or q.get("DispEName") or prefix
        exp = expiry_of(prefix, name, month, year)
        # 同一個 prefix 會橫跨多個到期月（TXO 有季月），到期日才是真正的 key
        s = series.setdefault((prefix, exp), {
            "code": prefix, "name": name.split("(")[0].strip(), "expiry": exp, "rows": {},
        })
        row = s["rows"].setdefault(strike, {"K": strike})
        side = "call" if is_call else "put"
        row[side] = px(q)
        row[side + "_bid"] = num(q.get("CBestBidPrice"))
        row[side + "_ask"] = num(q.get("CBestAskPrice"))
        row[side + "_vol"] = num(q.get("CTotalVolume"))

    out = []
    # 到期日當天 13:30 結算後那個系列就沒得交易了，留著只會讓看台預設選到一條死鏈
    now = dt.datetime.now()
    for s in series.values():
        if dt.datetime.fromisoformat(s["expiry"] + "T13:30:00") <= now:
            continue
        rows = [s["rows"][k] for k in sorted(s["rows"])]
        rows = [r for r in rows if r.get("call") or r.get("put")]
        if len(rows) < 5:
            continue
        s["rows"] = rows
        s["days"] = (dt.date.fromisoformat(s["expiry"]) - dt.date.today()).days
        out.append(s)
    out.sort(key=lambda s: (s["expiry"], s["code"]))
    out = out[:keep_series]

    ctime, cdate = f.get("CTime") or "", f.get("CDate") or ""
    quote_time = "%s:%s:%s" % (ctime[0:2], ctime[2:4], ctime[4:6]) if len(ctime) == 6 else ""
    # 報價自己的時間戳，不是我們抓取的時間——收盤後兩者會差好幾個小時
    quote_ts = ""
    if len(ctime) == 6 and len(cdate) == 8:
        quote_ts = dt.datetime.strptime(cdate + ctime, "%Y%m%d%H%M%S").astimezone().isoformat(timespec="seconds")
    return {
        "ts": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": "TAIFEX MIS",
        "future": {
            "symbol": re.sub(r"-[FM]$", "", f.get("SymbolID", "")),
            "session": session,
            "sessionName": session_name,
            "name": f.get("DispEName", ""),
            "last": F,
            "ref": num(f.get("CRefPrice")),
            "diff": float(f.get("CDiff") or 0),
            "diffRate": float(f.get("CDiffRate") or 0),
            "volume": num(f.get("CTotalVolume")),
            "time": quote_time,
            "date": cdate,
            "quoteTs": quote_ts,
        },
        "contracts": out,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--span", type=float, default=2500, help="保留標的價 ±N 點的履約價")
    ap.add_argument("--series", type=int, default=4, help="保留最近幾個到期系列")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "latest.json"))
    a = ap.parse_args()

    data = build(a.span, a.series)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    fu = data["future"]
    print("[%s] 台指期 %s %.0f (%+.0f)  報價時間 %s"
          % (fu["sessionName"], fu["symbol"], fu["last"], fu["diff"], fu["time"]))
    for c in data["contracts"]:
        print("  %-4s %s  %2d 天  %d 檔履約價" % (c["code"], c["expiry"], c["days"], len(c["rows"])))
    print("→ %s  (%.0f KB)" % (a.out, os.path.getsize(a.out) / 1024))


if __name__ == "__main__":
    main()
