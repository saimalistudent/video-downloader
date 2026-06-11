$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stage = Join-Path (Split-Path -Parent $root) '_netlify_zip_stage'
$zip = Join-Path (Split-Path -Parent $root) 'omni-downloader-netlify.zip'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

$include = @(
  'index.html','netlify.toml','package.json','robots.txt','sitemap.xml','site.webmanifest',
  'favicon.svg','icon.svg','api.config.json','.env.example','DEPLOY_ENV.txt',
  'NETLIFY_DEPLOY.md','README.md','data','deploy-netlify.ps1','DEPLOY-NETLIFY.bat',
  'SETUP-NETLIFY-DROP.bat','scripts'
)
foreach ($item in $include) {
  $src = Join-Path $root $item
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $stage $item) -Recurse -Force
  }
}
Copy-Item (Join-Path $root 'netlify') (Join-Path $stage 'netlify') -Recurse -Force

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force

Write-Output "Created: $zip"
Write-Output "Size: $((Get-Item $zip).Length) bytes"
