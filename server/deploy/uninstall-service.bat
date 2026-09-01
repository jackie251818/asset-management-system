@echo off
REM ============================================================
REM  Asset Management Server - Windows Service Uninstaller (NSSM)
REM  MUST be run as Administrator.
REM ============================================================
setlocal
set SCRIPT_DIR=%~dp0
set SVC_NAME=AssetServer
set NGINX_SVC=AssetNginx

net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Please run this script as Administrator.
    pause
    exit /b 1
)

echo Stopping and removing %NGINX_SVC% ...
"%SCRIPT_DIR%nssm.exe" stop %NGINX_SVC% >nul 2>&1
"%SCRIPT_DIR%nssm.exe" remove %NGINX_SVC% confirm >nul 2>&1

echo Stopping and removing %SVC_NAME% ...
"%SCRIPT_DIR%nssm.exe" stop %SVC_NAME% >nul 2>&1
"%SCRIPT_DIR%nssm.exe" remove %SVC_NAME% confirm >nul 2>&1

echo Done. Data directory (deploy\data\) is kept - delete it manually if needed.
pause
