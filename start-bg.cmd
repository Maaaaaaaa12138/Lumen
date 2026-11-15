@echo off
rem ===========================================================================
rem  Lumen photo gallery - background start (no console window)
rem  The server keeps running after this window closes.
rem  Stop it with stop.cmd, check it with status.cmd.
rem ===========================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found. Install Node 20+ from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/2] Installing dependencies, this can take a few minutes...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo [x] npm install failed.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo [2/2] Building the web app...
  call npm run build
  if errorlevel 1 (
    echo [x] Build failed.
    pause
    exit /b 1
  )
)

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start-bg.ps1"
if errorlevel 1 (
  echo.
  echo [x] Start failed. Check .cache\server.err.log
  pause
  exit /b 1
)

start "" http://127.0.0.1:8787
echo.
echo   Running in the background. You can close this window.
echo   Logs:  .cache\server.log
echo   Stop:  stop.cmd
rem ping is used instead of timeout: timeout fails when stdin is redirected
ping -n 6 127.0.0.1 >nul
exit /b 0
