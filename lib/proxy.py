"""Shared RapidAPI proxy logic for local serve.py and Vercel serverless."""
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'api.config.json')

with open(CONFIG_PATH, encoding='utf-8') as config_file:
    API_CONFIG = json.load(config_file)

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

MAX_CONCURRENT = int(os.environ.get('MAX_API_SLOTS', API_CONFIG.get('max_concurrent_requests', 4)))
_slot_lock = threading.Lock()
_active_slots = 0
_api_semaphore = threading.Semaphore(MAX_CONCURRENT)


def cors_headers():
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    }


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


def ensure_api_key():
    if not RAPIDAPI_KEY:
        return False, {
            'error': 'RAPIDAPI_KEY is not configured',
            'message': 'Set RAPIDAPI_KEY in Vercel Environment Variables.',
        }
    return True, None


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


def normalize_video_url(video_url):
    video_url = str(video_url or '').strip()
    if not video_url:
        return ''
    if not video_url.startswith('http'):
        video_url = 'https://' + video_url
    return video_url
