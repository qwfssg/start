# build.ps1 - one-command pipeline for dsh-pet-kit.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
#
# Usage (works from any cwd; script resolves repo root itself):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1 -Demo
#       Zero-external-asset chain (uses examples\frames only):
#         key_green -> compare -> pack_sheet -> embed-sheet -> assemble -> smoke
#       Regenerates plugin\src\sheet.js and plugin\lib\client.js from scratch
#       (both are gitignored build products, so a fresh clone builds cleanly).
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1 -Src <raw-frames-dir> `
#       [-Only <group>] [-Preset <presets.json>] [-PackArgs "<pack_sheet args>"] [-SkipCompare] [-SkipSmoke]
#       Full chain on your own material (group subdirs or flat dir under -Src).
#
# Any step exiting non-zero stops the build immediately and prints step name + exit code.
# Docs (Chinese): docs\02 (keying), docs\03 (packing), docs\06 (build/verify/deploy).

param(
  [switch] $Demo,
  [string] $Src = '',
  [string] $Only = '',
  [string] $Preset = '',
  [string] $PackArgs = '--cell 112x150 --box 98x118 --baseline 134 --display 192x224 --cols 8 --rows 21',
  [switch] $SkipCompare,
  [switch] $SkipSmoke
)

$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT
$BUILD = Join-Path $ROOT '.build'
$script:StepNo = 0
$script:StepTotal = 0
$T0 = Get-Date

function Invoke-Step([string] $name, [string] $exe, [string[]] $stepArgs) {
  $script:StepNo++
  Write-Host ''
  Write-Host ("== [{0}/{1}] {2}" -f $script:StepNo, $script:StepTotal, $name) -ForegroundColor Cyan
  Write-Host ("   > {0} {1}" -f $exe, ($stepArgs -join ' ')) -ForegroundColor DarkGray
  $t0 = Get-Date
  & $exe @stepArgs
  $code = $LASTEXITCODE
  $sec = [int]((Get-Date) - $t0).TotalSeconds
  if ($code -ne 0) {
    Write-Host ''
    Write-Host ("[X] FAILED step '{0}' (exit {1}). Reason should be in its output above." -f $name, $code) -ForegroundColor Red
    Write-Host ("[X] Build stopped at step {0}/{1} after {2}s." -f $script:StepNo, $script:StepTotal, [int]((Get-Date) - $T0).TotalSeconds) -ForegroundColor Red
    exit $code
  }
  Write-Host ("[OK] {0}  ({1}s)" -f $name, $sec) -ForegroundColor Green
}

# ---------------------------------------------------------------- demo chain
if ($Demo) {
  $script:StepTotal = 6 - [int]$SkipCompare.ToBool() - [int]$SkipSmoke.ToBool()
  Write-Host 'build.ps1 -Demo : zero-external-asset chain (examples\frames)' -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $BUILD | Out-Null

  Invoke-Step 'key_green  (examples/frames -> .build/keyed, 12 frames)' 'python' @(
    'tools\key_green.py', '--src', 'examples\frames', '--out', '.build\keyed',
    '--preset', 'examples\presets.json', '--group-name', 'demo')

  if (-not $SkipCompare) {
    Invoke-Step 'compare    (magenta 3-variant review sheets)' 'python' @(
      'tools\compare.py', '--src', 'examples\frames', '--out', '.build\compare',
      '--samples', 'f0097.png,f0276.png,f0340.png')
  }

  Invoke-Step 'pack_sheet (fit-to-box -> .build/pack, quarantines 2 oversized frames)' 'python' @(
    'tools\pack_sheet.py', '--src', '.build\keyed', '--out', '.build\pack',
    '--map', 'demo=idle',
    '--frames', 'f0002.png,f0140.png,f0276.png,f0300.png,f0319.png,f0340.png,f0361.png',
    '--max-content', '400',
    '--fill-from-idle', 'walk,react,working,sleep,dead,supervise',
    '--cell', '96x112', '--box', '84x88', '--baseline', '100',
    '--display', '192x224', '--cols', '5')

  # embed-sheet expects <dir>\spritesheet.png + <dir>\pet.json
  $stage = Join-Path $BUILD 'stage'
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item (Join-Path $BUILD 'pack\spritesheet.png') $stage -Force
  Copy-Item (Join-Path $BUILD 'pack\pet.json') $stage -Force

  Invoke-Step 'embed-sheet (PNG -> base64 -> plugin/src/sheet.js + plugin/assets)' 'node' @(
    'plugin\tools\embed-sheet.mjs', '.build\stage')

  Invoke-Step 'assemble   (5 src files -> plugin/lib/client.js + syntax self-check)' 'node' @(
    'plugin\tools\assemble.mjs')

  if (-not $SkipSmoke) {
    Invoke-Step 'smoke      (fake-DOM acceptance: geometry/meta/menu labels)' 'node' @(
      'tools\smoke.mjs', '--src', 'plugin\src', '--meta', 'plugin\assets\pet.json')
  }
}
# ---------------------------------------------------------------- full chain
else {
  if (-not $Src) {
    Write-Host 'Usage: build.ps1 -Demo   |   build.ps1 -Src <raw-frames-dir> [-Only g] [-Preset p.json] [-PackArgs "..."]' -ForegroundColor Yellow
    exit 2
  }
  if (-not (Test-Path $Src)) { Write-Host ("[X] -Src not found: {0}" -f $Src) -ForegroundColor Red; exit 2 }
  $script:StepTotal = 6 - [int]$SkipCompare.ToBool() - [int]$SkipSmoke.ToBool()
  Write-Host ("build.ps1 : full chain on {0}" -f $Src) -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $BUILD | Out-Null

  $kgArgs = @('tools\key_green.py', '--src', $Src, '--out', '.build\keyed')
  if ($Only) { $kgArgs += @('--only', $Only) }
  if ($Preset) { $kgArgs += @('--preset', $Preset) }
  Invoke-Step 'key_green' 'python' $kgArgs

  if (-not $SkipCompare) {
    Invoke-Step 'compare (default: first 3 frames per group)' 'python' @(
      'tools\compare.py', '--src', $Src, '--out', '.build\compare')
  }

  $pkArgs = @('tools\pack_sheet.py', '--src', '.build\keyed', '--out', '.build\pack')
  $pkArgs += ($PackArgs -split ' ' | Where-Object { $_ })
  Invoke-Step 'pack_sheet' 'python' $pkArgs

  $stage = Join-Path $BUILD 'stage'
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item (Join-Path $BUILD 'pack\spritesheet.png') $stage -Force
  Copy-Item (Join-Path $BUILD 'pack\pet.json') $stage -Force

  Invoke-Step 'embed-sheet' 'node' @('plugin\tools\embed-sheet.mjs', '.build\stage')
  Invoke-Step 'assemble' 'node' @('plugin\tools\assemble.mjs')
  if (-not $SkipSmoke) {
    Invoke-Step 'smoke' 'node' @('tools\smoke.mjs', '--src', 'plugin\src', '--meta', 'plugin\assets\pet.json')
  }
}

Write-Host ''
Write-Host ('[OK] chain complete in {0}s. Artifacts:' -f [int]((Get-Date) - $T0).TotalSeconds) -ForegroundColor Green
Write-Host '  .build\keyed\report.txt        per-frame keying metrics'
Write-Host '  .build\compare\cmp-*.png       magenta review sheets (human checkpoint)'
Write-Host '  .build\pack\pack-report.txt    packing + readback verification'
Write-Host '  plugin\src\sheet.js            generated (gitignored)'
Write-Host '  plugin\lib\client.js           generated (gitignored)'
Write-Host 'Next: powershell -File plugin\install.ps1   then Ctrl+F5 the DSH Web tab.'
