# Restore Multi-API Setup

**Production uses locked All-in-One API** — see `api.config.json`.

Current mode: `social-download-all-in-one.p.rapidapi.com` → `POST /v1/social/autolink`

## Current All-in-One (ACTIVE — do not change)

| Host | Method | Endpoint | Body |
|------|--------|----------|------|
| `social-download-all-in-one.p.rapidapi.com` | POST | `/v1/social/autolink` | `{"url":"VIDEO_URL"}` |

## Previous APIs (before All-in-One)

| Platform | Host | Endpoint | Param |
|----------|------|----------|-------|
| TikTok | `tiktok-video-downloader-api.p.rapidapi.com` | `/media` | `videoUrl` |
| Instagram | `instagram-reels-downloader-api.p.rapidapi.com` | `/download` | `url` |
| Facebook/YouTube | `instagram-reels-downloader-api.p.rapidapi.com` | `/download` | `url` |

**API Key:** `9f214da627msh1ca7d87de51d29ep148f14jsnc06557bf84fa`

## Git restore

If this folder is in git:

```bash
git checkout HEAD -- serve.py index.html
```

## Manual restore

Ask Cursor: *"Restore multi-API setup from RESTORE.md"*
