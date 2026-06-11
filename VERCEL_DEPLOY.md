# Omni Downloader — Vercel Deploy Guide

## Quick deploy (zip upload)

1. Unzip `omni-downloader-vercel.zip`
2. Go to [vercel.com](https://vercel.com) → **Add New Project**
3. **Import** folder or drag-and-drop the unzipped files
4. **Environment Variables** (required):
   - `RAPIDAPI_KEY` = your RapidAPI key
   - `MAX_API_SLOTS` = `4` (optional)
5. Click **Deploy** (Node.js — no Python, no build step)

**Note:** Do not include `serve.py` or `requirements.txt` — backend is `api/*.js` only.

## After domain (Hostinger)

1. In Vercel → **Settings → Domains** → add your domain
2. In Hostinger DNS, point to Vercel (A/CNAME as shown by Vercel)
3. Find-replace `omnidownloader.com` in `index.html`, `sitemap.xml`, `robots.txt` if your domain differs
4. Upload `og-image.jpg` (1200×630) to project root
5. Submit sitemap in Google Search Console

## Local test (optional)

```bash
npm i -g vercel
vercel dev
```

## Files included

| Path | Purpose |
|------|---------|
| `index.html` | Frontend |
| `api/download.js` | Secure POST proxy — RapidAPI key in env only |
| `api/stream.js` | Video/audio file stream proxy |
| `lib/api-proxy.js` | Shared server-side RapidAPI logic |
| `netlify.toml` + `netlify/functions/` | Netlify deploy support |
| `vercel.json` | Vercel config |
| `robots.txt`, `sitemap.xml` | SEO |

## Note

Large video streams may hit Vercel serverless size/time limits on the free plan. For heavy traffic, consider VPS + `serve.py` instead.
