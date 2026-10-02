"""Independent local warrant desk: python warrants/serve.py [--port 8771]."""
import argparse
import http.server
import json
from pathlib import Path
import threading
import urllib.parse
import urllib.request
import webbrowser
import data

HERE = Path(__file__).resolve().parent
ASSETS = {'/': ('index.html', 'text/html'), '/index.html': ('index.html', 'text/html'),
          '/app.js': ('app.js', 'text/javascript'), '/model.js': ('model.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}

class Handler(http.server.BaseHTTPRequestHandler):
    def send(self, code, content, mime='application/json'):
        raw = json.dumps(content, ensure_ascii=False).encode('utf-8') if mime == 'application/json' else content
        self.send_response(code)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path in ASSETS:
                filename, mime = ASSETS[parsed.path]
                self.send(200, (HERE / filename).read_bytes(), mime)
            elif parsed.path == '/api/catalog':
                number = lambda k, default: max(0, min(100000 if k == 'offset' else 2000, int(params.get(k, [default])[0])))
                self.send(200, data.search(params.get('q', [''])[0][:80], params.get('kind', ['all'])[0],
                          offset=number('offset', 0), min_days=number('minDays', 0),
                          max_days=number('maxDays', 730), market=params.get('market', ['all'])[0]))
            elif parsed.path == '/api/quotes':
                self.send(200, data.quotes(params.get('keys', [''])[0].split('|') if params.get('keys', [''])[0] else []))
            else:
                self.send(404, {'error': '找不到頁面'})
        except ValueError as e:
            self.send(400, {'error': str(e)})
        except Exception as e:
            self.send(502, {'error': '官方資料暫時無法取得，請稍後重試。', 'detail': type(e).__name__})

    def log_message(self, fmt, *args):
        if args and str(args[1] if len(args) > 1 else '') not in ('200',):
            super().log_message(fmt, *args)

class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

def is_warrant_desk(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=2) as r:
            return '權證看台' in r.read(4000).decode('utf-8', 'replace')
    except Exception:
        return False

def main():
    ap = argparse.ArgumentParser(description='權證看台（本機）')
    ap.add_argument('--port', type=int, default=8771)
    ap.add_argument('--no-open', action='store_true')
    args = ap.parse_args()
    srv, port = None, args.port
    for port in range(args.port, args.port + 10):
        try:
            srv = Server(('127.0.0.1', port), Handler)
            break
        except OSError:
            if is_warrant_desk(port):
                url = f'http://127.0.0.1:{port}/'
                print(f'權證看台已經在 {url} 執行，直接開啟。', flush=True)
                if not args.no_open:
                    webbrowser.open(url)
                return
    if srv is None:
        raise SystemExit(f'連接埠 {args.port}～{args.port + 9} 都被占用。')
    if port != args.port:
        print(f'連接埠 {args.port} 被其他程式占用，改用 {port}。', flush=True)
    url = f'http://127.0.0.1:{port}/'
    print(f'權證看台 {url}  Ctrl+C 結束', flush=True)
    if not args.no_open:
        threading.Timer(0.6, webbrowser.open, args=[url]).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()

if __name__ == '__main__':
    main()
