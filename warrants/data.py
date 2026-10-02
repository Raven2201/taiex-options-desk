"""Official TWSE/TPEx catalogue and per-security website quotes; standard library only."""
import concurrent.futures
import datetime as dt
import json
from pathlib import Path
import re
import threading
import time
import urllib.parse
import urllib.request

TZ = dt.timezone(dt.timedelta(hours=8))
CACHE = Path(__file__).parent / 'runtime'
URLS = {
    'tse': 'https://www.twse.com.tw/rwd/zh/stock/warrantStock?response=json',
    'otc': 'https://www.tpex.org.tw/openapi/v1/tpex_warrant_issue',
    'otc_close': 'https://www.tpex.org.tw/openapi/v1/tpex_warrant_daily_quts',
    'otc_basic': 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap37_O',
}
_lock = threading.Lock()
_catalog = None
_catalog_at = 0
_quote_lock = threading.Lock()
_quotes = {}

def num(value):
    try:
        n = float(str(value).replace(',', '').strip())
        return n if n > 0 and n < float('inf') else None
    except (TypeError, ValueError):
        return None

def roc_date(value):
    s = re.sub(r'\D', '', str(value or ''))
    try:
        if len(s) == 7:
            s = str(int(s[:3]) + 1911) + s[3:]
        return dt.datetime.strptime(s, '%Y%m%d').date().isoformat() if len(s) == 8 else None
    except ValueError:
        return None

def _base(code, name, market, underlying, underlying_name, kind, style, strike, ratio, expiry, last_trade, date, cap=None, floor=None):
    supported = (kind in ('認購', '認售') and bool(re.fullmatch(r'\d{4,6}[A-Z]?', underlying or ''))
                 and not num(cap) and not num(floor) and not any(x in name for x in ('牛', '熊'))
                 and bool(num(strike) and num(ratio) and expiry))
    return dict(code=code, name=name, market=market, underlying=underlying, underlyingName=underlying_name,
                kind='call' if kind == '認購' else 'put', style=style, strike=num(strike), ratio=num(ratio),
                expiry=expiry, lastTrade=last_trade, dataDate=roc_date(date), supported=supported,
                bid=None, ask=None, last=None, spot=None, quoteAt=None, source='官方每日資料')

def normalize_tse(row, date):
    if len(row) < 18:
        raise ValueError('上市權證欄位數改變')
    w = _base(str(row[0]), row[1], 'tse', str(row[4]), row[5], row[8], row[9], row[15], row[14],
              roc_date(row[13]), roc_date(row[12]), date, row[16], row[17])
    w.update(last=num(row[2]), spot=num(row[6]))
    return w

def normalize_otc(row, close, basic):
    w = _base(row['Code'], row['Name'], 'otc', row.get('UnderlyingStockCode', ''), row.get('UnderlyingStock', ''),
              row.get('Type'), row.get('American/European', ''), row.get('LatestExercisePrice'),
              row.get('Latest ExerciseRatio'), roc_date(row.get('ExpiryDate')),
              roc_date(basic.get('最後交易日')), row.get('Date'), row.get('CapPrice/Index'), row.get('FloorPrice/Index'))
    if row.get('Reset', 'N') != 'N':
        w['supported'] = False
    w.update(last=num(close.get('Close')), spot=num(close.get('UnderlyingStockClosePrice')))
    return w

def normalize_quote(q):
    date = roc_date(q.get('d'))
    clock = q.get('t', '')
    stamp = date + 'T' + clock + '+08:00' if date and re.fullmatch(r'\d{2}:\d{2}:\d{2}', clock) else None
    return dict(code=q.get('c'), market=q.get('ex'), last=num(q.get('z')),
                bid=num(str(q.get('b', '')).split('_')[0]), ask=num(str(q.get('a', '')).split('_')[0]),
                volume=num(q.get('v')) or 0, quoteAt=stamp, date=date, name=q.get('n', ''), source='TWSE MIS 網站行情')

def fetch_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
                                                 'Referer': 'https://mis.twse.com.tw/stock/index.jsp'})
    with urllib.request.urlopen(request, timeout=18) as response:
        return json.loads(response.read().decode('utf-8-sig'))

def resource(key):
    path = CACHE / (key + '.json')
    saved = None
    try:
        saved = json.loads(path.read_text(encoding='utf-8'))
        if time.time() - saved['at'] < 3600:
            return saved['data'], None
    except (OSError, ValueError, KeyError):
        pass
    try:
        data = fetch_json(URLS[key])
        if key == 'tse':
            if data.get('stat') != 'OK' or not data.get('data'):
                raise ValueError('上市資料尚未提供')
        elif not isinstance(data, list) or not data:
            raise ValueError('上櫃資料尚未提供')
        CACHE.mkdir(exist_ok=True)
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps({'at': time.time(), 'data': data}, ensure_ascii=False), encoding='utf-8')
        temp.replace(path)
        return data, None
    except Exception as e:
        if saved:
            return saved['data'], f'{key} 更新失敗，沿用舊資料：{type(e).__name__}'
        return None, f'{key} 無法取得：{type(e).__name__}'

def catalogue():
    global _catalog, _catalog_at
    with _lock:
        if _catalog is not None and time.time() - _catalog_at < 300:
            return _catalog
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = dict(zip(URLS, pool.map(resource, URLS)))
        errors = [err for _, err in results.values() if err]
        items = []
        today = dt.datetime.now(TZ).date().isoformat()
        tse = results['tse'][0]
        if tse:
            for row in tse['data']:
                try:
                    items.append(normalize_tse(row, tse['date']))
                except (ValueError, KeyError, IndexError):
                    errors.append('有上市權證欄位無法解析')
        closes = {r['Code']: r for r in (results['otc_close'][0] or [])}
        basics = {r['權證代號']: r for r in (results['otc_basic'][0] or [])}
        for row in results['otc'][0] or []:
            try:
                items.append(normalize_otc(row, closes.get(row['Code'], {}), basics.get(row['Code'], {})))
            except (ValueError, KeyError):
                errors.append('有上櫃權證欄位無法解析')
        items = [w for w in items if w['expiry'] and w['expiry'] >= today]
        _catalog = {'items': items, 'errors': sorted(set(errors)), 'fetchedAt': dt.datetime.now(TZ).isoformat(timespec='seconds')}
        _catalog_at = time.time()
        return _catalog

def search(query, kind='all', limit=12, offset=0, min_days=0, max_days=730, market='all'):
    data = catalogue()
    q = query.strip().lower()
    today = dt.datetime.now(TZ).date()
    matches = [w for w in data['items'] if (kind == 'all' or kind == w['kind']) and
               (market == 'all' or market == w['market']) and
               min_days <= (dt.date.fromisoformat(w['expiry'])-today).days <= max_days and
               (not q or any(q in str(w[k]).lower() for k in ('code', 'name', 'underlying', 'underlyingName')))]
    matches.sort(key=lambda w: (not w['supported'], w['expiry'], w['code']))
    return {**data, 'items': matches[offset:offset+limit], 'total': len(matches), 'limit': limit, 'offset': offset}

def quotes(keys):
    keys = sorted(set(keys))
    if len(keys) > 40 or any(not re.fullmatch(r'(tse|otc)_\d{4,6}[A-Z]?\.tw', k) for k in keys):
        raise ValueError('行情代碼格式錯誤或超過 40 檔')
    if not keys:
        return {'items': [], 'fetchedAt': dt.datetime.now(TZ).isoformat(timespec='seconds')}
    cache_key = '|'.join(keys)
    with _quote_lock:
        cached = _quotes.get(cache_key)
        if cached and time.time() - cached[0] < 10:
            return cached[1]
    url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?' + urllib.parse.urlencode({'ex_ch': cache_key, 'json': '1', 'delay': '0'})
    result = fetch_json(url)
    if result.get('rtcode') != '0000':
        raise ValueError('行情來源未回傳成功狀態')
    data = {'items': [normalize_quote(q) for q in result.get('msgArray', [])], 'fetchedAt': dt.datetime.now(TZ).isoformat(timespec='seconds')}
    with _quote_lock:
        if len(_quotes) > 100:
            _quotes.clear()
        _quotes[cache_key] = (time.time(), data)
    return data
