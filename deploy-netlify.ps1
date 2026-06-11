# Deploy Omni Downloader to Netlify WITH serverless functions.
# Netlify Drop (drag-and-drop) does NOT deploy functions — use this script.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  Omni Downloader — Netlify CLI Deploy' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'This deploys:' -ForegroundColor Gray
Write-Host '  - index.html (frontend)' -ForegroundColor Gray
Write-Host '  - netlify/functions/* (download API)' -ForegroundColor Gray
Write-Host ''

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  Write-Host 'ERROR: Node.js not found. Install from https://nodejs.org' -ForegroundColor Red
  exit 1
}

Write-Host 'Running API test first...' -ForegroundColor Yellow
node scripts/test-api.js
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'WARNING: API test failed. Fix RAPIDAPI_KEY in .env before deploy.' -ForegroundColor Yellow
  Write-Host 'Subscribe: https://rapidapi.com/aiovod/api/social-download-all-in-one' -ForegroundColor Yellow
  $cont = Read-Host 'Continue deploy anyway? (y/N)'
  if ($cont -ne 'y' -and $cont -ne 'Y') { exit 1 }
}

Write-Host ''
Write-Host 'Deploying to Netlify...' -ForegroundColor Green
Write-Host 'First time: browser will open for Netlify login.' -ForegroundColor Yellow
Write-Host 'After deploy: set RAPIDAPI_KEY in Netlify dashboard and Redeploy.' -ForegroundColor Yellow
Write-Host ''

npx --yes netlify-cli deploy --prod --dir . --functions netlify/functions

Write-Host ''
Write-Host 'Done! Next steps:' -ForegroundColor Green
Write-Host '  1. Netlify dashboard -> Environment variables -> RAPIDAPI_KEY' -ForegroundColor White
Write-Host '  2. Deploys -> Trigger deploy' -ForegroundColor White
Write-Host '  3. Test: https://YOUR-SITE.netlify.app/api/health' -ForegroundColor White
