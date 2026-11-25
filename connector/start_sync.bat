@echo off
rem Runs the sync in this window (to watch it). Close the window to stop it.
cd /d "%~dp0"
python pull_machine.py
pause
