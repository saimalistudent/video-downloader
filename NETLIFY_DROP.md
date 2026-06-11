# Netlify Drop — Working Setup (2 steps)

Netlify Drop **cannot** run backend code. Use this hybrid setup:

---

## Step 1 — Deploy API to Vercel (free, 5 minutes)

1. Open **https://vercel.com** → Add New Project
2. Upload **`omni-downloader-vercel.zip`**  
   (at `C:\Users\ARSAM\solardash\omni-downloader-vercel.zip`)
3. **Environment Variables** → add:
   - `RAPIDAPI_KEY` = your RapidAPI key
4. Deploy → copy your live URL, e.g. `https://omni-downloader-abc.vercel.app`

---

## Step 2 — Connect Netlify frontend to Vercel API

1. Open **`api.config.json`** in the project folder
2. Set `backend_url` to your Vercel URL:

```json
"backend_url": "https://omni-downloader-abc.vercel.app"
```

3. Drag the **whole project folder** to Netlify Drop again (or update files on Netlify)

The amber warning will disappear and downloads will work.

---

## Alternative — Full Netlify deploy (no Vercel)

Double-click **`DEPLOY-NETLIFY.bat`** on your PC (requires Node.js).  
This deploys frontend + functions together on Netlify.

---

## RapidAPI

Subscribe to: https://rapidapi.com/aiovod/api/social-download-all-in-one
