# ============================================================
# 生产服务器 → 本地仓库 同步审计脚本 (每次改动收尾运行)
#
# 用途:
#   1. 拉回生产 /downloads/ 更新 JSON 并归档到 releases/ (含产物哈希校验)
#   2. 全量比对生产 vs 本地仓库文件哈希 (静态前端/服务端源码), 发现漂移给出回灌命令
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File server\deploy\sync-from-prod.ps1
#   powershell -ExecutionPolicy Bypass -File server\deploy\sync-from-prod.ps1 -SkipJson
#
# 原则: 仓库是唯一事实源。生产上任何"热修/直接改动"完成后必须跑本脚本,
#       把漂移文件回灌进仓库, 保证 本地仓库 = 生产。
# ============================================================
param(
    [string]$RemoteHost = 'hmt@192.168.40.247',
    [string]$Password   = 'hmt666688',
    [switch]$SkipJson
)

$ErrorActionPreference = 'Continue'
$Plink = "D:\Program Files\PuTTY\plink.exe"
$Pscp  = "D:\Program Files\PuTTY\pscp.exe"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # server/deploy → 项目根
$Releases = Join-Path $RepoRoot 'releases'

# 已知预期差异白名单 (以本地为准, 不算漂移; 生产侧为旧值/构建残留)
# 新增预期差异时在此登记: 文件相对路径 → 原因
$KnownDiff = @{
    'build-info.json'  = '构建时生成的构建信息, 本地随每次构建更新, 生产为部署时快照 (本地为准)'
    'server/backup.js' = '仅注释路径差异: 本地为 docs/ 目录迁移后的正确路径 (本地为准)'
}

function Green($m) { Write-Host "  [OK]  $m" -ForegroundColor Green }
function Red($m)   { Write-Host "  [DRIFT] $m" -ForegroundColor Red }
function Cyan($m)  { Write-Host $m -ForegroundColor Cyan }

Write-Host "==== 1. 获取生产文件哈希 ===="
$remoteCmd = 'cd /opt/asset-server && sha256sum ' +
    'index.html login.html styles.css asset_label_print.html final_chart_fix.js build-info.json ' +
    'js/*.js server/src/*.js server/src/routes/*.js server/package.json server/backup.js server/reset-admin.js ' +
    'downloads/apk-update.json downloads/client-update.json ' +
    'downloads/asset-mgmt-rn-debug.apk downloads/asset-mgmt-client.exe 2>/dev/null'
$remoteOut = & $Plink -ssh -batch -pw $Password $RemoteHost $remoteCmd
$remoteMap = @{}
foreach ($line in $remoteOut) {
    if ($line -match '^([0-9a-f]{64})\s+(.+)$') { $remoteMap[$Matches[2]] = $Matches[1] }
}
if ($remoteMap.Count -eq 0) { Red '无法获取生产哈希 (网络/凭据?)'; exit 1 }
Green "生产侧共 $($remoteMap.Count) 个文件"

Write-Host "`n==== 2. 仓库 vs 生产 哈希比对 ===="
$drift = @()
foreach ($rel in $remoteMap.Keys) {
    if ($rel -like 'downloads/*') { continue }
    $local = Join-Path $RepoRoot ($rel -replace '/', '\')
    if (-not (Test-Path $local)) {
        Red "$rel : 生产有, 仓库无 → 回灌: pscp `"${RemoteHost}:/opt/asset-server/$rel`" `"<仓库根>\$($rel -replace '/','\')`""
        $drift += $rel
        continue
    }
    $lh = (Get-FileHash $local -Algorithm SHA256).Hash.ToLower()
    if ($lh -eq $remoteMap[$rel]) { Green $rel }
    elseif ($KnownDiff.ContainsKey($rel)) { Write-Host "  [KNOWN] $rel — $($KnownDiff[$rel])" -ForegroundColor Yellow }
    else {
        Red "$rel : 不一致 (生产较新或仓库较新, 人工确认后回灌/上传)"
        $drift += $rel
    }
}

Write-Host "`n==== 3. 生产 /downloads/ 现状 ===="
foreach ($k in @('downloads/apk-update.json','downloads/client-update.json','downloads/asset-mgmt-rn-debug.apk','downloads/asset-mgmt-client.exe')) {
    if ($remoteMap.ContainsKey($k)) { Green "$k  $($remoteMap[$k].Substring(0,12))..." }
    else { Red "$k 不存在于生产!" }
}

if (-not $SkipJson) {
    Write-Host "`n==== 4. 更新 JSON 归档到 releases/ ===="
    $tmp = Join-Path $env:TEMP 'sync-from-prod'
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null

    # --- App (apk-update.json) ---
    & $Pscp -batch -pw $Password "${RemoteHost}:/opt/asset-server/downloads/apk-update.json" "$tmp\apk-update.json" 2>&1 | Out-Null
    $apkJson = Get-Content "$tmp\apk-update.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    $appDir = Join-Path $Releases ("app\{0}-vc{1}" -f $apkJson.versionName, $apkJson.versionCode)
    New-Item -ItemType Directory -Force -Path $appDir | Out-Null
    Copy-Item "$tmp\apk-update.json" (Join-Path $appDir 'apk-update.json') -Force
    Green "apk-update.json → $appDir (versionCode=$($apkJson.versionCode) versionName=$($apkJson.versionName))"
    $archivedApk = Join-Path $appDir 'asset-mgmt-rn-debug.apk'
    if (-not (Test-Path $archivedApk)) {
        # 尝试从 RN 构建产物自动归档 (哈希匹配才拷)
        $buildApk = Join-Path $RepoRoot 'mobile-app-rn\android\app\build\outputs\apk\debug\app-debug.apk'
        if ((Test-Path $buildApk) -and ((Get-FileHash $buildApk -Algorithm SHA256).Hash.ToLower() -eq $apkJson.sha256)) {
            Copy-Item $buildApk $archivedApk
            Green "已从构建产物归档 APK (哈希匹配 $((Get-FileHash $archivedApk).Hash.ToLower().Substring(0,12))...)"
        } else {
            Red "归档缺 APK 且构建产物哈希不匹配/不存在 → 手动归档字节与生产一致的 APK!"
        }
    } elseif ((Get-FileHash $archivedApk -Algorithm SHA256).Hash.ToLower() -ne $apkJson.sha256) {
        Red "已归档 APK 与生产 JSON sha256 不一致 → 用生产实际文件重新归档!"
    } else { Green "归档 APK 哈希与生产 JSON 一致" }

    # --- EXE (client-update.json) ---
    & $Pscp -batch -pw $Password "${RemoteHost}:/opt/asset-server/downloads/client-update.json" "$tmp\client-update.json" 2>&1 | Out-Null
    $exeJson = Get-Content "$tmp\client-update.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    $exeDir = Join-Path $Releases ("exe\{0}" -f $exeJson.version)
    New-Item -ItemType Directory -Force -Path $exeDir | Out-Null
    Copy-Item "$tmp\client-update.json" (Join-Path $exeDir 'client-update.json') -Force
    Green "client-update.json → $exeDir (version=$($exeJson.version))"
    $archivedExe = Join-Path $exeDir 'asset-mgmt-client.exe'
    if (-not (Test-Path $archivedExe)) {
        # 尝试从 dist_build_* 自动归档
        $found = $false
        Get-ChildItem (Join-Path $RepoRoot 'dist_build_*') -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
            if (-not $found -and (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower() -eq $exeJson.sha256) {
                Copy-Item $_.FullName $archivedExe; $found = $true
                Green "已从 $($_.Directory.Name) 归档 EXE (哈希匹配)"
            }
        }
        if (-not $found) { Red "归档缺 EXE 且 dist_build_* 无哈希匹配产物 → 手动归档!" }
    } elseif ((Get-FileHash $archivedExe -Algorithm SHA256).Hash.ToLower() -ne $exeJson.sha256) {
        Red "已归档 EXE 与生产 JSON sha256 不一致 → 重新归档!"
    } else { Green "归档 EXE 哈希与生产 JSON 一致" }
}

Write-Host "`n==== 结论 ===="
if ($drift.Count -eq 0) { Green "仓库与生产一致, 无需回灌" }
else {
    Red "共 $($drift.Count) 个文件存在漂移, 处理顺序: 人工确认哪边为准 → 回灌进仓库 → git 提交"
    $drift | ForEach-Object { Write-Host "  - $_" }
}
Write-Host "`n[AI 交接] 每次改动收尾(热上传/发版/服务器直接修改)后必须运行本脚本; 归档与台账规则见 releases/README.md 与 docs/发布同步规范.md"
