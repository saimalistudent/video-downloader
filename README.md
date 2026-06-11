# Omni Downloader

Free all-in-one video downloader for **TikTok** (no watermark), **Instagram Reels**, **Facebook**, and **YouTube**. Download HD **MP4** or **MP3** in your browser.

## Deploy on Vercel

1. Fork or import this repo on [Vercel](https://vercel.com)
2. Add environment variable: `RAPIDAPI_KEY` = your RapidAPI key
3. Optional: `MAX_API_SLOTS=4`
4. Deploy

See [VERCEL_DEPLOY.md](./VERCEL_DEPLOY.md) for full instructions.

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
