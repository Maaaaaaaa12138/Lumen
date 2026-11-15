# Starts the gallery detached (no console window) and waits until it answers.
# Called by start-bg.cmd. ASCII only.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }

function Show-Urls([int]$port) {
  Write-Host ("  local    http://127.0.0.1:{0}" -f $port)
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
  foreach ($ip in $ips) {
    Write-Host ("  lan      http://{0}:{1}" -f $ip.IPAddress, $port)
  }
}

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($existing) {
  Write-Host ("  already running (pid {0})" -f $existing.OwningProcess)
  Show-Urls $port
  exit 0
}

$cache = Join-Path $root '.cache'
New-Item -ItemType Directory -Force -Path $cache | Out-Null

$proc = Start-Process -FilePath 'node' `
  -ArgumentList 'server/index.mjs' `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput (Join-Path $cache 'server.log') `
  -RedirectStandardError (Join-Path $cache 'server.err.log')

$ready = $false
for ($i = 0; $i -lt 100; $i++) {
  Start-Sleep -Milliseconds 300
  if ($proc.HasExited) { break }
  try {
    $res = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f $port) -TimeoutSec 2
    if ($res.ok) { $ready = $true; break }
  } catch {
    # not up yet
  }
}

if (-not $ready) {
  Write-Host "  [x] server did not start. See .cache\server.err.log"
  exit 1
}

Write-Host ("  started  pid {0}" -f $proc.Id)
Show-Urls $port
exit 0
