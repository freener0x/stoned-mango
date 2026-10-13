@echo off
rem stoned-mango: one-time setup on Windows 11 (installs WSL/Ubuntu if needed).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\run-in-wsl.ps1" -Step setup
echo.
echo A log of this run is in the "results" folder next to this file.
pause
