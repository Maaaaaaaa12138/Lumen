@echo off
rem ===========================================================================
rem  Lumen photo gallery - foreground start
rem  Keeps a console window; close it or press Ctrl+C to stop the server.
rem  For a windowless background start use start-bg.cmd instead.
rem  (This file is pure ASCII on purpose: cmd.exe parses .bat in the OEM code
rem   page, so non-ASCII text would show up as garbage on a GBK console.)
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

set OPEN_BROWSER=1
echo.
echo   Starting the gallery. The console stays open; Ctrl+C stops it.
echo   The browser opens automatically; LAN addresses are printed below.
echo.
node server/index.mjs

echo.
echo   Server stopped.
pause
