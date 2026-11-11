@echo off
setlocal
cd /d "%~dp0"
where.exe node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.12 or newer from https://nodejs.org/ then run this file again.
  if "%~1"=="--check-only" exit /b 1
  pause
  exit /b 1
)
node "server.mjs" %*
if errorlevel 1 (
  echo.
  echo Publisher stopped because of an error. No Git commit or push was performed.
  if "%~1"=="--check-only" exit /b 1
  pause
  exit /b 1
)
