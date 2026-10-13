# stoned-mango: run a setup or training step inside WSL (Ubuntu) on Windows 11.
# Started by the *-windows.cmd files in the project folder (setup, train, calibrate, library, timeline).
# ASCII only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
param(
    [Parameter(Mandatory = $true)][ValidateSet('setup', 'train', 'calibrate', 'library', 'timeline', 'world')][string]$Step,
    [string]$MusicDir = ''
)
# 'Continue', not 'Stop': in Windows PowerShell 5.1 a native command writing to stderr would
# otherwise abort the script. Exit codes are checked explicitly instead.
$ErrorActionPreference = 'Continue'
$Distro = 'Ubuntu-24.04'
$RepoWin = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# Keep a record of every run in results\, created before anything else can fail.
$Results = Join-Path $RepoWin 'results'
New-Item -ItemType Directory -Force -Path $Results | Out-Null
$WinLog = Join-Path $Results ("$Step-windows-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Start-Transcript -Path $WinLog -Append | Out-Null

function Say([string]$Message, [string]$Color = 'Cyan') { Write-Host ""; Write-Host "== $Message" -ForegroundColor $Color }
function Fail([string]$Message) {
    Say $Message 'Red'
    Say "A log of this run is in: $WinLog" 'Yellow'
    Stop-Transcript | Out-Null
    exit 1
}
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

Say "stoned-mango $Step (project folder: $RepoWin)"
Write-Host ("Windows " + [Environment]::OSVersion.Version + ", PowerShell " + $PSVersionTable.PSVersion)

# 1. NVIDIA driver. WSL uses the normal Windows driver; nothing CUDA-related is installed inside Linux.
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $smi) {
    Fail "No NVIDIA driver found. Install the latest GeForce driver from https://www.nvidia.com/Download/index.aspx (or the NVIDIA app), restart, then run this again."
}
& nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader

# 2. WSL with Ubuntu.
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
$distros = @()
if ($wsl) {
    $raw = & wsl.exe --list --quiet 2>$null
    if ($LASTEXITCODE -eq 0 -and $raw) { $distros = @($raw | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ }) }
}
Write-Host ("WSL distributions found: " + ($(if ($distros) { $distros -join ', ' } else { 'none' })))
if ($distros -notcontains $Distro) {
    if (-not (Test-Admin)) {
        Say 'Ubuntu (WSL) is not installed yet. Windows will ask for administrator permission to install it.' 'Yellow'
        Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Step $Step"
        Say 'A second window (administrator) continues the installation. Follow it, then run this file again.' 'Yellow'
        Stop-Transcript | Out-Null
        exit 0
    }
    Say "Installing WSL and $Distro. This downloads about 500 MB." 'Yellow'
    & wsl.exe --install -d $Distro
    Say "When Ubuntu opens, it asks you to choose a Linux username and password. Pick anything and write them down." 'Yellow'
    Say "If Windows asks you to RESTART, restart now, then double-click the same .cmd file again to continue." 'Yellow'
    Stop-Transcript | Out-Null
    Read-Host 'Press Enter to close this window'
    exit 0
}

# Always "-e" (run the program directly), never "--": with "--" the arguments pass through
# Ubuntu's shell, which eats backslashes and splits paths that contain spaces.
function Invoke-Wsl([string[]]$WslArgs) {
    & wsl.exe -d $Distro @WslArgs
    if ($LASTEXITCODE -ne 0) { Fail "The step failed inside Ubuntu (exit code $LASTEXITCODE). Scroll up for the error, or send the log file in the results folder." }
}

# 3. First contact, not captured: if Ubuntu's one-time username/password setup is still pending,
#    its questions must be visible here rather than swallowed by the captured command below.
& wsl.exe -d $Distro -- true
if ($LASTEXITCODE -ne 0) { Fail 'Could not start Ubuntu. Open "Ubuntu" from the Start menu once to finish its setup, then run this again.' }

# 4. System packages (as root, so there is no password prompt), then the project copy and the step itself.
# Where Ubuntu sees the project folder. Ask wslpath, fall back to the standard /mnt/<drive>/ mapping,
# and check that Ubuntu can really read the files there before going on.
function Test-WslFile([string]$Path) {
    & wsl.exe -d $Distro -e test -f "$Path/scripts/linux/setup.sh"
    return ($LASTEXITCODE -eq 0)
}
$fromWslpath = ((& wsl.exe -d $Distro -e wslpath -a ($RepoWin -replace '\\', '/') 2>&1) | ForEach-Object { "$_" }) -join ''
Write-Host "wslpath says: '$fromWslpath'"
$manual = '/mnt/' + $RepoWin.Substring(0, 1).ToLower() + ($RepoWin.Substring(2) -replace '\\', '/')
$RepoWsl = $null
foreach ($candidate in @($fromWslpath.Trim(), $manual)) {
    if ($candidate -and $candidate.StartsWith('/') -and (Test-WslFile $candidate)) { $RepoWsl = $candidate; break }
}
if (-not $RepoWsl) {
    Say 'Ubuntu cannot see the project folder. Details for troubleshooting:' 'Yellow'
    Write-Host "Windows folder: $RepoWin"
    Write-Host "Tried: '$($fromWslpath.Trim())' and '$manual'"
    Write-Host ('Ubuntu user: ' + ((& wsl.exe -d $Distro -e whoami 2>&1) -join ' '))
    Write-Host ('Ubuntu /mnt: ' + ((& wsl.exe -d $Distro -e ls /mnt 2>&1) -join ' '))
    Write-Host ('/etc/wsl.conf: ' + ((& wsl.exe -d $Distro -e cat /etc/wsl.conf 2>&1) -join ' | '))
    Fail 'Ubuntu could not reach the project folder (details above). Please send this log.'
}
Write-Host "Ubuntu sees the project at: $RepoWsl"
Say 'Installing Linux packages (Python, FluidSynth and its soundfont, git)...'
Invoke-Wsl @('-u', 'root', '-e', 'bash', "$RepoWsl/scripts/linux/system-packages.sh", "$RepoWsl")
Say "Running the $Step step inside Ubuntu. This window shows its progress."
$StepArgs = @('-e', 'bash', "$RepoWsl/scripts/linux/$Step.sh", "$RepoWsl")
if ($Step -eq 'library' -or ($Step -in @('timeline', 'world') -and $MusicDir.Trim().Trim('"'))) {
    # The music folder, as Ubuntu sees it (same approach as for the project folder above).
    $Music = $MusicDir.Trim().Trim('"')
    if ($Music -match '^[A-Za-z]:$') { $Music += '\' }
    if (-not $Music -or -not (Test-Path -LiteralPath $Music -PathType Container)) { Fail "Music folder not found: '$Music'" }
    $Music = (Resolve-Path -LiteralPath $Music).Path
    $musicFromWslpath = ((& wsl.exe -d $Distro -e wslpath -a ($Music -replace '\\', '/') 2>&1) | ForEach-Object { "$_" }) -join ''
    $musicManual = '/mnt/' + $Music.Substring(0, 1).ToLower() + ($Music.Substring(2) -replace '\\', '/')
    $MusicWsl = $null
    foreach ($candidate in @($musicFromWslpath.Trim(), $musicManual)) {
        if ($candidate -and $candidate.StartsWith('/')) {
            & wsl.exe -d $Distro -e test -d "$candidate"
            if ($LASTEXITCODE -eq 0) { $MusicWsl = $candidate; break }
        }
    }
    if (-not $MusicWsl) { Fail "Ubuntu cannot see the music folder '$Music' (tried '$($musicFromWslpath.Trim())' and '$musicManual')." }
    Write-Host "Ubuntu sees the music folder at: $MusicWsl"
    $StepArgs += $MusicWsl
}
Invoke-Wsl $StepArgs
Say "Done. Results are in: $Results" 'Green'
Stop-Transcript | Out-Null
