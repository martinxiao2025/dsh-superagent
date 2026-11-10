param(
  [ValidateSet('prepare', 'cleanup')]
  [string]$Phase = 'prepare',
  [int]$PollSeconds = 90
)
# U8 桌面版执行页分组取证：prepare 停止桌面版、注入演示工单、重启并输出带 token 的面板地址；
# cleanup 删除演示工单并重启桌面版。证据写入本目录的 runtime.json / cleanup.json / tickets.json。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = 'C:\Users\61054\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$stateDir = 'C:\Users\61054\.dsh\state\superagent'
$inject = Join-Path $here 'inject-demo-tickets.mjs'

function Save([string]$name, $value) {
  $value | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $here $name) -Encoding utf8
}
function Stop-App {
  Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 1500
}
function Api([string]$method, [string]$path) {
  $url = "http://127.0.0.1:$script:port/orchestrator/api/$path"
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method), $url)
  [void]$request.Headers.Add('x-orchestrator-request', '1')
  $response = $script:client.SendAsync($request).Result
  return [ordered]@{ status = [int]$response.StatusCode; body = $response.Content.ReadAsStringAsync().Result }
}
# 从桌面版标准输出日志读取带 token 的面板地址；日志没有时退回端口探测。
function Find-Port([string]$log, [datetime]$since) {
  $deadline = (Get-Date).AddSeconds($PollSeconds)
  $before = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort })
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $log) {
      $found = Select-String -Path $log -Pattern 'http://127\.0\.0\.1:(\d+)/\?token=(\S+)' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) {
        return [ordered]@{ port = $found.Matches[0].Groups[1].Value; token = $found.Matches[0].Groups[2].Value
          url = "http://127.0.0.1:$($found.Matches[0].Groups[1].Value)/?token=$($found.Matches[0].Groups[2].Value)" }
      }
    }
    foreach ($listener in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
      if ($before -contains $listener.LocalPort) { continue }
      if (@('127.0.0.1', '0.0.0.0', '::1', '::') -notcontains $listener.LocalAddress) { continue }
      try {
        $probe = [System.Net.Http.HttpClient]::new()
        $probe.Timeout = [TimeSpan]::FromSeconds(1)
        [void]$probe.DefaultRequestHeaders.Add('x-orchestrator-request', '1')
        $r = $probe.GetAsync("http://127.0.0.1:$($listener.LocalPort)/orchestrator/api/health").Result
        $probe.Dispose()
        if ([int]$r.StatusCode -eq 200) { return [ordered]@{ port = [string]$listener.LocalPort; token = ''; url = '' } }
      } catch {}
    }
    Start-Sleep -Milliseconds 300
  }
  throw "未在 $PollSeconds 秒内发现桌面版 Web 端口"
}
# 启动桌面版并等待健康接口 ready。
function Start-App {
  $log = Join-Path $env:TEMP "dsh-u6-u8-$Phase.out.log"
  $err = Join-Path $env:TEMP "dsh-u6-u8-$Phase.err.log"
  Remove-Item $log, $err -ErrorAction SilentlyContinue
  $started = Get-Date
  $app = Start-Process -FilePath $exe -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
  $found = Find-Port $log $started
  $script:port = $found.port
  $deadline = (Get-Date).AddSeconds($PollSeconds)
  $health = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Api 'GET' 'health'
      if (($health.body | ConvertFrom-Json).phase -eq 'ready') { break }
    } catch {}
    Start-Sleep -Milliseconds 300
  }
  return [ordered]@{ pid = $app.Id; port = $found.port; token = $found.token; url = $found.url; log = $log
    healthStatus = $health.status; health = ($health.body | ConvertFrom-Json) }
}

$result = [ordered]@{ phase = $Phase; startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  stateDir = $stateDir; workspaceHash = (Get-FileHash 'D:\dsh-superagent\lib\index.js' -Algorithm SHA256).Hash }
$script:port = $null
$script:client = [System.Net.Http.HttpClient]::new()
$script:client.Timeout = [TimeSpan]::FromSeconds(10)
try {
  Stop-App
  $injectOutput = node --no-warnings $inject $Phase 2>&1 | Out-String
  $injectExit = $LASTEXITCODE
  $injectText = $injectOutput.Trim()
  $result.inject = [ordered]@{ exit = $injectExit; output = if ($injectExit -eq 0) { $injectText | ConvertFrom-Json } else { $injectText } }
  if ($injectExit -ne 0) { throw "演示工单注入失败：$injectText" }
  $result.start = Start-App
  if ($result.start.healthStatus -ne 200 -or $result.start.health.phase -ne 'ready') { throw '健康接口未就绪' }
  $tickets = Api 'GET' 'tickets?state=open&limit=50'
  Save $(if ($Phase -eq 'prepare') { 'tickets.json' } else { 'tickets-after-cleanup.json' }) $tickets
  $items = @(($tickets.body | ConvertFrom-Json).items)
  $result.tickets = [ordered]@{ status = $tickets.status; count = $items.Count
    groups = @($items | Group-Object project | ForEach-Object { [ordered]@{ project = if ($_.Name) { $_.Name } else { '(unassigned)' }; count = $_.Count } }) }
  if ($Phase -eq 'prepare') {
    if ($items.Count -ne 5) { throw "预期 5 张演示工单，实际 $($items.Count)" }
    if (@($items | Where-Object { -not $_.project }).Count -ne 1) { throw '预期 1 张未分配工单' }
    Save 'runtime.json' $result
  } else {
    if ($items.Count -ne 0) { throw "清理后仍有 $($items.Count) 张演示工单" }
    Save 'cleanup.json' $result
  }
  $result.ok = $true
} catch {
  $result.ok = $false
  $result.error = $_.Exception.Message
  $result.errorStack = $_.ScriptStackTrace
  Save $(if ($Phase -eq 'prepare') { 'runtime.json' } else { 'cleanup.json' }) $result
} finally {
  if ($null -ne $script:client) { $script:client.Dispose() }
  $result.finishedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  if ($null -eq $result.ok) { $result.ok = $false }
  if ($Phase -eq 'prepare') { Save 'runtime.json' $result } else { Save 'cleanup.json' $result }
  $result | ConvertTo-Json -Depth 12
}
