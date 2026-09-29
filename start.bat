@echo off
rem Start the background AI engine (keeps trading after you close the browser) and open the dashboard.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0background.ps1" open
