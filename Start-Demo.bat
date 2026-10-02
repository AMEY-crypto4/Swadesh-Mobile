@echo off
title Swadesh CC - server (keep this window open)
cd /d "%~dp0"
echo.
echo  Stopping any previous copy...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-demo.ps1"
if not exist "web\dist\index.html" call npm run build -w web
if not defined NO_BROWSERS start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-when-ready.ps1"
echo.
echo  Starting - about 40 seconds (loading the data). Chrome and Edge open by themselves when it is ready.
echo  Main link: http://localhost:4000      Keep this window open during the meeting.
echo.
call npm run dev -w server
pause
