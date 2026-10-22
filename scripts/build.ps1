<#
.SYNOPSIS
  Builds the Rowlit Windows installer: engine (self-contained single file) + UI + Electron/NSIS.

.DESCRIPTION
  Version comes from version.json at the repo root and is injected without editing package files:
    engine   -> dotnet publish -p:Version=<v>
    ui       -> VITE_APP_VERSION=<v>
    desktop  -> electron-builder -c.extraMetadata.version=<v>
  Output: desktop/dist/Rowlit-Setup-<version>.exe

.EXAMPLE
  ./scripts/build.ps1                    # everything
  ./scripts/build.ps1 -SkipInstaller     # engine publish + UI build + desktop compile, no electron-builder
  ./scripts/build.ps1 -EngineOnly        # just dotnet publish into engine/publish
  ./scripts/build.ps1 -Dir               # unpacked app in desktop/dist/win-unpacked (faster than NSIS)
  ./scripts/build.ps1 -EngineOnly -Runtime osx-arm64   # cross-publish a macOS engine into engine/publish/osx-arm64
                                                       # (the DMG itself needs a Mac: scripts/build.sh)
#>
[CmdletBinding()]
param(
  [switch]$SkipEngine,
  [switch]$SkipUi,
  [switch]$SkipInstaller,
  [switch]$EngineOnly,
  [switch]$Dir,
  [string]$Configuration = 'Release',
  [string]$Runtime = 'win-x64'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw (Join-Path $root 'version.json') | ConvertFrom-Json).version
if (-not ($version -match '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')) { throw "version.json: invalid version '$version'" }

$hostProject = Join-Path $root 'engine/src/DbStudio.Host/DbStudio.Host.csproj'
$isWindowsRid = $Runtime -like 'win-*'
# Windows keeps engine/publish (electron-builder win.extraResources); other RIDs go to engine/publish/<rid>
# (mac.extraResources maps engine/publish/osx-${arch}).
$publishDir = if ($isWindowsRid) { Join-Path $root 'engine/publish' } else { Join-Path $root "engine/publish/$Runtime" }
# The engine is published as Rowlit.Engine(.exe), the process name users see; the assembly (and so the apphost that
# dotnet publish writes) is still DbStudio.Engine. A single-file apphost can be renamed freely.
$exeSuffix = if ($isWindowsRid) { '.exe' } else { '' }
$engineName = "Rowlit.Engine$exeSuffix"
if (-not $isWindowsRid -and -not $EngineOnly) { throw "-Runtime $Runtime needs -EngineOnly; build the macOS app on a Mac with scripts/build.sh." }
$uiDir = Join-Path $root 'ui'
$desktopDir = Join-Path $root 'desktop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Write-Step([string]$msg) { Write-Host "==> [$([int]$sw.Elapsed.TotalSeconds)s] $msg" -ForegroundColor Cyan }
function Invoke-Checked([string]$what, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE) { throw "$what failed (exit code $LASTEXITCODE)" }
}
function Invoke-Npm([string]$dir, [string[]]$npmArgs) {
  Push-Location $dir
  try { Invoke-Checked "npm $($npmArgs -join ' ') in $dir" { & npm.cmd @npmArgs } } finally { Pop-Location }
}
function Ensure-NodeModules([string]$dir) {
  if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
    if (Test-Path (Join-Path $dir 'package-lock.json')) { Invoke-Npm $dir @('ci') } else { Invoke-Npm $dir @('install') }
  }
}

Write-Host "Rowlit $version ($Configuration, $Runtime)" -ForegroundColor Green

# 1. Engine: self-contained single-file exe. IncludeNativeLibrariesForSelfExtract bundles the native
#    SNI (SqlClient) and e_sqlite3 libraries (PLAN R2).
if (-not $SkipEngine) {
  Write-Step "dotnet publish -> $publishDir"
  if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }
  $env:DOTNET_NOLOGO = '1'
  $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
  Invoke-Checked 'dotnet publish' {
    & dotnet publish $hostProject -c $Configuration -r $Runtime --self-contained true -o $publishDir `
      -p:PublishSingleFile=true `
      -p:IncludeNativeLibrariesForSelfExtract=$isWindowsRid `
      -p:EnableCompressionInSingleFile=true `
      -p:DebugType=embedded `
      -p:Version=$version `
      -nologo
  }
  # The installer and engine-process.ts expect Rowlit.Engine.exe; dotnet publish writes DbStudio.Engine.exe (the
  # assembly name) or, for an older Host project, DbStudio.Host.exe.
  $engineExe = Join-Path $publishDir $engineName
  foreach ($published in "DbStudio.Engine$exeSuffix", "DbStudio.Host$exeSuffix") {
    $publishedExe = Join-Path $publishDir $published
    if (-not (Test-Path $engineExe) -and (Test-Path $publishedExe)) { Move-Item $publishedExe $engineExe }
  }
  if (-not (Test-Path $engineExe)) { throw "Engine executable not found in $publishDir" }
  $sizeMb = [math]::Round((Get-Item $engineExe).Length / 1MB, 1)
  Write-Step "Engine: $engineExe ($sizeMb MB)"
}
if ($EngineOnly) { Write-Step 'Done (engine only)'; return }

# 2. UI
if (-not $SkipUi) {
  Write-Step 'UI: npm run build'
  Ensure-NodeModules $uiDir
  $env:VITE_APP_VERSION = $version
  Invoke-Npm $uiDir @('run', 'build')
  if (-not (Test-Path (Join-Path $uiDir 'dist/index.html'))) { throw 'ui/dist/index.html was not produced' }
}

# 3. Desktop: type-check + bundle main/preload, then package.
Write-Step 'Desktop: npm run build'
Ensure-NodeModules $desktopDir
Invoke-Npm $desktopDir @('run', 'build')

if ($SkipInstaller) { Write-Step 'Done (installer skipped)'; return }

foreach ($required in (Join-Path $publishDir 'Rowlit.Engine.exe'), (Join-Path $uiDir 'dist/index.html')) {
  if (-not (Test-Path $required)) { throw "Missing $required - run without -SkipEngine/-SkipUi first." }
}

$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false' # unsigned build (PLAN R10)
$target = if ($Dir) { 'dir' } else { 'nsis' }
Write-Step "electron-builder ($target)"
Push-Location $desktopDir
try {
  Invoke-Checked 'electron-builder' {
    & (Join-Path $desktopDir 'node_modules/.bin/electron-builder.cmd') --win $target --x64 --publish never "-c.extraMetadata.version=$version"
  }
} finally { Pop-Location }

if ($Dir) {
  Write-Step "Done: $(Join-Path $desktopDir 'dist/win-unpacked/Rowlit.exe')"
} else {
  $installer = Join-Path $desktopDir "dist/Rowlit-Setup-$version.exe"
  if (-not (Test-Path $installer)) { throw "Installer not found: $installer" }
  Write-Step "Done: $installer ($([math]::Round((Get-Item $installer).Length / 1MB, 1)) MB)"
}
