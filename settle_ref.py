# -*- coding: utf-8 -*-
"""期交所公告的臺指選擇權（TXO）最後結算價，依結算日查。

模擬單到期時用這個結算，不用收盤價——依期交所契約規格，台指選擇權最後結算價是
到期日現貨「收盤前三十分鐘」標的指數的簡單算術平均，和 13:30 那一筆收盤價不一定相同。
"""
import datetime as dt
import html as html_lib
import json
import os
import re
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".settle_cache.json")
# 期交所這頁的欄位由 commodityIds 決定；臺指選擇權的代號不在首頁連結裡，給一個大範圍再用表頭找 TXO 欄
IDS = "&".join("commodityIds=%d" % i for i in range(1, 46))
URL = ("https://www.taifex.com.tw/cht/5/futIndxFSP?" + IDS +
       "&start_year={y0}&start_month={m0:02d}&end_year={y1}&end_month={m1:02d}")
_last_try = {"at": 0.0}


def _cells(row_html):
    cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row_html, flags=re.S | re.I)
    return [re.sub(r"\s+", " ", html_lib.unescape(re.sub(r"<[^>]+>", " ", c))).strip() for c in cells]


def _num(x):
    try:
        return float(x.replace(",", ""))
    except ValueError:
        return None


def _parse(html):
    """期交所這張表的表頭順序和資料欄位對不上（表頭 M1F、TXO，資料實際是 TXO、M1F）。
    不信表頭：週五週選（F1～F5）只有臺指選擇權有結算價，用那幾列反推 TXO 在哪一欄。"""
    body = re.search(r"<tbody>(.*?)</tbody>", html, flags=re.S | re.I)
    if not body:
        return {}
    rows = [_cells(tr) for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", body.group(1), flags=re.S | re.I)]
    rows = [c for c in rows if len(c) > 3 and re.match(r"\d{4}/\d{2}/\d{2}$", c[0])]
    col = None
    for c in rows:
        if re.match(r"\d{6}F\d$", c[1]):
            col = next((i for i in range(2, min(len(c), 8)) if _num(c[i]) is not None), None)
            if col is not None:
                break
    if col is None:
        return {}
    out = {}
    for c in rows:
        if not re.match(r"\d{6}([WF]\d)?$", c[1]):
            continue
        v = _num(c[col])
        if v is None:
            continue
        out[c[0].replace("/", "-")] = {"contract": c[1], "price": v}
    return out


def _load():
    try:
        return json.load(open(CACHE, encoding="utf-8"))
    except Exception:
        return {}


def _fetch(around):
    d0 = around - dt.timedelta(days=40)
    url = URL.format(y0=d0.year, m0=d0.month, y1=around.year, m1=around.month)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return _parse(r.read().decode("utf-8", "replace"))


def price_on(date_iso):
    """查某結算日的 TXO 最後結算價；沒有就回 None。查不到時 20 分鐘內不重打期交所。"""
    cache = _load()
    if date_iso in cache:
        return cache[date_iso]["price"]
    if time.time() - _last_try["at"] < 1200:
        return None
    _last_try["at"] = time.time()
    try:
        fresh = _fetch(dt.date.fromisoformat(date_iso))
    except Exception:
        return None
    cache.update(fresh)
    try:
        json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    except Exception:
        pass
    hit = cache.get(date_iso)
    return hit["price"] if hit else None


if __name__ == "__main__":
    _last_try["at"] = 0
    rows = _fetch(dt.date.today())
    for k in sorted(rows)[-8:]:
        print(k, rows[k]["contract"], rows[k]["price"])
