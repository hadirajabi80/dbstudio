# M1.5: starts the engine (--dev, port 5121, token dev-token) with a temporary data directory, waits for the
# DBSTUDIO_READY line, runs smoke-m15.mjs (the WP-F endpoints) against it and stops the engine.
#   pwsh engine/tests/smoke/M15/run-smoke-m15.ps1      (or: powershell -File engine/tests/smoke/M15/run-smoke-m15.ps1)
param([int]$Port = 5121, [string]$Token = 'dev-token')

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')
$hostProject = Join-Path $root 'engine\src\DbStudio.Host'
$dataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dbstudio-smoke-data-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $dataDir | Out-Null

dotnet build $hostProject -nologo -v q | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Engine build failed.' }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'dotnet'
$psi.Arguments = "run --no-build --project `"$hostProject`" -- --dev --port $Port --token $Token --parent-pid $PID"
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.Environment['DBSTUDIO_DATA_DIR'] = $dataDir
$engine = [System.Diagnostics.Process]::Start($psi)
$null = $engine.StandardError.ReadToEndAsync()   # drain logs

try {
    $deadline = (Get-Date).AddSeconds(60)
    $ready = $null
    while (-not $ready -and (Get-Date) -lt $deadline) {
        $lineTask = $engine.StandardOutput.ReadLineAsync()
        if (-not $lineTask.Wait(60000)) { break }
        $line = $lineTask.Result
        if ($null -eq $line) { break }
        if ($line.StartsWith('DBSTUDIO_READY ')) { $ready = $line }
    }
    if (-not $ready) { throw 'Engine did not print DBSTUDIO_READY within 60 s.' }
    Write-Host $ready
    node (Join-Path $PSScriptRoot 'smoke-m15.mjs') --url "http://127.0.0.1:$Port" --token $Token
    $code = $LASTEXITCODE
}
finally {
    if (-not $engine.HasExited) {
        # Kill the whole tree (dotnet run → DbStudio.Engine); works on Windows PowerShell 5.1 and pwsh.
        & taskkill /PID $engine.Id /T /F | Out-Null
        $engine.WaitForExit(10000) | Out-Null
    }
    Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
}
exit $code
