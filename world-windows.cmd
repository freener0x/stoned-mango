@echo off
rem stoned-mango: check the maqam, makam and raga scales on real recordings, and that they leave
rem ordinary music alone (GiantSteps, and optionally your music folder).
set "MUSIC="
echo To include your own music, drag its folder onto this window. Otherwise just press Enter.
set /p "MUSIC=Music folder (optional): "
if defined MUSIC set "MUSIC=%MUSIC:"=%"
if defined MUSIC if "%MUSIC:~-1%"=="\" set "MUSIC=%MUSIC:~0,-1%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\run-in-wsl.ps1" -Step world -MusicDir "%MUSIC%"
echo.
echo A log of this run is in the "results" folder next to this file.
pause
