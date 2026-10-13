@echo off
rem stoned-mango: fit the engine fusion and "No clear key" floor on this PC (run train-windows.cmd first).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\run-in-wsl.ps1" -Step calibrate
echo.
echo A log of this run is in the "results" folder next to this file.
pause
