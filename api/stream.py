from http.server import BaseHTTPRequestHandler
import sys
import os
import urllib.error
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from lib.proxy import extract_query_value, normalize_video_url, stream_media  # noqa: E402
from lib.vercel_http import apply_cors, send_json, send_options  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        send_options(self)

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            media_url = extract_query_value(parsed.query, 'url', stop_before='name').strip()
            filename = extract_query_value(parsed.query, 'name').strip() or 'video.mp4'
            media_url = normalize_video_url(media_url)

            if not media_url:
                send_json(self, 400, {'error': 'Missing url parameter'})
                return

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
                apply_cors(self)
                self.end_headers()

                while True:
                    chunk = upstream.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except urllib.error.HTTPError as exc:
            send_json(self, exc.code, {'error': f'Upstream HTTP {exc.code}'})
        except Exception as exc:
            send_json(self, 502, {'error': f'Stream error: {exc}'})
