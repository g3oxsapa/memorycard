@echo off
cd /d "%~dp0"
where py >nul 2>nul && (py -3 start.py & goto :end)
where python >nul 2>nul && (python start.py & goto :end)
echo.
echo Python not found. Install it from https://www.python.org/downloads/
echo IMPORTANT: tick "Add python.exe to PATH" during install, then run this file again.
echo.
pause
:end
