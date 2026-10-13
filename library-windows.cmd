@echo off
rem stoned-mango: compare the app with the key tags in your music library. Nothing is uploaded.
set "MUSIC="
echo Drag your music folder onto this window, then press Enter.
set /p "MUSIC=Music folder: "
if not defined MUSIC goto none
set "MUSIC=%MUSIC:"=%"
rem A trailing backslash would escape the closing quote below; run-in-wsl.ps1 copes with "D:".
if "%MUSIC:~-1%"=="\" set "MUSIC=%MUSIC:~0,-1%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\run-in-wsl.ps1" -Step library -MusicDir "%MUSIC%"
echo.
echo A log of this run is in the "results" folder next to this file.
pause
exit /b
:none
echo No folder given.
pause
