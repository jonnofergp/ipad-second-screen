@echo off
chcp 65001 >nul
title iPad Second Screen

cd /d "%~dp0server"

for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get-ip.ps1"`) do set LANIP=%%i

netstat -ano | findstr ":8443" | findstr LISTENING >nul 2>&1
if %errorlevel%==0 (
  echo.
  echo   Server is ALREADY running.
  echo.
  echo   Open this on the iPad:  https://%LANIP%:8443
  echo.
  pause
  exit /b
)

if not exist "node_modules\ws" (
  echo Installing dependencies...
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
  echo.
)

echo Starting server...
echo.
node server.js

echo.
echo Server exited. Press any key to close.
pause >nul
