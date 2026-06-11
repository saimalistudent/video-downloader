# Netlify Deploy — Choose ONE method

---

## You see "Backend not connected"?

You deployed with **Netlify Drop**. Drop only uploads HTML — no download API.

---

## OPTION A — Netlify Drop + Vercel API (easiest if you already use Drop)

### 1. Deploy API to Vercel
- Upload `omni-downloader-vercel.zip` to https://vercel.com
- Add env var: `RAPIDAPI_KEY` = your RapidAPI key
- Subscribe: https://rapidapi.com/aiovod/api/social-download-all-in-one
- Copy your Vercel URL (e.g. `https://omni-downloader-abc.vercel.app`)

### 2. Connect Netlify to Vercel
- Double-click **`SETUP-NETLIFY-DROP.bat`**
- Paste your Vercel URL
- Re-upload **whole folder** to Netlify Drop

Done — warning gone, downloads work.

---

## OPTION B — Full Netlify deploy (recommended long-term)

1. Double-click **`DEPLOY-NETLIFY.bat`**
2. Log in to Netlify in browser
3. Netlify dashboard → Environment variables → `RAPIDAPI_KEY`
4. Deploys → Trigger deploy

Verify: `https://YOUR-SITE.netlify.app/api/health`

---

## Do NOT
- Use Netlify Drop alone without Option A or B
- Expect downloads to work without `RAPIDAPI_KEY` on Vercel or Netlify
