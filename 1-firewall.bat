@echo off
chcp 65001 >nul
title Allow firewall for iPad Second Screen

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0allow-firewall.ps1"

echo.
echo Press any key to close.
pause >nul
