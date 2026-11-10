param([int]$PollSeconds = 90, [int]$HoldSeconds = 3600)
# U10 取证：用「注册表里的机器级 + 用户级 PATH」重建环境后启动桌面版，
# 让新进程拿到刚写入的用户级 PATH，然后输出面板地址并保持运行以便探针与截图。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = 'C:\Users\61054\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$log = Join-Path $env:TEMP 'dsh-u10-start.out.log'
$err = Join-Path $env:TEMP 'dsh-u10-start.err.log'

# 用注册表值重建本进程 PATH：新起的桌面版继承它，相当于「重新登录后」的环境。
$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$user = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machine;$user"

Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 1500
Remove-Item $log, $err -ErrorAction SilentlyContinue
$app = Start-Process -FilePath $exe -RedirectStandardOutput $log -RedirectStandardError $err -PassThru

# 从标准输出读面板地址（含 token）。
$found = $null
$deadline = (Get-Date).AddSeconds($PollSeconds)
while ((Get-Date) -lt $deadline -and -not $found) {
  if (Test-Path $log) {
    $hit = Select-String -Path $log -Pattern 'http://127\.0\.0\.1:(\d+)/\?token=(\S+)' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) {
      $found = [ordered]@{ port = $hit.Matches[0].Groups[1].Value; token = $hit.Matches[0].Groups[2].Value
        url = "http://127.0.0.1:$($hit.Matches[0].Groups[1].Value)/?token=$($hit.Matches[0].Groups[2].Value)" }
    }
  }
  Start-Sleep -Milliseconds 300
}
if (-not $found) { throw "未在 $PollSeconds 秒内发现面板地址" }

# 等到运行时 ready 再交回，避免探针打到重建中的实例。
$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(5)
$deadline = (Get-Date).AddSeconds($PollSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, "http://127.0.0.1:$($found.port)/orchestrator/api/health")
    [void]$req.Headers.Add('x-orchestrator-request', '1')
    $res = $client.SendAsync($req).Result
    if ([int]$res.StatusCode -eq 200 -and (($res.Content.ReadAsStringAsync().Result | ConvertFrom-Json).phase -eq 'ready')) { $ready = $true; break }
  } catch {}
  Start-Sleep -Milliseconds 400
}
$client.Dispose()

$record = [ordered]@{
  startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  pid = $app.Id
  port = $found.port
  token = $found.token
  url = $found.url
  ready = $ready
  pathSource = 'Machine + User 注册表值'
  pathHasGithubCli = ($env:Path -split ';' | Where-Object { $_ -like '*GitHub CLI*' }).Count -gt 0
  whereGh = @(& where.exe gh 2>&1) -join "`n"
  ghVersion = @(& gh --version 2>&1) -join "`n"
}
$record | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $here 'app-start.json') -Encoding utf8
$record | ConvertTo-Json -Depth 6
# 保持进程存活：本命令结束会带走子进程。
Start-Sleep -Seconds $HoldSeconds
