@echo off
REM ============================================================
REM  Asset Management Server - Windows Service Installer (NSSM)
REM
REM  Installs two auto-start services:
REM    AssetServer : asset-server.exe (API + static pages, 127.0.0.1:3456)
REM    AssetNginx  : nginx reverse proxy (80 / 443 -> 127.0.0.1:3456)
REM
REM  Prerequisites (all in this folder):
REM    asset-server.exe   <- built by: cd server && npm run build:exe
REM    nssm.exe           <- https://nssm.cc/download
REM    nginx\nginx.exe    <- https://nginx.org/en/download.html
REM    cert\server.crt    <- built by: powershell -File make-cert.ps1
REM
REM  MUST be run as Administrator.
REM ============================================================
setlocal
set SCRIPT_DIR=%~dp0
REM %~dp0 ends with a backslash: passing "%SCRIPT_DIR%" to nssm makes the
REM trailing \" parse as an escaped quote and corrupts AppDirectory.
set SVC_DIR=%SCRIPT_DIR:~0,-1%
set SVC_NAME=AssetServer
set NGINX_SVC=AssetNginx

net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Please run this script as Administrator.
    pause
    exit /b 1
)

if not exist "%SCRIPT_DIR%asset-server.exe" (
    echo [ERROR] asset-server.exe not found in %SCRIPT_DIR%
    echo         Build it first:  cd server ^&^& npm run build:exe
    pause
    exit /b 1
)

if not exist "%SCRIPT_DIR%nssm.exe" (
    echo [ERROR] nssm.exe not found in %SCRIPT_DIR%
    echo         Download from https://nssm.cc/download and copy win64\nssm.exe here.
    pause
    exit /b 1
)

if not exist "%SCRIPT_DIR%nginx\nginx.exe" (
    echo [ERROR] nginx\nginx.exe not found. Download the Windows zip from
    echo         https://nginx.org/en/download.html and extract so that
    echo         %SCRIPT_DIR%nginx\nginx.exe exists.
    pause
    exit /b 1
)

if not exist "%SCRIPT_DIR%cert\server.crt" (
    echo [ERROR] cert\server.crt not found.
    echo         Generate the self-signed certificate first:
    echo             powershell -ExecutionPolicy Bypass -File make-cert.ps1
    pause
    exit /b 1
)

REM Always deploy our reverse-proxy config (stock nginx\conf\nginx.conf exists
REM in the distribution and must be replaced by ours).
echo [INFO] Deploying nginx.conf into nginx\conf\ ...
copy /y "%SCRIPT_DIR%nginx.conf" "%SCRIPT_DIR%nginx\conf\nginx.conf" >nul

if not exist "%SCRIPT_DIR%logs" mkdir "%SCRIPT_DIR%logs"

echo [1/4] Installing service %SVC_NAME% ...
"%SCRIPT_DIR%nssm.exe" install %SVC_NAME% "%SVC_DIR%\asset-server.exe" >nul 2>&1
"%SCRIPT_DIR%nssm.exe" set %SVC_NAME% AppDirectory "%SVC_DIR%" >nul
"%SCRIPT_DIR%nssm.exe" set %SVC_NAME% AppStdout "%SVC_DIR%\logs\asset-server.log" >nul
"%SCRIPT_DIR%nssm.exe" set %SVC_NAME% AppStderr "%SVC_DIR%\logs\asset-server.err.log" >nul
"%SCRIPT_DIR%nssm.exe" set %SVC_NAME% AppRotateFiles 1 >nul
"%SCRIPT_DIR%nssm.exe" set %SVC_NAME% AppRotateOnline 1 >nul
"%SCRIPT_DIR%nssm.exe" set %SVC_NAME% AppRotateBytes 10485760 >nul
"%SCRIPT_DIR%nssm.exe" set %SVC_NAME% Start SERVICE_AUTO_START >nul

echo [2/4] Starting %SVC_NAME% ...
"%SCRIPT_DIR%nssm.exe" restart %SVC_NAME% >nul
REM ping-wait: `timeout` fails when stdin is redirected (e.g. run from a script)
ping -n 3 127.0.0.1 >nul

echo [3/4] Installing nginx service %NGINX_SVC% ...
"%SCRIPT_DIR%nssm.exe" install %NGINX_SVC% "%SVC_DIR%\nginx\nginx.exe" >nul 2>&1
"%SCRIPT_DIR%nssm.exe" set %NGINX_SVC% AppDirectory "%SVC_DIR%\nginx" >nul
"%SCRIPT_DIR%nssm.exe" set %NGINX_SVC% AppParameters "-p \"%SVC_DIR%\nginx\"" >nul
"%SCRIPT_DIR%nssm.exe" set %NGINX_SVC% AppStdout "%SVC_DIR%\logs\nginx.log" >nul
"%SCRIPT_DIR%nssm.exe" set %NGINX_SVC% AppStderr "%SVC_DIR%\logs\nginx.err.log" >nul
"%SCRIPT_DIR%nssm.exe" set %NGINX_SVC% Start SERVICE_AUTO_START >nul

echo [4/4] Starting %NGINX_SVC% ...
"%SCRIPT_DIR%nssm.exe" restart %NGINX_SVC% >nul
ping -n 3 127.0.0.1 >nul

echo.
echo Done. Access:
echo   HTTP : http://localhost:80
echo   HTTPS: https://localhost:443  (self-signed - browser will warn, accept to continue)
echo   API  : services proxy to 127.0.0.1:3456
echo Status: "%SCRIPT_DIR%nssm.exe" status %SVC_NAME%
echo Logs  : %SCRIPT_DIR%logs\
echo.
echo To open LAN access, allow TCP 80/443 in Windows Firewall.
pause
