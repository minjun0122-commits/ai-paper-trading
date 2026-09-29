# Start/stop the background AI engine (hidden server + headless Edge).
#   background.ps1 start   -> start server (if needed) + headless engine
#   background.ps1 stop    -> stop engine and server
#   background.ps1 open    -> start (if needed) and open the dashboard
param([ValidateSet('start', 'stop', 'open')][string]$Action = 'open', [int]$Port = 8787)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path $root 'data\engine-profile'
$url = "http://localhost:$Port"

function Test-Server {
  try { return (Invoke-WebRequest -UseBasicParsing "$url/api/ping" -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}
function Get-EngineProcs {
  Get-CimInstance Win32_Process -Filter "name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$profileDir*" }
}
function Get-ServerProcs {
  Get-CimInstance Win32_Process -Filter "name='powershell.exe'" | Where-Object { $_.CommandLine -like '*serve.ps1*' -and $_.ProcessId -ne $PID }
}

if ($Action -eq 'stop') {
  Get-EngineProcs | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Get-ServerProcs | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Write-Host 'Background AI engine stopped.'
  exit 0
}

if (-not (Test-Server)) {
  # An older server (without the /api endpoints) may still hold the port: replace it.
  Get-ServerProcs | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Milliseconds 500
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$root\serve.ps1`"", '-NoBrowser', '-Port', $Port)
  for ($i = 0; $i -lt 20 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 500 }
}

if (-not (Get-EngineProcs)) {
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $edge) { Write-Host 'Microsoft Edge not found.'; exit 1 }
  New-Item -ItemType Directory -Force $profileDir | Out-Null
  Start-Process $edge -WindowStyle Hidden -ArgumentList @(
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    "--user-data-dir=`"$profileDir`"",
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    "$url/?engine=1")
  Write-Host 'Background AI engine started.'
} else {
  Write-Host 'Background AI engine already running.'
}

if ($Action -eq 'open') { Start-Process "$url/" }
