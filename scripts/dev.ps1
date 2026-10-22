<#
.SYNOPSIS
  Rowlit development loop: engine (--dev) + Vite (hot reload) + Electron pointed at Vite.

.DESCRIPTION
  1. dotnet run the engine in --dev mode on a fixed port with a fixed token (CORS allows http://localhost:5173).
  2. Vite dev server for ui/ with VITE_ENGINE_URL / VITE_ENGINE_TOKEN.
  3. Electron (desktop/) loading http://localhost:5173 and attaching to the same engine
     (DBSTUDIO_DEV_URL, DBSTUDIO_ENGINE_URL, DBSTUDIO_ENGINE_TOKEN), so it does not spawn its own.
  Ctrl+C (or closing the Electron window) stops every process tree this script started.
  Renderer edits hot-reload through Vite; main/preload edits need a restart of this script.

.EXAMPLE
  ./scripts/dev.ps1                 # engine + Vite + Electron
  ./scripts/dev.ps1 -Browser        # engine + Vite only; open http://localhost:5173 in a browser
#>
[CmdletBinding()]
param(
  [int]$EnginePort = 5121,
  [string]$Token = 'dev-token',
  [int]$VitePort = 5173,
  [switch]$Browser,
  [int]$EngineTimeoutSec = 240
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$engineUrl = "http://127.0.0.1:$EnginePort"
$viteUrl = "http://localhost:$VitePort"
$started = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Stop-Tree([System.Diagnostics.Process]$p) {
  if ($p -and -not $p.HasExited) {
    & taskkill.exe /PID $p.Id /T /F 2>$null | Out-Null
  }
}

function Test-Url([string]$url, [hashtable]$headers = @{}) {
  try {
    $r = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -ge 200 -and $r.StatusCode -lt 500
  } catch [System.Net.WebException] {
    # Any HTTP response (even 404) means the server is up.
    return $null -ne $_.Exception.Response
  } catch {
    return $false
  }
}

function Wait-Until([scriptblock]$check, [System.Diagnostics.Process]$proc, [string]$what, [int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (& $check) { return }
    if ($proc.HasExited) { throw "$what exited with code $($proc.ExitCode) before becoming ready." }
    Start-Sleep -Milliseconds 500
  }
  throw "$what did not become ready within $timeoutSec s."
}

function Ensure-NodeModules([string]$dir) {
  if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
    Write-Step "npm install in $dir"
    Push-Location $dir
    try { & npm.cmd install; if ($LASTEXITCODE) { throw "npm install failed in $dir" } } finally { Pop-Location }
  }
}

foreach ($tool in 'dotnet', 'npm.cmd') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH." }
}
foreach ($port in $EnginePort, $VitePort) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $port is already in use. Stop the other process or pass -EnginePort/-VitePort."
  }
}

try {
  # 1. Engine
  Write-Step "Engine (dotnet run --dev) on $engineUrl"
  $env:DOTNET_NOLOGO = '1'
  $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
  $engine = Start-Process -FilePath 'dotnet' -NoNewWindow -PassThru -WorkingDirectory $root -ArgumentList @(
    'run', '--project', (Join-Path $root 'engine/src/DbStudio.Host'), '--no-launch-profile', '--',
    '--dev', '--port', $EnginePort, '--token', $Token, '--parent-pid', $PID)
  $started.Add($engine)

  # 2. Vite (installs ui deps on first run)
  $ui = Join-Path $root 'ui'
  Ensure-NodeModules $ui
  Write-Step "Vite on $viteUrl"
  $env:VITE_ENGINE_URL = $engineUrl
  $env:VITE_ENGINE_TOKEN = $Token
  $vite = Start-Process -FilePath 'npm.cmd' -NoNewWindow -PassThru -WorkingDirectory $ui -ArgumentList @(
    'run', 'dev', '--', '--port', $VitePort, '--strictPort')
  $started.Add($vite)

  Wait-Until { Test-Url "$engineUrl/api/v1/health" @{ Authorization = "Bearer $Token" } } $engine 'Engine' $EngineTimeoutSec
  Write-Step 'Engine is ready'
  Wait-Until { Test-Url $viteUrl } $vite 'Vite' 60
  Write-Step 'Vite is ready'

  if ($Browser) {
    Write-Host "Open $viteUrl in a browser. Ctrl+C to stop." -ForegroundColor Green
    while (-not $engine.HasExited -and -not $vite.HasExited) { Start-Sleep -Seconds 1 }
    return
  }

  # 3. Electron
  $desktop = Join-Path $root 'desktop'
  Ensure-NodeModules $desktop
  Write-Step 'Building desktop main/preload'
  Push-Location $desktop
  try { & npm.cmd run build; if ($LASTEXITCODE) { throw 'desktop build failed' } } finally { Pop-Location }

  Write-Step 'Electron'
  $env:DBSTUDIO_DEV_URL = $viteUrl
  $env:DBSTUDIO_ENGINE_URL = $engineUrl
  $env:DBSTUDIO_ENGINE_TOKEN = $Token
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $electronExe = Join-Path $desktop 'node_modules/electron/dist/electron.exe'
  $electron = Start-Process -FilePath $electronExe -ArgumentList @('.') -WorkingDirectory $desktop -NoNewWindow -PassThru
  $started.Add($electron)

  Write-Host 'Running. Close the Rowlit window or press Ctrl+C to stop everything.' -ForegroundColor Green
  while (-not $electron.HasExited) {
    if ($engine.HasExited) { Write-Warning "Engine exited with code $($engine.ExitCode)."; break }
    if ($vite.HasExited) { Write-Warning "Vite exited with code $($vite.ExitCode)."; break }
    Start-Sleep -Seconds 1
  }
}
finally {
  Write-Step 'Stopping engine, Vite and Electron'
  for ($i = $started.Count - 1; $i -ge 0; $i--) { Stop-Tree $started[$i] }
}
