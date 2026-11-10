param(
  [ValidateSet('install', 'restore')]
  [string]$Phase = 'install',
  [string]$Tgz = 'D:\dsh-superagent\.artifacts\u6-u8\dsh-superagent-0.1.0.tgz',
  [int]$PollSeconds = 90
)
# U9 真实 tgz 安装取证：
#   install —— 停桌面版、把工作区 Junction 换成真实 tgz、注入演示工单、重启并输出面板地址（保持运行以便截图）；
#   restore —— 删除演示工单、恢复 Junction 安装、重启并记录还原结果。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = 'C:\Users\61054\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$profileDir = 'C:\Users\61054\.dsh\profiles\desktop'
$moduleDir = Join-Path $profileDir 'node_modules\dsh-superagent'
$packageFile = Join-Path $profileDir 'package.json'
$lockFile = Join-Path $profileDir 'pnpm-lock.yaml'
$inject = Join-Path $here '..\2026-11-10-u6-u8\inject-demo-tickets.mjs'
$packageBackup = Join-Path $here 'package.json.before'
$workspaceHash = (Get-FileHash 'D:\dsh-superagent\lib\index.js' -Algorithm SHA256).Hash

function Save([string]$name, $value) {
  $value | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $here $name) -Encoding utf8
}
function Stop-App {
  Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 1500
}
function Api([string]$method, [string]$path) {
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method),
    "http://127.0.0.1:$script:port/orchestrator/api/$path")
  [void]$request.Headers.Add('x-orchestrator-request', '1')
  $response = $script:client.SendAsync($request).Result
  return [ordered]@{ status = [int]$response.StatusCode; body = $response.Content.ReadAsStringAsync().Result }
}
# 从桌面版标准输出读取带 token 的面板地址，找不到时退回端口探测。
function Find-Port([string]$log) {
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
    Start-Sleep -Milliseconds 300
  }
  throw "未在 $PollSeconds 秒内发现桌面版 Web 端口"
}
# 启动桌面版并等待健康接口 ready，返回端口与 token。
function Start-App([string]$tag) {
  $log = Join-Path $env:TEMP "dsh-u9-$tag.out.log"
  $err = Join-Path $env:TEMP "dsh-u9-$tag.err.log"
  Remove-Item $log, $err -ErrorAction SilentlyContinue
  $app = Start-Process -FilePath $exe -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
  $found = Find-Port $log
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
# 运行注入脚本并返回其 JSON 输出。
function Inject([string]$mode) {
  $text = (node --no-warnings $inject $mode 2>&1 | Out-String).Trim()
  $exit = $LASTEXITCODE
  if ($exit -ne 0) { throw "演示工单注入失败（$mode，exit $exit）：$text" }
  return ($text | ConvertFrom-Json)
}

$result = [ordered]@{ phase = $Phase; startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); workspaceHash = $workspaceHash }
$script:port = $null
$script:client = [System.Net.Http.HttpClient]::new()
$script:client.Timeout = [TimeSpan]::FromSeconds(10)
try {
  Stop-App
  if ($Phase -eq 'install') {
    if (-not (Test-Path $Tgz)) { throw "未找到 tgz：$Tgz" }
    $result.tgz = [ordered]@{ path = $Tgz; bytes = (Get-Item $Tgz).Length; hash = (Get-FileHash $Tgz -Algorithm SHA256).Hash }
    $original = Get-Item $moduleDir
    $result.original = [ordered]@{ linkType = [string]$original.LinkType; target = [string]$original.Target
      lockFile = (Test-Path $lockFile); packageJson = (Get-Content $packageFile -Raw) }
    Copy-Item $packageFile $packageBackup -Force
    # 1. 用真实 tgz 替换 Junction 安装。
    (Get-Item $moduleDir).Delete()
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    $addOut = pnpm --dir $profileDir add "file:$($Tgz.Replace('\', '/'))" --offline --ignore-scripts 2>&1 | Out-String
    $result.installCommand = [ordered]@{ exit = $LASTEXITCODE; output = $addOut.Trim() }
    if ($LASTEXITCODE -ne 0) { throw "pnpm add tgz 失败：$($addOut.Trim())" }
    $installed = Get-Item $moduleDir
    $installedHash = (Get-FileHash (Join-Path $moduleDir 'lib\index.js') -Algorithm SHA256).Hash
    $result.install = [ordered]@{ linkType = [string]$installed.LinkType; target = [string]$installed.Target
      version = ((Get-Content (Join-Path $moduleDir 'package.json') -Raw | ConvertFrom-Json).version)
      libHash = $installedHash; matchesWorkspace = $installedHash -eq $workspaceHash
      dependency = ((Get-Content $packageFile -Raw | ConvertFrom-Json).dependencies.'dsh-superagent') }
    if ($installed.LinkType) { throw "安装后仍是链接：$($installed.LinkType)" }
    if ($installedHash -ne $workspaceHash) { throw 'tgz 内 lib/index.js 与工作区构建哈希不一致' }
    # 2. 注入演示工单，再启动桌面版读取真实接口。
    $result.inject = Inject 'prepare'
    $result.start = Start-App 'install'
    if ($result.start.healthStatus -ne 200 -or $result.start.health.phase -ne 'ready') { throw '健康接口未就绪' }
    $tickets = Api 'GET' 'tickets?state=open&limit=50'
    Save 'tickets.json' $tickets
    $items = @(($tickets.body | ConvertFrom-Json).items)
    $result.tickets = [ordered]@{ status = $tickets.status; count = $items.Count
      groups = @($items | Group-Object project | ForEach-Object { [ordered]@{ project = if ($_.Name) { $_.Name } else { '(unassigned)' }; count = $_.Count } })
      directories = @($items | ForEach-Object { $_.directory }) }
    if ($items.Count -ne 5) { throw "预期 5 张演示工单，实际 $($items.Count)" }
    if (@($items | Where-Object { -not $_.project }).Count -ne 1) { throw '预期 1 张未分配工单' }
    Save 'runtime.json' $result
  } else {
    # 3. 清理演示数据并恢复 Junction 安装。
    $result.cleanup = Inject 'cleanup'
    if (Test-Path $moduleDir) { Remove-Item $moduleDir -Recurse -Force }
    Copy-Item $packageBackup $packageFile -Force
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    $restoreOut = pnpm --dir $profileDir install --offline --ignore-scripts 2>&1 | Out-String
    if (Test-Path $moduleDir) { (Get-Item $moduleDir).Delete() }
    New-Item -ItemType Junction -Path $moduleDir -Target 'D:\dsh-superagent' | Out-Null
    $restored = Get-Item $moduleDir
    $result.restore = [ordered]@{ exit = $LASTEXITCODE; output = $restoreOut.Trim()
      linkType = [string]$restored.LinkType; target = [string]$restored.Target
      libHash = (Get-FileHash 'D:\dsh-superagent\lib\index.js' -Algorithm SHA256).Hash
      packageJson = (Get-Content $packageFile -Raw) }
    if ($restored.LinkType -ne 'Junction') { throw "还原后不是 Junction：$($restored.LinkType)" }
    $result.start = Start-App 'restore'
    if ($result.start.healthStatus -ne 200 -or $result.start.health.phase -ne 'ready') { throw '还原后健康接口未就绪' }
    $tickets = Api 'GET' 'tickets?state=open&limit=50'
    Save 'tickets-after-cleanup.json' $tickets
    $result.tickets = [ordered]@{ status = $tickets.status; count = @((($tickets.body | ConvertFrom-Json).items)).Count }
    if ($result.tickets.count -ne 0) { throw "清理后仍有 $($result.tickets.count) 张演示工单" }
    Save 'restore.json' $result
  }
  $result.ok = $true
} catch {
  $result.ok = $false
  $result.error = $_.Exception.Message
  $result.errorStack = $_.ScriptStackTrace
} finally {
  if ($null -ne $script:client) { $script:client.Dispose() }
  $result.finishedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  if ($null -eq $result.ok) { $result.ok = $false }
  Save $(if ($Phase -eq 'install') { 'runtime.json' } else { 'restore.json' }) $result
  $result | ConvertTo-Json -Depth 12
}
