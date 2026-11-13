/**
 * 卸载清理实测（2026-11-12）。
 *
 * 直连真实桌面版 Harness：先用管理 API 确认插件在跑，然后运行 `clean` 卸载插件并清理
 * 残留（patch 条目、package.json 引用、node_modules 链接、状态目录与锁、工件），断言
 * 检出目录完好无损；最后从备份逐字还原 profile 文件并重建目录连接，等待插件重新装载
 * 为 ready，确认机器恢复原状。
 *
 * 运行：`node --experimental-transform-types verification/2026-11-12-cleanup/run-cleanup.ts`
 * 前置：桌面版 DeepSeek Harness 正在运行且加载了 dsh-superagent（`stateDir/startup.json`
 * 为 ready）；默认 profile 为 `desktop`，可用 `DSH_PROFILE` 覆盖，DSH home 可用 `DSH_HOME` 覆盖。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DirectConnect } from '../direct-connect.ts'

const here = dirname(fileURLToPath(import.meta.url))
const evidence = join(here, 'result.json')
const checkout = resolve(here, '..', '..')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profile = process.env.DSH_PROFILE ?? 'desktop'
const profileDir = join(dshHome, 'profiles', profile)
const stateDir = process.env.DSH_STATE_DIR ?? join(dshHome, 'state', 'superagent')

const sleep = async (ms: number) => new Promise<void>(done => setTimeout(done, ms))
const stamp = (): string => new Date().toISOString()
function save(value: unknown): void { writeFileSync(evidence, JSON.stringify(value, null, 2), 'utf8') }
function check(condition: unknown, message: string): void { if (!condition) throw new Error(message) }

/** 直连桌面版管理接口：端口自动从 startup.json 读取并跟随重挂载。 */
const dc = new DirectConnect({ stateDir })
let port = 0
/** 管理接口任意应答即可 reachable（clean 卸载期间健康可能非 ok，但应已无监听）。 */
async function reachable(): Promise<boolean> {
  try { port = dc.started().port } catch { return false }
  try { await dc.api('GET', 'health'); return true } catch { return false }
}
/** 等插件回到 ready：桌面版宿主对 profile 变化的反应有 30–90 秒延迟，恢复也可能跨多个周期。 */
async function waitReachable(label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await reachable())) {
    if (Date.now() >= deadline) throw new Error(`${label}：${timeoutMs / 1000}s 内管理接口未恢复 ready`)
    await sleep(2_000)
  }
}

/** 找到 clean 刚写入的备份目录（~/dsh-superagent-backup/clean-*）。 */
function latestBackup(): string {
  const root = join(homedir(), 'dsh-superagent-backup')
  const entries = readdirSync(root).filter(name => name.startsWith('clean-')).sort()
  check(entries.length, 'clean 没有留下备份目录')
  return join(root, entries.at(-1)!)
}

/** 从备份还原 profile：先重建链接与依赖清单，最后写回 patch（宿主读到完整一致的层）。 */
function restoreProfile(backup: string): string[] {
  const restored: string[] = []
  const moduleDir = join(profileDir, 'node_modules', 'dsh-superagent')
  if (!existsSync(moduleDir)) symlinkSync(checkout, moduleDir, process.platform === 'win32' ? 'junction' : 'dir')
  restored.push('node_modules/dsh-superagent (junction recreated)')
  const files = readdirSync(join(backup, 'profile')).filter(file => file !== 'cordis.patch.yml').sort()
  for (const file of files) { cpSync(join(backup, 'profile', file), join(profileDir, file)); restored.push(file) }
  cpSync(join(backup, 'profile', 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'))
  restored.push('cordis.patch.yml')
  return restored
}

/** 运行一段 PowerShell（同步）。 */
function powershell(command: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 60_000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 找到桌面版主进程（不带参数的裸 exe）并返回其可执行文件路径；找不到返回 undefined。 */
function appExe(): string | undefined {
  if (process.platform !== 'win32') return undefined
  const found = powershell(`Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" | Where-Object { $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*expose-internals*' } | Select-Object -First 1 -ExpandProperty ExecutablePath`)
  const path = found.stdout.trim().split(/\r?\n/)[0]
  return path && existsSync(path) ? path : undefined
}

/**
 * 停止整个桌面版应用（主进程树）。宿主对 patch 变更的监视有 30–90 秒延迟且不稳定，
 * 因此 clean 前先按脚本指引关闭应用：锁随进程消亡在 30 秒后成为过期锁，clean 直接清理。
 */
function stopApp(): void {
  const killed = powershell(`Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness.exe'" | Where-Object { $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*expose-internals*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`)
  if (killed.status !== 0) throw new Error(`关闭 DeepSeek Harness 失败：${killed.stderr}`)
  const gone = powershell(`$deadline = (Get-Date).AddSeconds(30); while ((Get-Date) -lt $deadline) { if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { 'gone'; break }; Start-Sleep 2 }`)
  if (!gone.stdout.includes('gone')) throw new Error('DeepSeek Harness 进程在 30 秒内未完全退出')
}

/** 重新启动桌面版应用（与用户双击启动等价的裸命令行）。 */
function startApp(exe: string): void {
  spawnSync('powershell', ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}'`], { encoding: 'utf8', timeout: 30_000 })
}

/**
 * 正式重装。宿主把「patch 条目消失」正式化为插件管理器的 remove 操作（改写
 * package.json）；此后仅还原文件不会重新装载，必须走正式安装命令。
 * 调用前应用应已停止，重装完成后由调用方重启应用。
 */
function reinstall(): { cli: string; install: { status: number | null; stdout: string; stderr: string } } {
  const cli = process.env.DSH_CLI ?? 'dsh'
  // shell:true 不做转义；路径含空格时整体加引号，参数里的检出路径同样如此。
  const windows = process.platform === 'win32'
  const install = windows
    ? spawnSync(`"${cli}"`, ['plugin', '--profile', profile, 'add', `"link:${checkout}"`], { encoding: 'utf8', timeout: 240_000, shell: true })
    : spawnSync(cli, ['plugin', '--profile', profile, 'add', `link:${checkout}`], { encoding: 'utf8', timeout: 240_000 })
  return { cli, install: { status: install.status, stdout: install.stdout ?? '', stderr: install.stderr ?? '' } }
}

async function main(): Promise<void> {
  const steps: Array<{ at: string; step: string; detail?: unknown }> = []
  const note = (step: string, detail?: unknown) => steps.push({ at: stamp(), step, ...(detail === undefined ? {} : { detail }) })

  // 1. 前置：插件在桌面版里运行中（宿主对配置变化的反应有延迟，先等它回到 ready）。
  await waitReachable('前置', 240_000)
  const before = {
    patch: readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'),
    packageJson: readFileSync(join(profileDir, 'package.json'), 'utf8'),
    moduleLink: lstatSync(join(profileDir, 'node_modules', 'dsh-superagent')).isSymbolicLink(),
    stateEntries: readdirSync(stateDir),
    lock: existsSync(stateDir + '.lock'),
  }
  check(before.patch.includes('id: dsh-superagent'), '前置失败：profile patch 里没有 dsh-superagent 条目')
  note('precheck', { port, profile, dshHome, stateDir, before })

  // 2. 关闭桌面版应用后运行 clean（宿主对 patch 变更的监视不稳定，按脚本指引先停应用：
  //    锁随进程消亡成为过期锁，clean 直接清理）。
  const exe = appExe()
  check(exe, '前置失败：找不到 DeepSeek Harness 主进程')
  note('app', { exe })
  stopApp()
  note('app stopped')
  const run = spawnSync(process.execPath, [join(checkout, 'scripts', 'dsh-superagent.mjs'),
    'clean', '--yes', '--profile', profile], { encoding: 'utf8', timeout: 420_000 })
  note('clean', { code: run.status, stdout: run.stdout, stderr: run.stderr })
  check(run.status === 0, `clean 以 ${run.status} 退出：${run.stderr}`)

  // 3. 断言清理结果；检出目录必须完好是第一安全断言。
  for (const probe of ['package.json', 'src/index.ts', 'scripts/dsh-superagent.mjs', 'docs/006-deployment.md']) {
    check(existsSync(join(checkout, probe)), `检出目录损坏：${probe} 不存在`)
  }
  const afterPatch = existsSync(join(profileDir, 'cordis.patch.yml'))
    ? readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8') : ''
  const afterPackage = existsSync(join(profileDir, 'package.json'))
    ? readFileSync(join(profileDir, 'package.json'), 'utf8') : ''
  check(!afterPatch.includes('dsh-superagent'), 'patch 仍引用 dsh-superagent')
  check(!afterPackage.includes('"dsh-superagent"'), 'package.json 仍引用 dsh-superagent')
  check(!existsSync(join(profileDir, 'node_modules', 'dsh-superagent')), 'node_modules/dsh-superagent 仍存在')
  check(!existsSync(stateDir), '状态目录仍存在')
  check(!existsSync(stateDir + '.lock'), '状态锁目录仍存在')
  check(!(await reachable()), '旧端口仍应答；插件应已随 patch 重组卸载')
  const backup = latestBackup()
  check(existsSync(join(backup, 'profile', 'cordis.patch.yml')), '备份缺少 patch 原文')
  note('cleaned', { backup, afterPatch, afterPackage })

  // 4. 还原文件 → 正式重装（插件管理器记得 remove，仅还原文件不会重挂载）→ 重启应用 → 等 ready。
  const restored = restoreProfile(backup)
  note('restored', { restored })
  const reinstalled = reinstall()
  note('reinstalled', { cli: reinstalled.cli, status: reinstalled.install.status,
    stdout: String(reinstalled.install.stdout).slice(0, 800), stderr: String(reinstalled.install.stderr).slice(0, 400) })
  check(reinstalled.install.status === 0, `dsh plugin add 失败：${reinstalled.install.stderr}`)
  startApp(exe!)
  note('app restarted')
  await waitReachable('还原', 300_000)
  const state = await dc.api<{ masterId?: string }>('GET', 'state')
  note('reloaded', { port, masterId: state.masterId })
  const finalPatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  check(finalPatch === before.patch, '还原后的 patch 与原文不一致')
  save({ outcome: 'completed', profile, dshHome, steps })
  console.log('CLEANUP_LIVE_OK')
}

main().catch(error => {
  save({ outcome: 'error', profile, error: String(error instanceof Error ? error.message : error), at: stamp() })
  console.error(String(error instanceof Error ? error.stack : error))
  process.exitCode = 1
})
