import unittest
from unittest.mock import patch
import datetime as dt
from data import roc_date, normalize_tse, normalize_otc, normalize_quote, quotes, search, TZ

class DataTests(unittest.TestCase):
    def test_dates(self):
        self.assertEqual(roc_date('115年09月22日'),'2026-09-22')
        self.assertEqual(roc_date('1150922'),'2026-09-22')
        self.assertEqual(roc_date('20260922'),'2026-09-22')
        self.assertIsNone(roc_date(''))

    def test_tse_adjusted_ratio_and_trade_end(self):
        row=['03001T','啟碁台新5A售02','0.00','','6285','啟碁','233.50','','認售','歐式','115年04月17日','115年10月16日','115年10月14日','115年10月16日',0.051,'206.52','','']
        w=normalize_tse(row,'20260922')
        self.assertEqual(w['ratio'],0.051)
        self.assertEqual(w['kind'],'put')
        self.assertEqual(w['lastTrade'],'2026-10-14')
        self.assertEqual(w['expiry'],'2026-10-16')
        self.assertIsNone(w['last'])
        self.assertIsNone(w['bid'])

    def test_otc_ratio_is_already_per_unit(self):
        w=normalize_otc({'Code':'700019','Name':'宏捷科統一','UnderlyingStockCode':'8086','UnderlyingStock':'宏捷科','Type':'認購','American/European':'美式','ExpiryDate':'20261231','LatestExercisePrice':'166.48','Latest ExerciseRatio':'0.013','Date':'1150922'}, {}, {'最後交易日':'1151229'})
        self.assertEqual(w['ratio'],0.013)
        self.assertEqual(w['lastTrade'],'2026-12-29')
        self.assertEqual(w['style'],'美式')

    def test_quote_does_not_invent_missing_bid_or_trade(self):
        q=normalize_quote({'c':'03001T','ex':'tse','z':'-','a':'1.05_1.06_','b':'-_','d':'20260922','t':'13:30:00','v':'12'})
        self.assertEqual(q['ask'],1.05)
        self.assertIsNone(q['bid'])
        self.assertIsNone(q['last'])
        self.assertEqual(q['quoteAt'],'2026-09-22T13:30:00+08:00')

    def test_quote_endpoint_rejects_arbitrary_urls(self):
        with self.assertRaises(ValueError):
            quotes(['https://example.com/private'])
        with self.assertRaises(ValueError):
            quotes(['tse_2330.tw']+[f'tse_{1000+i}.tw' for i in range(41)])

    def test_search_filters_and_paginates_before_returning(self):
        future=(dt.datetime.now(TZ).date()+dt.timedelta(days=60)).isoformat()
        rows=[dict(code=str(10000+i),name='測試權證',underlying='2330',underlyingName='台積電',kind='call',market='tse',expiry=future,supported=True) for i in range(20)]
        with patch('data.catalogue',return_value={'items':rows,'errors':[]}):
            d=search('2330',offset=12,min_days=30)
            self.assertEqual(d['total'],20)
            self.assertEqual(len(d['items']),8)
            self.assertEqual(search('2330',kind='put')['total'],0)
            self.assertEqual(search('2330',market='otc')['total'],0)

    def test_capped_products_are_not_priced_as_vanilla(self):
        row=['03001T','測試牛證','0','','2330','台積電','100','','認購','歐式','1150101','1151001','1150929','1151001',0.1,100,120,'']
        self.assertFalse(normalize_tse(row,'20260922')['supported'])

if __name__=='__main__':unittest.main()
