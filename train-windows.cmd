@echo off
rem stoned-mango: train the key model on this PC's NVIDIA GPU (run setup-windows.cmd first).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\run-in-wsl.ps1" -Step train
echo.
echo A log of this run is in the "results" folder next to this file.
pause
