@echo off
rem Shows whether the gallery server is running and which URLs it serves.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port = if ($env:PORT) { [int]$env:PORT } else { 8787 };" ^
  "$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "if (-not $c) { Write-Host '  not running (start with start-bg.cmd)'; exit 0 };" ^
  "Write-Host ('  running  pid ' + $c.OwningProcess);" ^
  "Write-Host ('  local    http://127.0.0.1:' + $port);" ^
  "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { Write-Host ('  lan      http://' + $_.IPAddress + ':' + $port) };" ^
  "try { $h = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/health') -TimeoutSec 3; Write-Host ('  status   ' + $h.phase + ', ' + $h.records + ' albums') } catch { Write-Host '  status   not responding' }"

ping -n 3 127.0.0.1 >nul
exit /b 0
