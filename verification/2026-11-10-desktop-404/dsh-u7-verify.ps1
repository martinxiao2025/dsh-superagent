param(
  [int]$PauseSeconds = 0,
  [string]$Tag = 'run',
  [int]$PollSeconds = 75,
  [int]$FakeLockSeconds = 0
)
# U7 桌面观测：强制结束实例后立即启动，轮询健康接口记录启动阶段，并写出一份 JSON 结果。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$exe = 'C:\Users\61054\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$stateDir = 'C:\Users\61054\.dsh\state\superagent'
$lock = "$stateDir.lock"
$log = Join-Path $env:TEMP "dsh-u7-$Tag.out.log"
$err = Join-Path $env:TEMP "dsh-u7-$Tag.err.log"
$out = Join-Path $env:TEMP "dsh-u7-$Tag.json"
Remove-Item $log, $err -ErrorAction SilentlyContinue

function Stamp($file) { if (Test-Path $file) { (Get-Item $file).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss.fff') } else { 'absent' } }
function StartupPhase($file) {
  if (-not (Test-Path $file)) { return 'absent' }
  try { return (Get-Content $file -Raw | ConvertFrom-Json).phase } catch { return 'unreadable' }
}

$lockBefore = Stamp $lock
Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
$tKill = Get-Date
Start-Sleep -Milliseconds 800
$lockAfterKill = Stamp $lock
if ($PauseSeconds -gt 0) { Start-Sleep -Seconds $PauseSeconds }
$fakeLock = $FakeLockSeconds -gt 0
if ($fakeLock) {
  # 模拟“另一个实例持有新鲜锁”：proper-lockfile 的锁是同级目录，新鲜时下一次取锁立即 ELOCKED。
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  New-Item -ItemType Directory -Force -Path $lock | Out-Null
  (Get-Item $lock).LastWriteTime = Get-Date
}
$proc = Start-Process -FilePath $exe -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
$tStart = Get-Date
$timer = [System.Diagnostics.Stopwatch]::StartNew()

$port = $null
$timeline = New-Object System.Collections.ArrayList
$startupTimeline = New-Object System.Collections.ArrayList
$last = ''
$lastStartup = ''
$fakeRemoved = -not $fakeLock
$beforePorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort })
$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(3)
[void]$client.DefaultRequestHeaders.Add('x-orchestrator-request', '1')
$probe = [System.Net.Http.HttpClient]::new()
$probe.Timeout = [TimeSpan]::FromSeconds(1)
[void]$probe.DefaultRequestHeaders.Add('x-orchestrator-request', '1')
$stop = (Get-Date).AddSeconds($PollSeconds)
while ((Get-Date) -lt $stop) {
  $elapsed = [int]$timer.Elapsed.TotalMilliseconds
  # 启动记录与 Web 端口无关，能在 Web 服务器可用之前证明插件停在哪个阶段。
  $current = StartupPhase (Join-Path $stateDir 'startup.json')
  $previous = StartupPhase (Join-Path $stateDir 'startup.prev.json')
  $startupKey = "$current|$previous"
  if ($startupKey -ne $lastStartup) {
    [void]$startupTimeline.Add([ordered]@{ ms = $elapsed; at = (Stamp (Join-Path $stateDir 'startup.json')); phase = $current
      previous = $previous; previousAt = (Stamp (Join-Path $stateDir 'startup.prev.json')) })
    $lastStartup = $startupKey
  }
  if (-not $fakeRemoved -and $timer.Elapsed.TotalSeconds -ge $FakeLockSeconds) {
    Remove-Item $lock -Force -Recurse -ErrorAction SilentlyContinue
    $fakeRemoved = $true
  }
  if (-not $port -and (Test-Path $log)) {
    $found = Select-String -Path $log -Pattern 'http://127\.0\.0\.1:(\d+)/\?token=' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $port = $found.Matches[0].Groups[1].Value }
  }
  if (-not $port) {
    # URL 日志要等后端就绪才出现；启动早期改为探测新出现的本地监听端口。
    $candidates = New-Object System.Collections.ArrayList
    $appPids = New-Object System.Collections.ArrayList
    foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
      try {
        if ($p.StartTime -ge $tStart.AddSeconds(-2) -and @('DeepSeek Harness', 'node') -contains $p.ProcessName) { [void]$appPids.Add($p.Id) }
      } catch {}
    }
    foreach ($listener in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
      if ($appPids -notcontains $listener.OwningProcess) { continue }
      if ($beforePorts -contains $listener.LocalPort) { continue }
      if (@('127.0.0.1', '0.0.0.0', '::1', '::') -notcontains $listener.LocalAddress) { continue }
      if (-not $candidates.Contains($listener.LocalPort)) { [void]$candidates.Add($listener.LocalPort) }
    }
    foreach ($candidate in $candidates) {
      try {
        $first = $probe.GetAsync("http://127.0.0.1:$candidate/orchestrator/api/health").Result
        $port = [string]$candidate
        $code = [int]$first.StatusCode
        $body = $first.Content.ReadAsStringAsync().Result
        $json = $null
        try { $json = $body | ConvertFrom-Json } catch {}
        $phase = ''
        if ($null -ne $json -and $null -ne $json.phase) { $phase = [string]$json.phase }
        [void]$timeline.Add([ordered]@{ ms = $elapsed; status = $code; phase = $phase; ok = $null; detail = 'first response (port discovered)' })
        $last = "$code|$phase"
        break
      } catch {}
    }
  }
  if ($port) {
    try {
      $resp = $client.GetAsync("http://127.0.0.1:$port/orchestrator/api/health").Result
      $code = [int]$resp.StatusCode
      $body = $resp.Content.ReadAsStringAsync().Result
      $json = $null
      try { $json = $body | ConvertFrom-Json } catch {}
      $phase = ''
      if ($null -ne $json -and $null -ne $json.phase) { $phase = [string]$json.phase }
      $key = "$code|$phase"
      if ($key -ne $last) {
        $okValue = $null
        $detailValue = ''
        if ($null -ne $json) { $okValue = $json.ok; $detailValue = [string]$json.detail }
        [void]$timeline.Add([ordered]@{ ms = $elapsed; status = $code; phase = $phase; ok = $okValue; detail = $detailValue })
        $last = $key
      }
      if ($phase -eq 'ready') { break }
    } catch {
      $key = 'error|'
      if ($key -ne $last) { [void]$timeline.Add([ordered]@{ ms = $elapsed; status = 0; phase = ''; ok = $null; detail = 'request did not answer' }); $last = $key }
    }
  }
  Start-Sleep -Milliseconds 300
}
# 最终状态：state 与 health 的状态码（ready 后 state 应为 200）。
foreach ($path in @('health', 'state')) {
  try {
    $resp = $client.GetAsync("http://127.0.0.1:$port/orchestrator/api/$path").Result
    $code = [int]$resp.StatusCode
    $body = $resp.Content.ReadAsStringAsync().Result
  } catch { $code = 0; $body = '' }
  if ($path -eq 'health') {
    $healthStatus = $code
    $healthBody = $body
  } else {
    $stateStatus = $code
    $stateBody = $body
  }
}
$client.Dispose()

$healthBodyText = ''
$stateBodyLength = 0
if ($null -ne $healthBody) { $healthBodyText = $healthBody.Substring(0, [Math]::Min(400, $healthBody.Length)) }
if ($null -ne $stateBody) { $stateBodyLength = $stateBody.Length }
$result = [ordered]@{
  tag = $Tag
  buildHash = (Get-FileHash 'D:\dsh-superagent\lib\index.js' -Algorithm SHA256).Hash.Substring(0, 16)
  buildAt = (Get-Item 'D:\dsh-superagent\lib\index.js').LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
  killAt = $tKill.ToString('HH:mm:ss.fff')
  startAt = $tStart.ToString('HH:mm:ss.fff')
  startDelayMs = [int](($tStart - $tKill).TotalMilliseconds)
  pauseSeconds = $PauseSeconds
  lockBefore = $lockBefore
  lockAfterKill = $lockAfterKill
  fakeLock = $fakeLock
  fakeLockRemoved = $fakeRemoved
  port = $port
  exited = $proc.HasExited
  timeline = $timeline
  startupTimeline = $startupTimeline
  healthStatus = $healthStatus
  healthBody = $healthBodyText
  stateStatus = $stateStatus
  stateBodyLength = $stateBodyLength
  startupPhase = StartupPhase (Join-Path $stateDir 'startup.json')
  startupPrevPhase = StartupPhase (Join-Path $stateDir 'startup.prev.json')
  lockAfterStart = Stamp $lock
}
$result | ConvertTo-Json -Depth 6
$result | ConvertTo-Json -Depth 6 | Set-Content -Path $out -Encoding utf8
Write-Output '--- out.log ---'
if (Test-Path $log) { Get-Content $log -Tail 8 }
Write-Output '--- err.log ---'
if (Test-Path $err) { Get-Content $err -Tail 8 }
