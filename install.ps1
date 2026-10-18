# codemax installer for Windows (PowerShell)
#
#   irm https://codemax.saidev.codes/install.ps1 | iex
#   (same script: https://raw.githubusercontent.com/SkidGod4444/codemax-cli/main/install.ps1)
#
# Installs the newest codemax release into %USERPROFILE%\.codemax\cli, creates a
# `codemax` command in Bun's bin folder and adds that folder to your user PATH.
# Never reads, sets or asks for API keys.
#
# Options (environment variables):
#   CODEMAX_DIR    where the code lives        (default %USERPROFILE%\.codemax\cli)
#   CODEMAX_REPO   git source                  (default the GitHub repo)
#   CODEMAX_REF    tag or branch to install    (default the newest vX.Y.Z release)
#   CODEMAX_YES=1  install Bun without asking if it is missing
#
# Uninstall: remove %USERPROFILE%\.codemax\cli and %USERPROFILE%\.bun\bin\codemax.cmd

$ErrorActionPreference = 'Stop'

function Say([string]$t) { Write-Host $t }
function Step([string]$t) { Write-Host "❯ " -ForegroundColor Magenta -NoNewline; Write-Host $t }
function Ok([string]$t) { Write-Host "  ⎿  " -ForegroundColor DarkGray -NoNewline; Write-Host $t }
function Die([string]$t) { Write-Host "✗ " -ForegroundColor Magenta -NoNewline; Write-Host $t; throw "codemax install failed" }

$Repo = if ($env:CODEMAX_REPO) { $env:CODEMAX_REPO } else { 'https://github.com/SkidGod4444/codemax-cli.git' }
$Ref = $env:CODEMAX_REF
$Dir = if ($env:CODEMAX_DIR) { $env:CODEMAX_DIR } else { Join-Path $env:USERPROFILE '.codemax\cli' }
$BunHome = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE '.bun' }
$BunBin = Join-Path $BunHome 'bin'

Say ''
Say '  codemax · every AI coding plan you pay for, one terminal'
Say ''

if ($env:OS -ne 'Windows_NT') { Die 'This installer is for Windows. On macOS or Linux run: curl -fsSL https://codemax.saidev.codes/install | bash' }

# ── git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Die 'git is required. Install it (winget install Git.Git), open a new terminal, then run this again.'
}

# ── bun 1.3+
$Bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $Bun -and (Test-Path (Join-Path $BunBin 'bun.exe'))) { $Bun = Join-Path $BunBin 'bun.exe' }
if (-not $Bun) {
  Step 'codemax runs on Bun, which is not installed.'
  $answer = 'y'
  if ($env:CODEMAX_YES -ne '1') {
    $answer = Read-Host '  Install Bun now from bun.sh? [Y/n]'
    if (-not $answer) { $answer = 'y' }
  }
  if ($answer -notmatch '^(y|yes)$') { Die 'Install Bun (https://bun.sh), then run this again.' }
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" | Out-Null
  $Bun = Join-Path $BunBin 'bun.exe'
  if (-not (Test-Path $Bun)) { Die 'Bun did not install. See https://bun.sh' }
}
$version = (& $Bun --version).Trim()
if ([version]($version -replace '[^0-9.].*$', '') -lt [version]'1.3.0') { Die "codemax needs Bun 1.3 or newer (found $version). Run: bun upgrade" }
Ok "Bun $version"

# ── which version: the newest release tag, so a work-in-progress push to main
#    never reaches users. Falls back to main only until the first release.
$env:GIT_TERMINAL_PROMPT = '0'
if (-not $Ref) {
  $tags = git ls-remote --tags --refs $Repo 'v*' 2>$null
  if ($LASTEXITCODE -ne 0) { Die "Could not reach $Repo. Check your connection, or that the repository is public." }
  $Ref = $tags | ForEach-Object { ($_ -split 'refs/tags/')[-1] } |
    Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } |
    Sort-Object { [version]($_.Substring(1)) } | Select-Object -Last 1
  if (-not $Ref) { $Ref = 'main'; Ok 'No release yet, installing the latest main' }
}

# ── code: fetch just the chosen release into a plain checkout
if (Test-Path (Join-Path $Dir '.git')) {
  Step "Updating codemax to $Ref"
  git -C $Dir remote set-url origin $Repo
} else {
  Step "Downloading codemax $Ref"
  if (Test-Path $Dir) { Die "$Dir exists and is not a codemax checkout. Move it or set CODEMAX_DIR." }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  git -C $Dir init --quiet
  git -C $Dir remote add origin $Repo
}
git -C $Dir fetch --quiet --depth 1 --no-tags origin $Ref 2>$null
if ($LASTEXITCODE -ne 0) { Die "Could not download $Ref from $Repo. Check your connection, or that the repository is public." }
git -C $Dir -c advice.detachedHead=false checkout --quiet --force --detach 'FETCH_HEAD^{commit}'
if ($LASTEXITCODE -ne 0) { Die 'Could not check out the downloaded version.' }
Ok ((git -C $Dir log -1 --format='%h %s') -replace '^(.{0,60}).*$', '$1')

Step 'Installing dependencies'
Push-Location $Dir
try { & $Bun install --production --silent; if ($LASTEXITCODE -ne 0) { Die "bun install failed in $Dir" } } finally { Pop-Location }
Ok 'done'

# ── a `codemax` command, and Bun's bin folder on the user PATH
New-Item -ItemType Directory -Force -Path $BunBin | Out-Null
$launcher = Join-Path $BunBin 'codemax.cmd'
$cli = Join-Path $Dir 'src\cli.ts'
Set-Content -Path $launcher -Encoding ASCII -Value "@echo off`r`n`"$Bun`" `"$cli`" %*"
Ok "codemax → $launcher"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $BunBin)) {
  [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $BunBin), 'User')
  Ok "Added $BunBin to your PATH"
}
if (-not (($env:Path -split ';') -contains $BunBin)) { $env:Path = "$env:Path;$BunBin" }

# ── agents already on this machine
$found = @('claude', 'codex', 'opencode', 'grok', 'agy', 'cursor-agent', 'copilot') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue }
Say ''
if ($found) { Say "  Agents found: $($found -join ' ')" }
else {
  Say '  No agent CLIs found yet. Install and log in to at least one,'
  Say '  for example Claude Code or Codex, then start codemax.'
}

Say ''
Say '  Installed. Next (in a new terminal):'
Say '    codemax doctor          # checks nothing will bill an API key'
Say '    cd your-project; codemax'
Say ''
Say '  Windows support is new. If something breaks, please open an issue:'
Say '  https://github.com/SkidGod4444/codemax-cli/issues'
Say ''
