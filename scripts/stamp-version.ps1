<#
.SYNOPSIS
  Writes the version from version.json into all three packages (for release commits).

.DESCRIPTION
  build.ps1 injects the version at build time without touching files; run this script when cutting a
  release so the checked-in package files agree with version.json:
    desktop/package.json  "version"
    ui/package.json       "version"
    engine/Directory.Build.props  <Version>
.EXAMPLE
  ./scripts/stamp-version.ps1            # uses version.json
  ./scripts/stamp-version.ps1 -Set 0.2.0 # updates version.json first
#>
[CmdletBinding()]
param([string]$Set)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $root 'version.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if ($Set) {
  if (-not ($Set -match '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')) { throw "Invalid version '$Set'" }
  [System.IO.File]::WriteAllText($versionFile, "{`n  `"version`": `"$Set`"`n}`n", $utf8)
}
$version = (Get-Content -Raw $versionFile | ConvertFrom-Json).version

# Regex replace keeps the files' formatting intact (ConvertTo-Json would reflow them).
function Set-JsonVersion([string]$file) {
  if (-not (Test-Path $file)) { Write-Warning "skip $file (missing)"; return }
  $text = [System.IO.File]::ReadAllText($file)
  $re = [regex]'(?m)^(\s*"version"\s*:\s*")[^"]*(")'
  if (-not $re.IsMatch($text)) { throw "No top-level version field in $file" }
  [System.IO.File]::WriteAllText($file, $re.Replace($text, "`${1}$version`${2}", 1), $utf8)
  Write-Host "  $file -> $version"
}

Set-JsonVersion (Join-Path $root 'desktop/package.json')
Set-JsonVersion (Join-Path $root 'ui/package.json')

$props = Join-Path $root 'engine/Directory.Build.props'
if (Test-Path $props) {
  $text = [System.IO.File]::ReadAllText($props)
  if ($text -match '<Version>[^<]*</Version>') {
    $text = $text -replace '<Version>[^<]*</Version>', "<Version>$version</Version>"
  } else {
    $text = $text -replace '(<PropertyGroup>)', "`$1`n    <Version>$version</Version>"
  }
  [System.IO.File]::WriteAllText($props, $text, $utf8)
  Write-Host "  $props -> $version"
}
Write-Host "Stamped $version. (package-lock.json files pick it up on the next npm install.)"
