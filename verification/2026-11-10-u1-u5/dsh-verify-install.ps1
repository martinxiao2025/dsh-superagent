param(
  [string]$Tgz = 'D:\dsh-superagent\.artifacts\final\dsh-superagent-0.1.0.tgz',
  [int]$PollSeconds = 80,
  [string]$RecordId = 'u8-check'
)
# U8 安装验证：把真实 tgz 装进桌面 profile，启动桌面版，真实新增/删除一条来源记录，结束后恢复原 link 安装。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = 'C:\Users\61054\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$profileDir = 'C:\Users\61054\.dsh\profiles\desktop'
$moduleDir = Join-Path $profileDir 'node_modules\dsh-superagent'
$packageFile = Join-Path $profileDir 'package.json'
$lockFile = Join-Path $profileDir 'pnpm-lock.yaml'
$stateDir = 'C:\Users\61054\.dsh\state\superagent'
$log = Join-Path $env:TEMP 'dsh-u8-install.out.log'
$err = Join-Path $env:TEMP 'dsh-u8-install.err.log'
$resultFile = Join-Path $here 'install-result.json'

function Save([string]$name, $value) {
  $value | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $here $name) -Encoding utf8
}
function Stop-App {
  Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 1200
}
function Api([string]$method, [string]$path, $body = $null) {
  $url = "http://127.0.0.1:$script:port/orchestrator/api/$path"
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($method), $url)
  [void]$request.Headers.Add('x-orchestrator-request', '1')
  if ($null -ne $body) {
    $request.Content = [System.Net.Http.StringContent]::new(($body | ConvertTo-Json -Compress -Depth 8), [System.Text.Encoding]::UTF8, 'application/json')
  }
  $response = $script:client.SendAsync($request).Result
  $text = $response.Content.ReadAsStringAsync().Result
  return [ordered]@{ status = [int]$response.StatusCode; body = $text }
}
# 等待运行时重建结束：轮询健康接口直到 phase 为 ready。
function Wait-Ready([int]$seconds = 90) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { if (((Api 'GET' 'health').body | ConvertFrom-Json).phase -eq 'ready') { Start-Sleep -Milliseconds 600; return } } catch {}
    Start-Sleep -Milliseconds 500
  }
}
function Find-Port([datetime]$since) {
  $deadline = (Get-Date).AddSeconds($PollSeconds)
  $before = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalPort })
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $log) {
      $found = Select-String -Path $log -Pattern 'http://127\.0\.0\.1:(\d+)/\?token=' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) { return $found.Matches[0].Groups[1].Value }
    }
    $pids = New-Object System.Collections.ArrayList
    foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
      try { if ($p.StartTime -ge $since.AddSeconds(-2) -and @('DeepSeek Harness', 'node') -contains $p.ProcessName) { [void]$pids.Add($p.Id) } } catch {}
    }
    foreach ($listener in (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
      if ($pids -notcontains $listener.OwningProcess) { continue }
      if ($before -contains $listener.LocalPort) { continue }
      if (@('127.0.0.1', '0.0.0.0', '::1', '::') -notcontains $listener.LocalAddress) { continue }
      try {
        $probe = [System.Net.Http.HttpClient]::new()
        $probe.Timeout = [TimeSpan]::FromSeconds(1)
        [void]$probe.DefaultRequestHeaders.Add('x-orchestrator-request', '1')
        $r = $probe.GetAsync("http://127.0.0.1:$($listener.LocalPort)/orchestrator/api/health").Result
        $probe.Dispose()
        if ([int]$r.StatusCode -eq 200) { return [string]$listener.LocalPort }
      } catch {}
    }
    Start-Sleep -Milliseconds 300
  }
  throw "未在 $PollSeconds 秒内发现桌面版 Web 端口"
}

$result = [ordered]@{ startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); steps = (New-Object System.Collections.ArrayList) }
$hadLock = Test-Path $lockFile
$backup = Join-Path $env:TEMP "dsh-u8-package-backup.json"
Copy-Item $packageFile $backup -Force
$linkBefore = (Get-Item $moduleDir).LinkType
$targetBefore = (Get-Item $moduleDir).Target
$result.original = [ordered]@{
  packageJson = (Get-Content $packageFile -Raw)
  linkType = [string]$linkBefore
  target = [string]$targetBefore
  lockFile = $hadLock
  workspaceHash = (Get-FileHash 'D:\dsh-superagent\lib\index.js' -Algorithm SHA256).Hash
  tgzBytes = (Get-Item $Tgz).Length
  tgzHash = (Get-FileHash $Tgz -Algorithm SHA256).Hash
}
$script:port = $null
$script:client = [System.Net.Http.HttpClient]::new()
$script:client.Timeout = [TimeSpan]::FromSeconds(5)
$app = $null
try {
  Stop-App
  # 1. 把 link 安装换成真实 tgz 安装。
  (Get-Item $moduleDir).Delete()
  Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
  $addOut = pnpm --dir $profileDir add "file:$($Tgz.Replace('\', '/'))" --offline --ignore-scripts 2>&1 | Out-String
  [void]$result.steps.Add([ordered]@{ step = 'pnpm add tgz'; exit = $LASTEXITCODE; output = $addOut.Trim() })
  $installed = Get-Item $moduleDir
  $installedPkg = Get-Content (Join-Path $moduleDir 'package.json') -Raw | ConvertFrom-Json
  $installedHash = (Get-FileHash (Join-Path $moduleDir 'lib\index.js') -Algorithm SHA256).Hash
  $result.install = [ordered]@{
    linkType = [string]$installed.LinkType
    version = $installedPkg.version
    hash = $installedHash
    hashMatchesWorkspace = $installedHash -eq $result.original.workspaceHash
    dependency = (Get-Content $packageFile -Raw | ConvertFrom-Json).dependencies.'dsh-superagent'
  }
  if ($installed.LinkType) { throw "tgz 安装后仍是链接：$($installed.LinkType)" }
  if ($installedHash -ne $result.original.workspaceHash) { throw '安装产物哈希与工作区构建不一致' }

  # 2. 启动桌面版，等待健康接口 ready。
  Remove-Item $log, $err -ErrorAction SilentlyContinue
  $tStart = Get-Date
  $app = Start-Process -FilePath $exe -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
  $script:port = Find-Port $tStart
  $deadline = (Get-Date).AddSeconds($PollSeconds)
  $health = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Api 'GET' 'health'
      $json = $health.body | ConvertFrom-Json
      if ($json.phase -eq 'ready') { break }
    } catch {}
    Start-Sleep -Milliseconds 300
  }
  Save 'health.json' $health
  $result.start = [ordered]@{ port = $script:port; healthStatus = $health.status; health = ($health.body | ConvertFrom-Json) }
  if ($health.status -ne 200 -or ($health.body | ConvertFrom-Json).phase -ne 'ready') { throw '健康接口未就绪' }

  # 2.5 真实流水线：两个本地仓库 + 两份 CSV，验证「导入 → 工单 → 按项目命名的目录」。
  $base = 'D:\dsh-superagent\.artifacts\u1-u5'
  $projects = @(
    [ordered]@{ id = 'u1u5-demo'; repository = 'local/demo-project'; checkout = (Join-Path $base 'checkout-demo')
      tasks = (Join-Path $base 'tasks-demo.csv'); project = 'demo-project' },
    [ordered]@{ id = 'u1u5-ledger'; repository = 'local/ledger-app'; checkout = (Join-Path $base 'checkout-ledger')
      tasks = (Join-Path $base 'tasks-ledger.csv'); project = 'ledger-app' })
  $pipelineOk = $true
  # 新增记录会触发运行时重建，重建期间来源种类注册表为空；因此每步都等就绪并重试。
  foreach ($p in $projects) {
    $codeBody = [ordered]@{ kind = 'github'; id = "$($p.id)-code"; config = [ordered]@{ repository = $p.repository; cli = 'gh'; instanceUrl = '' } }
    $code = $null
    for ($i = 0; $i -lt 8; $i++) {
      $code = Api 'POST' 'sources' $codeBody
      if ($code.status -eq 200) { break }
      Start-Sleep -Seconds 3
    }
    Wait-Ready 90
    $lineBody = [ordered]@{ kind = 'pipeline'; id = $p.id; config = [ordered]@{
        codeSource = "$($p.id)-code"; remoteUrl = $p.checkout; branch = ''; directory = (Join-Path $base "work-$($p.project)")
        taskKind = 'excel'; taskFile = $p.tasks; taskSheet = ''; intervalMinutes = 1; runOnStart = $true
        concurrency = 2; maxRetries = 0 } }
    $line = $null
    for ($i = 0; $i -lt 8; $i++) {
      $line = Api 'POST' 'sources' $lineBody
      if ($line.status -eq 200) { break }
      Start-Sleep -Seconds 3
    }
    [void]$result.steps.Add([ordered]@{ step = "pipeline $($p.id)"; codeStatus = $code.status; code = ($code.body | ConvertFrom-Json)
      pipelineStatus = $line.status; pipeline = ($line.body | ConvertFrom-Json) })
    if ($code.status -ne 200 -or $line.status -ne 200) { $pipelineOk = $false }
  }
  Wait-Ready 120
  # 等流水线开单：每 2 秒读一次开放工单，直到两个项目都出现工单。
  $deadline = (Get-Date).AddSeconds(180)
  $tickets = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $sample = Api 'GET' 'tickets?state=open&limit=50'
    if ($sample.status -ne 200) { continue }
    $tickets = $sample.body | ConvertFrom-Json
    $dirs = @($tickets.items | ForEach-Object { $_.directory })
    if (($dirs -join ' ') -match 'demo-project' -and ($dirs -join ' ') -match 'ledger-app') { break }
  }
  Save 'tickets.json' $tickets
  $dirs = @(($tickets | Select-Object -ExpandProperty items) | ForEach-Object { $_.directory })
  $result.pipeline = [ordered]@{ ok = $pipelineOk; ticketCount = $dirs.Count; directories = $dirs
    demoProject = (@($dirs | Where-Object { $_ -match 'demo-project$' }).Count)
    ledgerApp = (@($dirs | Where-Object { $_ -match 'ledger-app$' }).Count) }
  $healthAfter = Api 'GET' 'health'
  Save 'health-after-pipeline.json' $healthAfter

  $state = Api 'GET' 'state'
  Save 'state-before.json' $state
  $settingsBefore = Api 'GET' 'settings'
  Save 'settings-before.json' $settingsBefore
  $sourcesBefore = Api 'GET' 'sources'
  Save 'sources-before.json' $sourcesBefore
  $settingsJson = $settingsBefore.body | ConvertFrom-Json
  $idsBefore = @($settingsJson.sources | ForEach-Object { $_.id })
  [void]$result.steps.Add([ordered]@{ step = 'baseline'; stateStatus = $state.status; settingsStatus = $settingsBefore.status
    sourcesStatus = $sourcesBefore.status; sourceIds = $idsBefore; kinds = @($settingsJson.kinds | ForEach-Object { $_.kind }) })

  # 3. 真实新增来源记录。
  $createBody = [ordered]@{ kind = 'github'; id = $RecordId; config = [ordered]@{ repository = 'u8-check/probe'; cli = 'gh'; instanceUrl = '' } }
  $create = Api 'POST' 'sources' $createBody
  Save 'create.json' $create
  # 新增会触发运行时重建；等记录真正进入运行态再取样，避免记录到重建中间态。
  $deadline = (Get-Date).AddSeconds(25)
  $settingsAfterCreate = $null
  $sourcesAfterCreate = $null
  $record = $null
  $statusAfterCreate = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $settingsAfterCreate = Api 'GET' 'settings'
    $sourcesAfterCreate = Api 'GET' 'sources'
    $record = (($settingsAfterCreate.body | ConvertFrom-Json).sources | Where-Object { $_.id -eq $RecordId } | Select-Object -First 1)
    $statusAfterCreate = @($sourcesAfterCreate.body | ConvertFrom-Json) | Where-Object { $_.id -eq $RecordId } | Select-Object -First 1
    if ($null -ne $record -and $record.installed -and $null -ne $statusAfterCreate) { break }
  }
  Save 'settings-after-create.json' $settingsAfterCreate
  Save 'sources-after-create.json' $sourcesAfterCreate
  $result.add = [ordered]@{ request = $createBody; status = $create.status; response = ($create.body | ConvertFrom-Json)
    presentInSettings = $null -ne $record; settingsRecord = $record; runtimeStatus = $statusAfterCreate }
  if ($create.status -ne 200 -or $null -eq $record -or -not $record.installed) { throw '新增来源后未进入运行态' }

  # 4. 真实删除来源记录。
  $delete = Api 'DELETE' "sources/$RecordId"
  Save 'delete.json' $delete
  $settingsAfterDelete = Api 'GET' 'settings'
  Save 'settings-after-delete.json' $settingsAfterDelete
  $sourcesAfterDelete = Api 'GET' 'sources'
  Save 'sources-after-delete.json' $sourcesAfterDelete
  $deleted = $settingsAfterDelete.body | ConvertFrom-Json
  $result.remove = [ordered]@{ status = $delete.status; response = ($delete.body | ConvertFrom-Json)
    presentInSettings = @($deleted.sources | Where-Object { $_.id -eq $RecordId }).Count -gt 0
    presentInStatus = @((@($sourcesAfterDelete.body | ConvertFrom-Json)) | Where-Object { $_.id -eq $RecordId }).Count -gt 0 }
  if ($delete.status -ne 200 -or $result.remove.presentInSettings -or $result.remove.presentInStatus) { throw '删除来源后仍能看到该记录' }

  # 5. 不存在的记录返回 400（`sourceNotInstalled`），与用户错误类别一致。
  $missing = Api 'DELETE' "sources/$RecordId"
  Save 'delete-missing.json' $missing
  $result.removeMissingStatus = $missing.status
  if ($missing.status -ne 400) { throw "重复删除应返回 400，实际 $($missing.status)" }

  # 6. 清理本次验证创建的流水线与代码来源记录，避免污染用户配置。
  $cleanup = @()
  foreach ($p in $projects) {
    $cleanup += [ordered]@{ id = $p.id; status = (Api 'DELETE' "sources/$($p.id)").status }
    Start-Sleep -Milliseconds 400
    $cleanup += [ordered]@{ id = "$($p.id)-code"; status = (Api 'DELETE' "sources/$($p.id)-code").status }
    Start-Sleep -Milliseconds 400
  }
  $result.cleanup = $cleanup

  $result.ok = $true
} catch {
  $result.ok = $false
  $result.error = $_.Exception.Message
  $result.errorStack = $_.ScriptStackTrace
} finally {
  $client = $script:client
  if ($null -ne $client) { $client.Dispose() }
  Stop-App
  # 6. 恢复原 link 安装：删除 tgz 目录、还原 package.json，再用 pnpm 重新生成依赖，最后重建指向工作区的 junction。
  try {
    if (Test-Path $moduleDir) { Remove-Item $moduleDir -Recurse -Force }
    Copy-Item $backup $packageFile -Force
    # 锁文件里的 tgz specifier 与还原后的 link 不一致，先删除再安装。
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    $restoreOut = pnpm --dir $profileDir install --offline --ignore-scripts 2>&1 | Out-String
    if (-not $hadLock -and (Test-Path $lockFile)) { Remove-Item $lockFile -Force }
    # pnpm 会把 link:D:\... 解释成相对 profile 的路径，这里显式重建绝对 junction。
    if (Test-Path $moduleDir) { (Get-Item $moduleDir).Delete() }
    New-Item -ItemType Junction -Path $moduleDir -Target 'D:\dsh-superagent' | Out-Null
    $restored = Get-Item $moduleDir
    $result.restore = [ordered]@{
      exit = $LASTEXITCODE
      output = $restoreOut.Trim()
      linkType = [string]$restored.LinkType
      target = [string]$restored.Target
      hash = (Get-FileHash 'D:\dsh-superagent\lib\index.js' -Algorithm SHA256).Hash
      packageJson = (Get-Content $packageFile -Raw)
    }
  } catch {
    $result.restoreError = $_.Exception.Message
    $result.restoreStack = $_.ScriptStackTrace
  }
  $result.finishedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Save 'install-result.json' $result
  $result | ConvertTo-Json -Depth 12
}
