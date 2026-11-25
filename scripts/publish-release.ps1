<#
.SYNOPSIS
  发布 dsh-mobile release APK（complete + standard 两通道）：构建（可选）→
  校验版本/签名 → 计算 sha256 → 同步到发布副本目录 → 生成 release-manifest.json。

.DESCRIPTION
  对应桌面 DSH 的 release 流程（scripts/release/bump.ts + verify.ts + pack.ts）：
  版本只从 version.properties 读，发布产物必须在仓库外，清单可审计。
  任何一步失败都退出 1，不产出「看起来成功」的发布。

  产物布局（flavor + ABI 拆分，rc.111 起）：
    app/build/outputs/apk/complete/release/app-complete-<abi>-release.apk
    app/build/outputs/apk/standard/release/app-standard-<abi>-release.apk
  complete 通道带 versionNameSuffix "-complete"（build.gradle.kts），
  所以它的 badging 版本名是 <versionName>-complete —— 校验按 flavor 各自比对。

  与 README 的关系：README 的版本/大小/权限数字由 docs/facts.json 生成，
  不要手写。发布后运行 `node scripts/gen-facts.mjs` 再提交 docs/facts.json。

.PARAMETER Version
  可选。发布版本名（默认读 version.properties 的 versionName）。

.PARAMETER SkipBuild
  跳过 assembleRelease，直接发布现有 APK（CI 已构建时使用）。

.PARAMETER ReleaseDir
  发布副本目录，默认 <repo>/../dsh-mobile-release。

.PARAMETER Apk
  complete 通道 APK，默认 app/build/outputs/apk/complete/release/app-complete-arm64-v8a-release.apk。

.PARAMETER StandardApk
  standard 通道 APK，默认 app/build/outputs/apk/standard/release/app-standard-arm64-v8a-release.apk。

.EXAMPLE
  pwsh -NoProfile -File scripts/publish-release.ps1 -SkipBuild

.EXAMPLE
  pwsh -NoProfile -File scripts/publish-release.ps1 -Version 0.2.1-rc.99
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$SkipBuild,
    [string]$ReleaseDir,
    [string]$Apk,
    [string]$StandardApk
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Error "publish-release: $Message"
    exit 1
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $ReleaseDir) { $ReleaseDir = (Join-Path (Split-Path $repo -Parent) 'dsh-mobile-release') }
if (-not $Apk) { $Apk = Join-Path $repo 'app/build/outputs/apk/complete/release/app-complete-arm64-v8a-release.apk' }
if (-not $StandardApk) { $StandardApk = Join-Path $repo 'app/build/outputs/apk/standard/release/app-standard-arm64-v8a-release.apk' }

# ---- 1. 版本单一来源 -------------------------------------------------------
$propsPath = Join-Path $repo 'version.properties'
if (-not (Test-Path $propsPath)) { Fail "缺少 version.properties（版本唯一真源）" }
$props = @{}
Get-Content $propsPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#')) {
        $eq = $line.IndexOf('=')
        if ($eq -gt 0) { $props[$line.Substring(0, $eq).Trim()] = $line.Substring($eq + 1).Trim() }
    }
}
$expectedName = if ($Version) { $Version } else { $props['versionName'] }
$expectedCode = [int]$props['versionCode']
if (-not $expectedName) { Fail 'version.properties 缺少 versionName' }

# ---- 2. 构建（可选） -------------------------------------------------------
if (-not $SkipBuild) {
    $gradlew = Join-Path $repo 'gradlew.bat'
    if (-not (Test-Path $gradlew)) { $gradlew = Join-Path $repo 'gradlew' }
    if (-not (Test-Path $gradlew)) { Fail '找不到 gradlew/gradlew.bat' }
    Write-Host "▶ assembleRelease（版本 $expectedName / $expectedCode）"
    # gradlew.bat 以「当前目录」找 settings.gradle.kts：脚本必须自带 cwd，
    # 否则从仓库上级目录调用（CI / 计划任务 / 其它会话）会报
    # "Directory 'D:\1' does not contain a Gradle build"。
    Push-Location $repo
    try {
        & $gradlew assembleRelease --no-daemon --console=plain
        $buildExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($buildExit -ne 0) { Fail "assembleRelease 失败（exit $buildExit）" }
}

if (-not (Test-Path $Apk)) { Fail "找不到 complete APK：$Apk（先构建或传 -Apk）" }
if (-not (Test-Path $StandardApk)) { Fail "找不到 standard APK：$StandardApk（先构建或传 -StandardApk）" }

# ---- 3. SDK 工具定位 -------------------------------------------------------
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) {
    $local = Join-Path $repo 'local.properties'
    if (Test-Path $local) {
        $match = Select-String -Path $local -Pattern '^sdk\.dir\s*=\s*(.+)$'
        if ($match) { $sdk = $match.Matches[0].Groups[1].Value.Replace('\\', '\').Replace('\:', ':').Trim() }
    }
}
if (-not $sdk -or -not (Test-Path $sdk)) { Fail "找不到 Android SDK（设置 ANDROID_HOME 或 local.properties 的 sdk.dir）" }
$buildToolsRoot = Join-Path $sdk 'build-tools'
$buildTools = Get-ChildItem $buildToolsRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $buildTools) { Fail "找不到 build-tools：$buildToolsRoot" }
$isWin = [System.Environment]::OSVersion.Platform -eq 'Win32NT'
$aaptExe = if ($isWin) { 'aapt2.exe' } else { 'aapt2' }
$signerExe = if ($isWin) { 'apksigner.bat' } else { 'apksigner' }
$aapt = Join-Path $buildTools.FullName $aaptExe
$apksigner = Join-Path $buildTools.FullName $signerExe

# 从文件名取 ABI（app-complete-arm64-v8a-release.apk → arm64-v8a）
function AbiOf([string]$Path) {
    $m = [regex]::Match((Split-Path $Path -Leaf), '-(arm64-v8a|x86_64)-release\.apk$')
    if (-not $m.Success) { Fail "无法从 APK 文件名识别 ABI：$Path" }
    return $m.Groups[1].Value
}

# ---- 4. 版本核对（APK 自带 badging 对比 version.properties） -----------------
# complete 通道在 build.gradle.kts 里带 versionNameSuffix "-complete"，
# 校验时必须按 flavor 期望值比对，不能用 version.properties 的裸版本名。
function AssertBadging([string]$Path, [string]$ExpectedVersionName) {
    Write-Host "▶ 校验 APK badging：$(Split-Path $Path -Leaf)"
    $badging = & $aapt dump badging $Path 2>&1
    $nameMatch = [regex]::Match(($badging -join "`n"), "versionName='([^']+)'")
    $codeMatch = [regex]::Match(($badging -join "`n"), "versionCode='(\d+)'")
    if (-not $nameMatch.Success -or -not $codeMatch.Success) { Fail "无法从 APK 解析 versionName/versionCode：$Path" }
    if ($nameMatch.Groups[1].Value -ne $ExpectedVersionName) {
        Fail "APK versionName=$($nameMatch.Groups[1].Value) 与期望=$ExpectedVersionName 不一致（$Path）"
    }
    if ([int]$codeMatch.Groups[1].Value -ne $expectedCode) {
        Fail "APK versionCode=$($codeMatch.Groups[1].Value) 与 version.properties=$expectedCode 不一致（$Path）"
    }
}

AssertBadging $Apk "$expectedName-complete"
AssertBadging $StandardApk $expectedName

# ---- 5. 签名核对：未签名产物不得发布 --------------------------------------
Write-Host "▶ 校验签名"
foreach ($path in @($Apk, $StandardApk)) {
    & $apksigner verify --print-certs $path | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "APK 签名校验失败（未签名或证书错误）：$path" }
}

# ---- 6. 复制 + 清单 --------------------------------------------------------
New-Item -ItemType Directory -Force $ReleaseDir | Out-Null
$abi = AbiOf $Apk
$completeName = "DSH-Mobile-$expectedName-$abi-release.apk"
$standardName = "DSH-Mobile-$expectedName-standard-$abi-release.apk"
$completeTarget = Join-Path $ReleaseDir $completeName
$standardTarget = Join-Path $ReleaseDir $standardName
Copy-Item $Apk $completeTarget -Force
Copy-Item $StandardApk $standardTarget -Force

function ArtifactOf([string]$Path) {
    return [ordered]@{
        sizeBytes = (Get-Item $Path).Length
        sha256    = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

$completeArtifact = ArtifactOf $completeTarget
$standardArtifact = ArtifactOf $standardTarget
$sourceRel = (Resolve-Path $Apk).Path.Substring($repo.Length + 1).Replace('\', '/')

$manifest = [ordered]@{
    versionName = $expectedName
    versionCode = $expectedCode
    flavor      = 'complete'
    fileName    = $completeName
    sizeBytes   = $completeArtifact.sizeBytes
    sha256      = $completeArtifact.sha256
    builtAt     = (Get-Date).ToUniversalTime().ToString('o')
    sourceApk   = $sourceRel
    standard    = [ordered]@{
        fileName  = $standardName
        sizeBytes = $standardArtifact.sizeBytes
        sha256    = $standardArtifact.sha256
    }
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $ReleaseDir 'release-manifest.json') -Encoding UTF8

Write-Host ""
Write-Host "✓ 发布完成：$completeTarget"
Write-Host "  complete: $($completeArtifact.sizeBytes) bytes ($([math]::Round($completeArtifact.sizeBytes / 1MB, 1)) MiB)  sha256 $($completeArtifact.sha256)"
Write-Host "  standard: $($standardArtifact.sizeBytes) bytes ($([math]::Round($standardArtifact.sizeBytes / 1MB, 1)) MiB)  sha256 $($standardArtifact.sha256)"
Write-Host ""
Write-Host "下一步："
Write-Host "  1) node scripts/gen-facts.mjs          # 刷新 docs/facts.json（README 依赖它）"
Write-Host "  2) node scripts/gen-facts.mjs --check  # 确认干净"
Write-Host "  3) 提交 version.properties / docs/facts.json / release-manifest.json 对应改动"
