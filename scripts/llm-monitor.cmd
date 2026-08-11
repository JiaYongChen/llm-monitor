@echo off
set "SCRIPT_DIR=%~dp0"
chcp 65001 >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-tool.ps1" %*
