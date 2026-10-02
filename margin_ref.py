# -*- coding: utf-8 -*-
"""期交所公告的選擇權風險保證金 A／B／C 值。

這幾個數字一年會調整好幾次，寫死在程式裡遲早算錯，所以直接抓公告頁，快取一天。
"""
import datetime as dt
import json
import os
import re
import urllib.request

URL = "https://www.taifex.com.tw/cht/5/indexMarging"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".margin_cache.json")
ROW = "臺指選擇權風險保證金\\({}\\)值"


def _num(x):
    return int(x.replace(",", ""))


def _parse(html):
    txt = re.sub(r"<[^>]+>", "\t", html)
    txt = txt.replace("&nbsp;", " ")
    out = {}
    for tag in ("A", "B", "C"):
        m = re.search(ROW.format(tag) + r"[\t\s]*([\d,]+)[\t\s]*([\d,]+)[\t\s]*([\d,]+)", txt)
        if not m:
            continue
        out[tag] = {"clearing": _num(m.group(1)), "maintenance": _num(m.group(2)),
                    "initial": _num(m.group(3))}
    for name, key in (("臺股期貨", "TX"), ("小型臺指", "MTX")):
        m = re.search(name + r"[	\s]*([\d,]+)[	\s]*([\d,]+)[	\s]*([\d,]+)", txt)
        if m:
            out[key] = {"clearing": _num(m.group(1)), "maintenance": _num(m.group(2)),
                        "initial": _num(m.group(3))}
    m = re.search(r"更新日期[：:]\s*([\d/]+)", txt)
    if m:
        out["updated"] = m.group(1)
    return out if ("A" in out and "B" in out) else None


def fetch():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return _parse(r.read().decode("utf-8", "replace"))


def values(force=False):
    """抓不到就回 None——寧可畫面上不顯示保證金，也不要顯示過期的數字。"""
    today = dt.date.today().isoformat()
    if not force and os.path.exists(CACHE):
        try:
            c = json.load(open(CACHE, encoding="utf-8"))
            if c.get("cachedOn") == today:
                return c.get("data")
        except Exception:
            pass
    try:
        data = fetch()
    except Exception:
        data = None
    if data:
        data["source"] = URL
        try:
            json.dump({"cachedOn": today, "data": data}, open(CACHE, "w", encoding="utf-8"),
                      ensure_ascii=False)
        except Exception:
            pass
    return data


if __name__ == "__main__":
    v = values(force=True)
    if not v:
        raise SystemExit("抓不到期交所保證金公告")
    print("期交所公告（更新日期 %s）" % v.get("updated"))
    for k in ("A", "B", "C", "TX", "MTX"):
        if k in v:
            print("  %s 值   結算 %s   維持 %s   原始 %s"
                  % (k, format(v[k]["clearing"], ","), format(v[k]["maintenance"], ","),
                     format(v[k]["initial"], ",")))
