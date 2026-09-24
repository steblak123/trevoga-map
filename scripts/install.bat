@echo off
rem Installs dependencies, enables autostart and launches the widget.
cd /d "%~dp0.."
call npm install --no-fund --no-audit || goto :error
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1"
wscript "%~dp0start-widget.vbs"
echo Done.
pause
exit /b 0

:error
echo npm install failed. Is Node.js installed?
pause
exit /b 1
