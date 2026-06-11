@echo off
cd /d "%~dp0"
echo.
echo  Omni Downloader starting...
echo  Open in browser: http://localhost:8080
echo  Press Ctrl+C to stop.
echo.
python serve.py
pause
