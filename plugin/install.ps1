# install.ps1 - register / unregister this plugin with a dsh profile WITHOUT pnpm.
#
# Why hand-rolled: `dsh plugin ...` is a thin forwarder to `pnpm` in the profile
# directory, and pnpm is not installed on this machine. The profile is really just
# three on-disk facts, which this script edits idempotently (and can undo):
#   1. package.json -> dsh.profile.bundles[] gets the plugin name
#   2. package.json -> dependencies[name] = "link:<posix source path>"
#   3. <profile>/node_modules/<name> = a directory junction to the package
#      (junction, not copy, so editing lib/client.js takes effect on the next page
#       refresh without reinstalling; this mirrors how dsh-bg is linked at D:\dsh)
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Remove
#   powershell ... -File install.ps1 -Profile web -Source 'D:\path\to\this\plugin'
#
# Default -Source is this script's own directory (the plugin/ folder of dsh-pet-kit),
# so after building (tools\build.ps1 -Demo) you can install straight from the repo.
# NOTE: lib\client.js must exist before installing (run the build first).

[CmdletBinding()]
param(
  [string] $Source = $PSScriptRoot,
  [string] $Profile = 'web',
  [switch] $Remove
)

$ErrorActionPreference = 'Stop'
$Name = 'dsh-pet-bg'

function Write-Json($path, $object) {
  # BOM-free UTF-8, CRLF. Set-Content -Encoding UTF8 under PowerShell 5.1 emits a BOM,
  # and Node's JSON.parse throws on a leading BOM - that would stop the harness booting.
  $text = ($object | ConvertTo-Json -Depth 10) -replace "`r?`n", "`r`n"
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function To-Link($path) {
  $p = $path -replace '\\', '/'
  if ($p -match '^([A-Za-z]):/') { return "link:$p" }
  return "link:$p"
}

$profDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$pkgPath = Join-Path $profDir 'package.json'
$nmDir = Join-Path $profDir 'node_modules'
$target = Join-Path $nmDir $Name
$backup = "$pkgPath.bak-$Name"

if (-not (Test-Path $profDir)) {
  Write-Host "[x] profile dir not found: $profDir" -ForegroundColor Red
  Write-Host '    Boot the web profile once (dsh web) so the profile dir exists, then retry.' -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path $pkgPath)) { Write-Host "[x] no package.json at $pkgPath" -ForegroundColor Red; exit 1 }

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$changed = $false

if ($Remove) {
  Write-Host "--- removing $Name from profile '$Profile' ---" -ForegroundColor Cyan
  if (Test-Path $backup) {
    Copy-Item $backup $pkgPath -Force
    Write-Host "  restored package.json from $backup"
  }
  else {
    if ($pkg.dsh.profile.bundles) {
      $kept = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $Name })
      if ($kept.Count -ne @($pkg.dsh.profile.bundles).Count) {
        $pkg.dsh.profile.bundles = $kept
        $deps = $pkg.dependencies
        if ($deps -and $deps.PSObject.Properties[$Name]) { $deps.PSObject.Properties.Remove($Name) }
        $changed = $true
      }
    }
    if ($changed) {
      Write-Json $pkgPath $pkg
      Write-Host "  dropped bundle + dependency entry"
    }
  }
  if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType) { $item.Delete() } else { Remove-Item $target -Recurse -Force }
    Write-Host "  removed $target"
  }
  # take our managed block out of the live patch layer (leave other patches alone)
  $pp = Join-Path $profDir 'cordis.patch.yml'
  if (Test-Path $pp) {
    $pt = [System.IO.File]::ReadAllText($pp)
    $rx = "(?s)# >>> $Name \(managed[^\r\n]*\r?\n.*?# <<< $Name <<<\r?\n?"
    if ([regex]::IsMatch($pt, $rx)) {
      $pt = [regex]::Replace($pt, $rx, '')
      $rest = ((($pt -split "(?m)^#.*$" -join '') -replace '\s', ''))
      if ($rest -eq '') { $pt = $pt.TrimEnd() + "`r`n[]`r`n" }
      [System.IO.File]::WriteAllText($pp, $pt, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "  removed managed block from $pp"
    } else { Write-Host '  patch layer had no managed block' }
  }
  Write-Host "[ok] removed. Refresh the browser tab to drop the plugin." -ForegroundColor Green
  exit 0
}

# ---- install -------------------------------------------------------------
foreach ($need in @('package.json', 'lib\client.js', 'cordis.patch.yml')) {
  if (-not (Test-Path (Join-Path $Source $need))) {
    Write-Host "[x] $Source is not a complete package (missing $need)" -ForegroundColor Red
    Write-Host '    Run: node tools/assemble.mjs   (builds lib/client.js from src/*)' -ForegroundColor Yellow
    exit 1
  }
}
Write-Host "--- installing $Name into profile '$Profile' ---" -ForegroundColor Cyan
Write-Host "  source  : $Source"
Write-Host "  profile : $profDir"

if (-not (Test-Path $backup)) {
  Copy-Item $pkgPath $backup
  Write-Host "  backed up package.json -> $backup"
}

if (-not $pkg.dsh.profile.bundles) {
  $pkg.dsh.profile.bundles = @()
}
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains $Name) {
  $pkg.dsh.profile.bundles = @($bundles + $Name)
  $changed = $true
  Write-Host "  bundles += $Name"
}
if (-not $pkg.dependencies) {
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$want = To-Link $Source
if (-not $pkg.dependencies.PSObject.Properties[$Name]) {
  $pkg.dependencies | Add-Member -NotePropertyName $Name -NotePropertyValue $want
  $changed = $true
  Write-Host "  dependencies[$Name] = $want"
}
elseif ($pkg.dependencies.$Name -ne $want) {
  $pkg.dependencies.$Name = $want
  $changed = $true
  Write-Host "  dependencies[$Name] re-pointed to $want"
}
if ($changed) {
  Write-Json $pkgPath $pkg
  Write-Host "  wrote $pkgPath"
}
else { Write-Host "  package.json already registered" }

# ---- 3. profile patch layer: THE live registration ------------------------
# The bundle layer of package.json is only read at host startup, so registering a
# plugin there costs the user a server restart. The profile's own cordis.patch.yml
# IS watched and re-composed live (patchReload: live), so the entry row lives here:
# write it, refresh the browser tab, done. Kept inside a managed block so
# -Remove can take exactly our lines out without touching anyone else's patches.
$patchPath = Join-Path $profDir 'cordis.patch.yml'
$block = @"
# >>> $Name (managed by $Name install.ps1 - do not edit inside) >>>
- insert:
    - id: $Name
      name: $Name
# <<< $Name <<<
"@

function Add-PatchBlock {
  $text = ''
  if (Test-Path $patchPath) { $text = [System.IO.File]::ReadAllText($patchPath) }
  if ($text -match "# >>> $Name \(managed") { Write-Host "  patch layer already registered"; return }
  $trimmed = $text.TrimEnd()
  # A flow-style "[]" (with only comments around it) cannot be followed by block
  # items -- YAML forbids mixing the two. Rewrite the empty array into our block
  # and keep the header comments.
  if ($trimmed -eq '' -or $trimmed -match '(?s)^\s*(?:#[^\r\n]*\r?\n)*\s*\[\]\s*$') {
    $comments = (@([regex]::Matches($trimmed, '(?m)^#.*$') | ForEach-Object { $_.Value })) -join "`r`n"
    if ($comments) { $out = $comments + "`r`n`r`n" + $block + "`r`n" } else { $out = $block + "`r`n" }
  } else {
    $out = $trimmed + "`r`n`r`n" + $block + "`r`n"
  }
  [System.IO.File]::WriteAllText($patchPath, $out, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  wrote managed block -> $patchPath"
  Write-Host '    (live layer: refresh the tab, no server restart needed)'
}
Add-PatchBlock

if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Path $nmDir | Out-Null }
$need = $true
if (Test-Path $target) {
  $item = Get-Item $target -Force
  if ($item.LinkType -and $item.Target -eq $Source) {
    Write-Host "  junction already correct"
    $need = $false
  }
  else {
    $stale = "$target.stale-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Move-Item $target $stale
    Write-Host "  moved previous entry aside -> $stale" -ForegroundColor Yellow
  }
}
if ($need) {
  New-Item -ItemType Junction -Path $target -Target $Source | Out-Null
  Write-Host "  junction  $target -> $Source"
}

$readme = Join-Path $Source 'README.md'
Write-Host ""
Write-Host "[ok] installed. Now:" -ForegroundColor Green
Write-Host "  1. refresh the DSH Web tab (Ctrl+F5). No server restart is needed:" -ForegroundColor White
Write-Host "     the client bundle is read from disk per request." -ForegroundColor White
Write-Host "  2. you should see the pet near the bottom-right of the window." -ForegroundColor White
Write-Host "  3. right-click it for the menu; 'background settings' opens the video panel." -ForegroundColor White
Write-Host "  4. diagnostics live at: BOOT.info() -> window.__DSH_PET_BG_STOP__ exists too." -ForegroundColor White
if (Test-Path $readme) { Write-Host "  docs: $readme" }
Write-Host "  undo: powershell -File install.ps1 -Remove" -ForegroundColor DarkGray
