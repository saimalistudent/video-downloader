from http.server import BaseHTTPRequestHandler
import json
import sys
import os
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from lib.proxy import (  # noqa: E402
    acquire_api_slot,
    ensure_api_key,
    extract_query_value,
    normalize_video_url,
    proxy_download,
    release_api_slot,
    slot_stats,
)
from lib.vercel_http import send_json, send_options  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        send_options(self)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        video_url = extract_query_value(parsed.query, 'url')
        self._proxy_and_respond(video_url)

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length) if length else b'{}'
            payload = json.loads(raw.decode('utf-8-sig') or '{}')
            video_url = str(payload.get('url', '')).strip()
            self._proxy_and_respond(video_url)
        except json.JSONDecodeError:
            send_json(self, 400, {'error': 'Invalid JSON body'})
        except Exception as exc:
            send_json(self, 500, {'error': f'Proxy error: {exc}'})

    def _proxy_and_respond(self, video_url):
        video_url = normalize_video_url(video_url)
        if not video_url:
            send_json(self, 400, {
                'error': 'Missing url parameter',
                'message': 'Missing required parameters',
            })
            return

        ok, err = ensure_api_key()
        if not ok:
            send_json(self, 500, err)
            return

        if not acquire_api_slot():
            stats = slot_stats()
            send_json(self, 429, {
                'wait': True,
                'message': 'The website is experiencing high traffic. Please wait — your download will begin shortly.',
                'active': stats['active'],
                'max': stats['max'],
                'retry_after': 2,
            })
            return

        try:
            status, data = proxy_download(video_url)
            send_json(self, status, data)
        finally:
            release_api_slot()
