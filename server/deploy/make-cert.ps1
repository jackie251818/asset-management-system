# ============================================================
#  Self-signed certificate generator for asset-server nginx HTTPS
#
#  Usage:  powershell -ExecutionPolicy Bypass -File make-cert.ps1 [-CommonName asset-server.local] [-Days 3650]
#  Output: deploy/cert/server.crt + deploy/cert/server.key
#
#  Requires openssl (bundled with Git for Windows).
#  The SAN includes localhost, hostname and all LAN IPv4 addresses,
#  so browsers only show an untrusted-warning (self-signed), never a name-mismatch.
# ============================================================
param(
    [string]$CommonName = "asset-server.local",
    [int]$Days = 3650
)

$ErrorActionPreference = "Stop"
$deploy = Split-Path -Parent $MyInvocation.MyCommand.Path
$certDir = Join-Path $deploy "cert"
New-Item -ItemType Directory -Path $certDir -Force | Out-Null

# Locate openssl: PATH first, then common Git for Windows locations
$openssl = $null
foreach ($candidate in @(
    "openssl",
    "C:\Program Files\Git\usr\bin\openssl.exe",
    "C:\Program Files\Git\mingw64\bin\openssl.exe",
    "C:\Program Files (x86)\Git\usr\bin\openssl.exe"
)) {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) { $openssl = $candidate; break }
}
if (-not $openssl) {
    Write-Error "openssl not found. Install Git for Windows (https://git-scm.com) or OpenSSL, then retry."
    exit 1
}

# Build SAN: localhost + hostname + LAN IPv4 addresses
$hostname = [System.Net.Dns]::GetHostName()
$ips = @()
try {
    $ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
        Select-Object -ExpandProperty IPAddress)
} catch { }
$san = "DNS:localhost,DNS:$hostname,IP:127.0.0.1"
foreach ($ip in $ips) { if ($ip -and $san -notmatch [regex]::Escape("IP:$ip")) { $san += ",IP:$ip" } }

$keyOut = Join-Path $certDir "server.key"
$crtOut = Join-Path $certDir "server.crt"

# MSYS2 openssl mangles leading '/CN=' into a path; use '//CN=' workaround
$subj = "//CN=$CommonName"

# openssl 将密钥生成进度写到 stderr; PowerShell 5.1 在 EAP=Stop 下会把 stderr 重定向
# 升级为 NativeCommandError 终止脚本, 故此处临时降级为 Continue, 以产物文件是否存在为准
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days $Days `
    -keyout $keyOut -out $crtOut -subj $subj -addext "subjectAltName=$san" 2>$null | Out-Null
$ErrorActionPreference = $prevEAP

if (-not (Test-Path $crtOut) -or -not (Test-Path $keyOut)) {
    Write-Error "Certificate generation failed."
    exit 1
}

Write-Output "CERT OK"
Write-Output "  cert: $crtOut"
Write-Output "  key : $keyOut"
Write-Output "  SAN : $san"
Write-Output "  valid: $Days days (CN=$CommonName)"
