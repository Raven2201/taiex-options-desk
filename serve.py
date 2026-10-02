# -*- coding: utf-8 -*-
"""台指選擇權看台：服務頁面，並代抓期交所行情。

    python serve.py            # http://127.0.0.1:8770
    python serve.py --port 9000 --refresh 5

頁面自己每 __REFRESH__ 秒打一次 /api/quotes；瀏覽器不能直連期交所（CORS），
所以由這支代抓，順便做幾秒快取。
"""
import argparse
import http.server
import json
import os
import threading
import time
import urllib.request
import webbrowser

import fetch_txo
import hist_vol
import margin_ref
import oi_walls
import forecast
import paper

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "txo_desk.html")
# 直接回傳的靜態檔：路徑 → (檔名, 型別)
STATIC = {"/decision-guide.js": ("decision-guide.js", "text/javascript"),
          "/decision-guide.css": ("decision-guide.css", "text/css"),
          "/core.js": ("core.js", "text/javascript"),
          "/learn": ("learn.html", "text/html"),
          "/options_manual.html": ("options_manual.html", "text/html")}

HEAD = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:light dark}body{margin:0}img{max-width:100%}
[hidden]:not([hidden=until-found i]){display:none!important}</style>
<script>window.__TXO_REFRESH__=__REFRESH__;</script>
</head><body>
"""
TAIL = "</body></html>"

class ExclusiveServer(http.server.ThreadingHTTPServer):
    """allow_reuse_address 預設為真，Windows 上會讓兩支程式綁同一個埠，
    先來的收封包——舊版沒關乾淨就會一直拿到過期的頁面。這裡要求獨占。"""
    allow_reuse_address = False


_lock = threading.Lock()
_cache = {"at": 0.0, "data": None}


def quotes(span, series, ttl):
    """期交所每秒最多打一次就夠了，多開幾個分頁不該多抓幾次。"""
    with _lock:
        if _cache["data"] and time.time() - _cache["at"] < ttl:
            return _cache["data"]
        data = fetch_txo.build(span, series)
        data["hist"] = hist_vol.stats()      # 自己快取到當天結束，這裡直接問
        data["margin"] = margin_ref.values()
        data["walls"] = oi_walls.snapshot()   # 昨日收盤的逐履約價未平倉量
        _cache.update(at=time.time(), data=data)
        return data


def make_handler(args):
    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, code, ctype, body):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path in STATIC:
                name, ctype = STATIC[path]
                with open(os.path.join(HERE, name), "rb") as fh:
                    self._send(200, ctype + "; charset=utf-8", fh.read())
            elif path == "/api/quotes":
                try:
                    body = json.dumps(quotes(args.span, args.series, args.ttl),
                                      ensure_ascii=False).encode("utf-8")
                except Exception as e:
                    self._send(502, "application/json", json.dumps({"error": str(e)}).encode())
                    return
                self._send(200, "application/json; charset=utf-8", body)
            elif path == "/api/paper":
                self._json(200, {"orders": paper.state()})
            elif path == "/api/forecast":
                self._json(200, {"forecasts": forecast.state()})
            elif path in ("/", "/index.html"):
                with open(PAGE, encoding="utf-8") as fh:
                    page = fh.read()
                head = HEAD.replace("__REFRESH__", str(args.refresh))
                self._send(200, "text/html; charset=utf-8", (head + page + TAIL).encode("utf-8"))
            else:
                self._send(404, "text/plain", b"not found")

        def _json(self, code, obj):
            self._send(code, "application/json; charset=utf-8",
                       json.dumps(obj, ensure_ascii=False).encode("utf-8"))

        def do_POST(self):
            path = self.path.split("?")[0]
            n = int(self.headers.get("Content-Length") or 0)
            if n > 500_000:
                self._json(413, {"error": "資料太大"})
                return
            try:
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            except ValueError:
                self._json(400, {"error": "不是合法的 JSON"})
                return
            try:
                if path == "/api/paper":
                    if not body.get("legs") or not body.get("expiry"):
                        self._json(400, {"error": "模擬單缺少腳位或到期日"})
                        return
                    self._json(200, {"id": paper.add(body)})
                elif path == "/api/paper/close":
                    q = quotes(args.span, args.series, args.ttl)
                    self._json(200, paper.close(body.get("id"), q))
                elif path == "/api/paper/delete":
                    self._json(200, paper.delete(body.get("id")))
                elif path == "/api/forecast":
                    self._json(200, forecast.add(body))
                elif path == "/api/forecast/delete":
                    self._json(200, forecast.delete(body.get("id")))
                else:
                    self._send(404, "text/plain", b"not found")
            except Exception as e:
                self._json(500, {"error": str(e)})

        def log_message(self, *a):
            pass
    return H


def desk_running(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/" % port, timeout=2) as r:
            page = r.read(6000).decode("utf-8", "replace")
        return "台指選擇權看台" in page or "台指選擇權戰情台" in page   # 舊名的也認得
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--refresh", type=int, default=10, help="頁面幾秒抓一次")
    ap.add_argument("--ttl", type=float, default=3.0, help="伺服器端快取秒數")
    ap.add_argument("--span", type=float, default=2500)
    ap.add_argument("--series", type=int, default=4)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--path", default="/", help="開哪一頁：/ 看台、/learn 教學")
    args = ap.parse_args()

    # 已經有一份在跑就直接開那一頁，不要另起一個佔走下一個埠
    if desk_running(args.port):
        url = "http://127.0.0.1:%d%s" % (args.port, args.path)
        print("看台已經在跑，直接開啟 %s" % url)
        if not args.no_open:
            webbrowser.open(url)
        return

    # Windows 允許兩支程式綁同一個埠，先來的收封包——舊版沒關乾淨就會拿到過期的頁面
    srv, port = None, args.port
    for p in range(args.port, args.port + 10):
        try:
            srv = ExclusiveServer(("127.0.0.1", p), make_handler(args))
            port = p
            break
        except OSError:
            continue
    if srv is None:
        raise SystemExit("埠 %d~%d 都被占用" % (args.port, args.port + 9))
    if port != args.port:
        print("埠 %d 已被占用，改用 %d" % (args.port, port))
    url = "http://127.0.0.1:%d%s" % (port, args.path)
    print("台指選擇權看台（本機版） %s   每 %d 秒更新，Ctrl+C 結束" % (url, args.refresh))
    # 模擬單：每 5 分鐘估值持倉、到期後抓期交所最後結算價結算
    paper.start_worker(lambda: quotes(args.span, args.series, args.ttl), every=300)
    if not args.no_open:
        threading.Timer(0.6, webbrowser.open, [url]).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n收工")


if __name__ == "__main__":
    main()
