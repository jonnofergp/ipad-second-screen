@echo off
chcp 65001 >nul
title Autostart toggle

cd /d "%~dp0"

if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\iPad Second Screen.lnk" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" -Remove
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1"
)

echo.
echo Press any key to close.
pause >nul
