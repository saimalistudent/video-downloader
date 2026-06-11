@echo off
title Omni Downloader - Netlify Drop Setup
cd /d "%~dp0"
echo.
echo ============================================================
echo   Netlify Drop Setup (frontend on Netlify + API on Vercel)
echo ============================================================
echo.
echo STEP 1: Deploy omni-downloader-vercel.zip to Vercel
echo         Add RAPIDAPI_KEY in Vercel env vars
echo.
echo STEP 2: Paste your Vercel site URL below (no trailing slash)
echo         Example: https://omni-downloader-abc.vercel.app
echo.
set /p VERCEL_URL="Vercel URL: "
if "%VERCEL_URL%"=="" (
  echo ERROR: URL required.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\set-backend-url.ps1" -Url "%VERCEL_URL%"
echo.
echo Done! backend_url saved in api.config.json
echo.
echo STEP 3: Re-upload this ENTIRE folder to Netlify Drop
echo         The yellow warning will disappear and downloads will work.
echo.
pause
