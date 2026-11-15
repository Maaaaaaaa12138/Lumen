@echo off
rem Stops the background gallery server listening on the configured port.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port = if ($env:PORT) { [int]$env:PORT } else { 8787 };" ^
  "$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue;" ^
  "if (-not $c) { Write-Host ('  nothing listening on port ' + $port); exit 0 };" ^
  "$ids = $c.OwningProcess | Select-Object -Unique;" ^
  "foreach ($procId in $ids) { try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Host ('  stopped pid ' + $procId) } catch { Write-Host ('  could not stop pid ' + $procId) } }"

ping -n 3 127.0.0.1 >nul
exit /b 0
