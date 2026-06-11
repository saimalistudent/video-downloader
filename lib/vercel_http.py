"""Helpers for Vercel Python serverless handlers."""
import json
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from lib.proxy import cors_headers  # noqa: E402


def apply_cors(handler):
    for key, value in cors_headers().items():
        handler.send_header(key, value)


def send_json(handler, status, data):
    payload = json.dumps(data).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(payload)))
    apply_cors(handler)
    handler.end_headers()
    handler.wfile.write(payload)


def send_options(handler):
    handler.send_response(204)
    apply_cors(handler)
    handler.end_headers()
