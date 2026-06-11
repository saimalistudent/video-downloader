# Omni Downloader

Free all-in-one video downloader for **TikTok** (no watermark), **Instagram Reels**, **Facebook**, and **YouTube**. Download HD **MP4** or **MP3** in your browser.

## Deploy on Vercel or Netlify

**Your RapidAPI key is never exposed to the browser.** It lives only in serverless functions (`api/*.js`) via `process.env.RAPIDAPI_KEY`.

### Vercel
1. Import this repo on [Vercel](https://vercel.com)
2. Environment variable: `RAPIDAPI_KEY` = your RapidAPI key
3. Deploy — functions auto-map to `/api/download`, `/api/stream`, etc.

### Netlify
1. Import repo on [Netlify](https://netlify.com)
2. Build command: *(leave empty)* | Publish directory: `.`
3. Environment variable: `RAPIDAPI_KEY`
4. `netlify.toml` redirects `/api/*` to serverless functions

See [VERCEL_DEPLOY.md](./VERCEL_DEPLOY.md) for details.

## Local development

```bash
python serve.py
```

Open http://localhost:8080

Set `RAPIDAPI_KEY` in your environment before running locally.

## SEO

After connecting your domain, update `omnidownloader.com` in `index.html`, `robots.txt`, and `sitemap.xml` if needed. Upload `og-image.jpg` (1200×630) for social previews.

## License

Use at your own responsibility. Only download content you have rights to use.
