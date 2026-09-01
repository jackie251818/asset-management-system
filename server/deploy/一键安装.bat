@echo off
setlocal EnableExtensions
REM ============================================================
REM  固定资产管理系统 - 生产部署包一键安装脚本
REM
REM  流程: 自提权 -> [0] ASCII 路径预检 -> [1/5] 预置 asset-server.exe
REM        -> [2/5] 生成自签证书 -> [3/5] 防火墙放行 80/443
REM        -> [4/5] 安装并启动 AssetServer + AssetNginx 服务
REM        -> [5/5] 健康检查 (HTTP 80 / HTTPS 443)
REM
REM  用法: 双击运行, UAC 弹窗点"是"即可。可重复执行(幂等)。
REM  前提: 本目录必须位于纯英文(ASCII)路径下 (nginx Windows 版限制)。
REM ============================================================

REM ---------- 管理员自提权 ----------
net session >nul 2>&1
if %errorlevel%==0 goto :ADMIN
echo 需要管理员权限, 正在请求提权 (请在 UAC 弹窗中点"是") ...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:ADMIN
cd /d "%~dp0"
set "SCRIPT_DIR=%~dp0"
echo ==============================================
echo   固定资产管理系统 - 生产部署包一键安装
echo   目录: %SCRIPT_DIR%
echo ==============================================

REM ---------- [0] ASCII 路径预检 (nginx 无法读非 ASCII 路径下的配置/证书) ----------
echo(%SCRIPT_DIR%| findstr /r "[^ -~]" >nul
if not errorlevel 1 (
    echo [ERROR] 部署路径包含中文等非 ASCII 字符:
    echo         %SCRIPT_DIR%
    echo         nginx Windows 版无法在非 ASCII 路径下读取配置与证书, 服务将无法启动。
    echo         请将整个 deploy 目录复制到纯英文路径后重试, 例如: C:\asset-server
    pause
    exit /b 1
)

REM ---------- [1/5] 预置 asset-server.exe ----------
echo [1/5] 检查服务端 asset-server.exe ...
if exist "%SCRIPT_DIR%asset-server.exe" (
    echo       已存在, 跳过。
    goto :EXE_DONE
)
if exist "%SCRIPT_DIR%dist\asset-server.exe" (
    copy /y "%SCRIPT_DIR%dist\asset-server.exe" "%SCRIPT_DIR%asset-server.exe" >nul
    echo       已从 dist\ 复制。
    goto :EXE_DONE
)
if exist "%SCRIPT_DIR%..\dist\asset-server.exe" (
    copy /y "%SCRIPT_DIR%..\dist\asset-server.exe" "%SCRIPT_DIR%asset-server.exe" >nul
    echo       已从 ..\dist\ 复制。
    goto :EXE_DONE
)
echo [ERROR] 未找到 asset-server.exe。
echo         请先在 server 目录执行: npm run build:exe
echo         再把 dist\asset-server.exe 放到本目录后重试。
pause
exit /b 1
:EXE_DONE

REM ---------- [2/5] 自签证书 ----------
echo [2/5] 检查证书 cert\server.crt ...
if exist "%SCRIPT_DIR%cert\server.crt" (
    echo       已存在, 跳过生成。
    goto :CERT_DONE
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%make-cert.ps1"
if errorlevel 1 (
    echo [ERROR] 证书生成失败。请先安装 Git for Windows 或 OpenSSL 后重试。
    pause
    exit /b 1
)
:CERT_DONE

REM ---------- [3/5] 防火墙放行 80/443 ----------
echo [3/5] 配置防火墙放行 TCP 80 / 443 ...
netsh advfirewall firewall show rule name="AssetWeb 80" | findstr /c:"AssetWeb 80" >nul
if errorlevel 1 netsh advfirewall firewall add rule name="AssetWeb 80" dir=in action=allow protocol=TCP localport=80 >nul
netsh advfirewall firewall show rule name="AssetWeb 443" | findstr /c:"AssetWeb 443" >nul
if errorlevel 1 netsh advfirewall firewall add rule name="AssetWeb 443" dir=in action=allow protocol=TCP localport=443 >nul
echo       OK

REM ---------- [4/5] 安装并启动服务 ----------
echo [4/5] 安装并启动 AssetServer / AssetNginx 服务 ...
if not exist "%SCRIPT_DIR%nginx\logs" mkdir "%SCRIPT_DIR%nginx\logs"
call "%SCRIPT_DIR%install-service.bat" < nul
if errorlevel 1 (
    echo [ERROR] 服务安装失败, 请检查上方输出。
    pause
    exit /b 1
)

REM ---------- [5/5] 健康检查 ----------
echo [5/5] 健康检查 (等待服务就绪, 最多约 1 分钟) ...
powershell -NoProfile -Command "$f80=0;$f443=0;for($i=0;$i -lt 20 -and $f80 -eq 0;$i++){try{Invoke-RestMethod -Uri 'http://127.0.0.1/api/ping' -TimeoutSec 2|Out-Null;$f80=1}catch{Start-Sleep -Seconds 3}};Add-Type -TypeDefinition 'using System.Net;using System.Security.Cryptography.X509Certificates;public class TACP:ICertificatePolicy{public bool CheckValidationResult(ServicePoint sp,X509Certificate c,WebRequest r,int p){return true;}}' -ErrorAction SilentlyContinue;[System.Net.ServicePointManager]::CertificatePolicy=New-Object TACP;[System.Net.ServicePointManager]::SecurityProtocol=[System.Net.SecurityProtocolType]::Tls12;for($i=0;$i -lt 20 -and $f443 -eq 0;$i++){try{Invoke-RestMethod -Uri 'https://127.0.0.1/api/ping' -TimeoutSec 2|Out-Null;$f443=1}catch{Start-Sleep -Seconds 3}};if($f80){Write-Output 'HTTP80: PASS'}else{Write-Output 'HTTP80: FAIL'};if($f443){Write-Output 'HTTPS443: PASS'}else{Write-Output 'HTTPS443: FAIL'};if($f80 -and $f443){exit 0}else{exit 1}"
if errorlevel 1 (
    echo [WARN] 健康检查未全部通过: 请查看 logs\asset-server.err.log 与 logs\nginx.err.log
) else (
    echo       HTTP 80 与 HTTPS 443 均正常响应。
)

REM ---------- 完成汇总 ----------
echo.
echo ==============================================
echo   安装完成
echo ----------------------------------------------
set "LANIP="
powershell -NoProfile -Command "try{(Get-NetIPAddress -AddressFamily IPv4).Where({$_.IPAddress -notmatch '^(127\.|169\.254\.)'})[0].IPAddress}catch{''}" > "%TEMP%\asset_lanip.txt" 2>nul
set /p LANIP=<"%TEMP%\asset_lanip.txt"
del "%TEMP%\asset_lanip.txt" >nul 2>&1
echo   本机访问   : http://localhost/    https://localhost/
if defined LANIP echo   局域网访问 : http://%LANIP%/    https://%LANIP%/
echo   首次访问 443 时浏览器会提示证书不受信任, 点"继续浏览"即可。
echo   默认账号   : admin / admin123  (登录后请立即修改密码)
echo   服务管理   : nssm status AssetServer    nssm restart AssetServer
echo   运行日志   : logs 目录下 asset-server / nginx 的 .log 与 .err.log
echo   一键卸载   : uninstall-service.bat
echo ==============================================
pause
