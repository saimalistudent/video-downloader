param(
  [Parameter(Mandatory = $true)]
  [string]$Url
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot '..\api.config.json'
$url = $Url.Trim().TrimEnd('/')

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$config.backend_url = $url
$config | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding UTF8

Write-Host "backend_url set to: $url"
