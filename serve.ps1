# Local server for AI Paper Trading: static files + state API (http://localhost:8787)
#   GET  /api/state            -> {"engine":{"id":..,"age":ms},"state":<saved state or null>}
#   PUT  /api/state?id=X[&force=1]  save state (only the current engine may write; 409 otherwise)
#   GET/PUT /api/settings      shared settings
#   POST /api/cmd              queue a command for the engine (from dashboard viewers)
#   GET  /api/cmd?id=X         engine takes queued commands
#   POST /api/release?id=X     engine releases its lock
param([int]$Port = 8787, [switch]$NoBrowser)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force $dataDir | Out-Null
$stateFile = Join-Path $dataDir 'state.json'
$settingsFile = Join-Path $dataDir 'settings.json'
$utf8 = New-Object System.Text.UTF8Encoding $false

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "AI Paper Trading server running: http://localhost:$Port  (Ctrl+C to stop)"
if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.png' = 'image/png'; '.ico' = 'image/x-icon' }
$script:lockId = ''
$script:lockTime = [datetime]::MinValue
$script:cmds = New-Object System.Collections.ArrayList

function Send-Text($res, [int]$code, [string]$text, [string]$type = 'application/json; charset=utf-8') {
  $bytes = $utf8.GetBytes($text)
  $res.StatusCode = $code
  $res.ContentType = $type
  $res.Headers.Add('Cache-Control', 'no-store')
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}
function Read-Body($req) {
  $sr = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
  $b = $sr.ReadToEnd(); $sr.Close(); return $b
}
function Read-File([string]$path) {
  if (Test-Path $path) { return [System.IO.File]::ReadAllText($path, $utf8) } else { return 'null' }
}
function Write-FileAtomic([string]$path, [string]$text) {
  $tmp = "$path.tmp"
  [System.IO.File]::WriteAllText($tmp, $text, $utf8)
  Move-Item -Force $tmp $path
}
function Lock-Age() {
  if ($script:lockId -eq '') { return -1 }
  return [int]((Get-Date) - $script:lockTime).TotalMilliseconds
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
      $id = $req.QueryString['id']
      if ($path -eq 'api/ping') {
        Send-Text $res 200 '{"ok":true}'
      } elseif ($path -eq 'api/state' -and $req.HttpMethod -eq 'GET') {
        $eng = '{"id":"' + $script:lockId + '","age":' + (Lock-Age) + '}'
        Send-Text $res 200 ('{"engine":' + $eng + ',"state":' + (Read-File $stateFile) + '}')
      } elseif ($path -eq 'api/state' -and $req.HttpMethod -eq 'PUT') {
        $force = $req.QueryString['force'] -eq '1'
        $age = Lock-Age
        if (-not $force -and $script:lockId -ne '' -and $script:lockId -ne $id -and $age -lt 20000) {
          Send-Text $res 409 ('{"error":"locked","engine":"' + $script:lockId + '"}')
        } else {
          $body = Read-Body $req
          if ($body.Length -gt 2) { Write-FileAtomic $stateFile $body }
          $script:lockId = $id
          $script:lockTime = Get-Date
          Send-Text $res 200 '{"ok":true}'
        }
      } elseif ($path -eq 'api/release' -and $req.HttpMethod -eq 'POST') {
        if ($script:lockId -eq $id) { $script:lockId = '' }
        Send-Text $res 200 '{"ok":true}'
      } elseif ($path -eq 'api/settings' -and $req.HttpMethod -eq 'GET') {
        Send-Text $res 200 (Read-File $settingsFile)
      } elseif ($path -eq 'api/settings' -and $req.HttpMethod -eq 'PUT') {
        Write-FileAtomic $settingsFile (Read-Body $req)
        Send-Text $res 200 '{"ok":true}'
      } elseif ($path -eq 'api/cmd' -and $req.HttpMethod -eq 'POST') {
        [void]$script:cmds.Add((Read-Body $req))
        Send-Text $res 200 '{"ok":true}'
      } elseif ($path -eq 'api/cmd' -and $req.HttpMethod -eq 'GET') {
        if ($id -ne '' -and $id -eq $script:lockId) {
          $out = '[' + ($script:cmds -join ',') + ']'
          $script:cmds.Clear()
        } else { $out = '[]' }
        Send-Text $res 200 $out
      } else {
        if ($path -eq '') { $path = 'index.html' }
        $file = [System.IO.Path]::GetFullPath((Join-Path $root $path))
        if ($file.StartsWith($root) -and -not $file.StartsWith($dataDir) -and (Test-Path $file -PathType Leaf)) {
          $bytes = [System.IO.File]::ReadAllBytes($file)
          $ext = [System.IO.Path]::GetExtension($file).ToLower()
          $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
          $res.Headers.Add('Cache-Control', 'no-cache')
          $res.ContentLength64 = $bytes.Length
          if ($req.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
        } else {
          $res.StatusCode = 404
        }
      }
    } catch {
      Write-Host "request error: $($_.Exception.Message)"
      try { $res.StatusCode = 500 } catch {}
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
