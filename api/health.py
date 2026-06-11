from http.server import BaseHTTPRequestHandler
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from lib.proxy import API_CONFIG, slot_stats  # noqa: E402
from lib.vercel_http import send_json, send_options  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        send_options(self)

    def do_GET(self):
        send_json(self, 200, {
            'ok': True,
            'proxy': True,
            'locked': API_CONFIG.get('locked', True),
            'mode': API_CONFIG.get('provider', 'social-download-all-in-one'),
            'platforms': API_CONFIG.get('platforms', []),
            'queue': slot_stats(),
        })
