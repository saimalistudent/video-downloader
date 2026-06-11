"""Static server + locked All-in-One RapidAPI proxy."""
import http.server
import json
import os
import socketserver
import time
import urllib.error
import urllib.parse
import urllib.request

import threading

PORT = 8080
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'api.config.json')

with open(CONFIG_PATH, encoding='utf-8') as config_file:
    API_CONFIG = json.load(config_file)

# One API key — all platforms (TikTok, Instagram, Facebook, YouTube)
RAPIDAPI_KEY = os.environ.get('RAPIDAPI_KEY', '')

ALL_IN_ONE_API = {
    'host': API_CONFIG['host'],
    'path': API_CONFIG['path'],
    'body_key': API_CONFIG.get('body_key', 'url'),
}

RAPIDAPI_HEADERS_BASE = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ),
    'Accept': 'application/json',
    'Content-Type': 'application/json',
}

os.chdir(os.path.dirname(os.path.abspath(__file__)))

MAX_CONCURRENT = int(os.environ.get('MAX_API_SLOTS', API_CONFIG.get('max_concurrent_requests', 4)))
_slot_lock = threading.Lock()
_active_slots = 0
_api_semaphore = threading.Semaphore(MAX_CONCURRENT)


def slot_stats():
    with _slot_lock:
        return {'active': _active_slots, 'max': MAX_CONCURRENT, 'available': max(0, MAX_CONCURRENT - _active_slots)}


def acquire_api_slot():
    global _active_slots
    acquired = _api_semaphore.acquire(blocking=False)
    if acquired:
        with _slot_lock:
            _active_slots += 1
    return acquired


def release_api_slot():
    global _active_slots
    with _slot_lock:
        _active_slots = max(0, _active_slots - 1)
    _api_semaphore.release()


def rapidapi_download(video_url):
    api_url = f"https://{ALL_IN_ONE_API['host']}{ALL_IN_ONE_API['path']}"
    body = json.dumps({ALL_IN_ONE_API['body_key']: video_url}).encode('utf-8')
    headers = {
        **RAPIDAPI_HEADERS_BASE,
        'x-rapidapi-host': ALL_IN_ONE_API['host'],
        'x-rapidapi-key': RAPIDAPI_KEY,
    }
    req = urllib.request.Request(api_url, data=body, method='POST', headers=headers)
    with urllib.request.urlopen(req, timeout=90) as resp:
        raw = resp.read().decode('utf-8', errors='replace')
        if not raw.strip():
            return resp.status, {}
        try:
            return resp.status, json.loads(raw)
        except json.JSONDecodeError:
            return 502, {'error': 'RapidAPI returned non-JSON response', 'raw': raw[:200]}


def extract_query_value(query, key, stop_before=None):
    """Extract a query value that may contain & characters (e.g. nested video URLs)."""
    prefix = key + '='
    if prefix not in query:
        return ''
    start = query.index(prefix) + len(prefix)
    end = len(query)
    if stop_before:
        marker = '&' + stop_before + '='
        idx = query.find(marker, start)
        if idx != -1:
            end = idx
    return urllib.parse.unquote(query[start:end], errors='replace')


def proxy_download(video_url, retries=3):
    last_status, last_data = 502, {'error': 'Download failed'}
    for attempt in range(retries):
        try:
            status, data = rapidapi_download(video_url)
            last_status, last_data = status, data
            if status == 200 and data.get('error') is not True:
                return status, data
            msg = str(data.get('message') or data.get('error') or '').lower()
            if status not in (502, 504, 429) and 'timeout' not in msg and 'try again' not in msg:
                return status, data
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read().decode('utf-8', errors='replace'))
            except json.JSONDecodeError:
                detail = {'error': exc.reason or 'HTTP error'}
            if exc.code == 403:
                detail.setdefault(
                    'error',
                    'RapidAPI 403 — check API key and subscription on rapidapi.com.',
                )
            last_status, last_data = exc.code, detail
            msg = str(detail.get('message') or detail.get('error') or '').lower()
            if exc.code not in (502, 504, 429) and 'timeout' not in msg:
                return exc.code, detail
        except urllib.error.URLError as exc:
            last_status, last_data = 502, {'error': f'Network error: {exc.reason}'}
        if attempt < retries - 1:
            time.sleep(1.5 * (attempt + 1))
    return last_status, last_data


def referer_for_url(media_url):
    host = urllib.parse.urlparse(media_url).netloc.lower()
    if 'tiktok' in host:
        return 'https://www.tiktok.com/'
    if 'instagram' in host or 'cdninstagram' in host:
        return 'https://www.instagram.com/'
    if 'facebook' in host or 'fbcdn' in host:
        return 'https://www.facebook.com/'
    if 'googlevideo' in host or 'youtube' in host:
        return 'https://www.youtube.com/'
    return 'https://www.google.com/'


def stream_media(media_url):
    headers = {
        **RAPIDAPI_HEADERS_BASE,
        'Referer': referer_for_url(media_url),
        'Accept': '*/*',
    }
    req = urllib.request.Request(media_url, headers=headers)
    return urllib.request.urlopen(req, timeout=120)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api/health'):
            self.send_json(200, {
                'ok': True,
                'proxy': True,
                'locked': API_CONFIG.get('locked', True),
                'mode': API_CONFIG.get('provider', 'social-download-all-in-one'),
                'platforms': API_CONFIG.get('platforms', []),
                'queue': slot_stats(),
            })
            return
        if self.path.startswith('/api/queue'):
            self.send_json(200, slot_stats())
            return
        if self.path.startswith('/api/stream'):
            self.handle_stream()
            return
        if self.path.startswith('/api/download'):
            self.handle_proxy_get()
            return
        super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/download'):
            self.handle_proxy_post()
            return
        self.send_error(404)

    def handle_proxy_post(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length) if length else b'{}'
            payload = json.loads(raw.decode('utf-8-sig') or {})
            video_url = str(payload.get('url', '')).strip()
            self._proxy_and_respond(video_url)
        except json.JSONDecodeError:
            self.send_json(400, {'error': 'Invalid JSON body'})
        except Exception as exc:
            self.send_json(500, {'error': f'Proxy error: {exc}'})

    def handle_proxy_get(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            video_url = extract_query_value(parsed.query, 'url')
            self._proxy_and_respond(video_url)
        except Exception as exc:
            self.send_json(500, {'error': f'Proxy error: {exc}'})

    def _proxy_and_respond(self, video_url):
        if not video_url:
            self.send_json(400, {
                'error': 'Missing url parameter',
                'message': 'Missing required parameters',
            })
            return
        if not video_url.startswith('http'):
            video_url = 'https://' + video_url

        if not acquire_api_slot():
            stats = slot_stats()
            self.send_json(429, {
                'wait': True,
                'message': 'The website is experiencing high traffic. Please wait — your download will begin shortly.',
                'active': stats['active'],
                'max': stats['max'],
                'retry_after': 2,
            })
            return

        try:
            status, data = proxy_download(video_url)
            self.send_json(status, data)
        finally:
            release_api_slot()

    def handle_stream(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            media_url = extract_query_value(parsed.query, 'url', stop_before='name').strip()
            filename = extract_query_value(parsed.query, 'name').strip() or 'video.mp4'

            if not media_url:
                self.send_json(400, {'error': 'Missing url parameter'})
                return
            if not media_url.startswith('http'):
                media_url = 'https://' + media_url

            with stream_media(media_url) as upstream:
                content_type = upstream.headers.get('Content-Type', 'application/octet-stream')
                content_length = upstream.headers.get('Content-Length')

                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header(
                    'Content-Disposition',
                    f'attachment; filename="{filename.replace(chr(34), "")}"',
                )
                if content_length:
                    self.send_header('Content-Length', content_length)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()

                while True:
                    chunk = upstream.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except urllib.error.HTTPError as exc:
            self.send_json(exc.code, {'error': f'Upstream HTTP {exc.code}'})
        except Exception as exc:
            self.send_json(502, {'error': f'Stream error: {exc}'})

    def send_json(self, status, data):
        payload = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        print(f'[{self.address_string()}] {format % args}')


if __name__ == '__main__':
    with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
        print(f'Omni Downloader:  http://127.0.0.1:{PORT}/')
        print(f'All-in-One API:  {ALL_IN_ONE_API["host"]}{ALL_IN_ONE_API["path"]}')
        print(f'Concurrent slots: {MAX_CONCURRENT}')
        httpd.serve_forever()
