$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stage = Join-Path (Split-Path -Parent $root) '_zip_stage'
$zip = Join-Path (Split-Path -Parent $root) 'omni-downloader-vercel.zip'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

robocopy $root $stage /E /XD .git __pycache__ _vercel_zip_staging netlify /XF .env *.zip proxy.py build-zip.ps1 build-netlify-zip.ps1 deploy-netlify.ps1 DEPLOY-NETLIFY.bat serve.py requirements.txt START.bat NETLIFY_DROP.md /NFL /NDL /NJH /NJS | Out-Null

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force

Write-Output "Created: $zip"
Write-Output "Size: $((Get-Item $zip).Length) bytes"
