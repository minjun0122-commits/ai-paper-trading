@echo off
rem Stop the background AI engine and local server.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0background.ps1" stop
pause
