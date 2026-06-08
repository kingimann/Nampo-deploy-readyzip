@echo off
REM ============================================================
REM  NamiApp - one-click launcher (Windows)
REM  Double-click this file, or run  .\start.bat  in PowerShell.
REM  It updates the code, installs anything new, and starts Expo.
REM  Then scan the QR code with the Expo Go app on your phone.
REM ============================================================

cd /d "%~dp0frontend"

echo.
echo === Updating NamiApp (git pull) ===
git pull

echo.
echo === Checking dependencies (Yarn) ===
call corepack enable >nul 2>&1
call yarn install --ignore-scripts

echo.
echo === Starting NamiApp ===
echo Scan the QR code below with the Expo Go app.
echo If your phone cannot connect, close this and run:  yarn expo start --tunnel
echo (Press Ctrl+C to stop the server.)
echo.
call yarn expo start -c

pause
