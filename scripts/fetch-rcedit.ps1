<#
  scripts/fetch-rcedit.ps1 — download the rcedit binary used by
  the afterPack hook (scripts/afterpack-icon.cjs). rcedit is what
  writes the icon, application manifest, and version info into
  Steam Client.exe before packaging. We don't pull it from
  npm because the @electron/rcedit wrapper pulls in winCodeSign
  transitively, which 7z-fails to unpack on Windows dev accounts
  without SeCreateSymbolicLinkPrivilege.

  Idempotent: skips the download if the file is already in place.
#>
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$toolsDir = Join-Path $repoRoot 'tools'
$dest = Join-Path $toolsDir 'rcedit-x64.exe'

$version = '1.1.1'
$url = "https://github.com/electron/rcedit/releases/download/v$version/rcedit-x64.exe"

if (Test-Path $dest) {
  $existing = Get-Item $dest
  Write-Host "rcedit already present: $dest ($($existing.Length) bytes, $([datetime]::FromFileTime($existing.LastWriteTimeUtc.ToFileTime())).ToString('u'))"
  exit 0
}

if (-not (Test-Path $toolsDir)) {
  New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
}

Write-Host "Downloading rcedit $version..."
Write-Host "  url: $url"
Write-Host "  dest: $dest"
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing

$size = (Get-Item $dest).Length
Write-Host "  done: $size bytes"
if ($size -lt 100KB) {
  throw "Downloaded rcedit is suspiciously small ($size bytes). Aborting."
}
