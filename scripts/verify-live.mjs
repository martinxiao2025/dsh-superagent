#!/usr/bin/env node
/**
 * 一键实机验证（官方实践的第 4 步「读安装结果并验证已安装能力」的脚本化）：
 * 对一个运行中的 dsh-superagent 实例做只读检查，不改动任何状态：
 *   1. 从 stateDir/startup.json 读启动记录（phase/detail/pid/端口），端口漂移自动跟随；
 *   2. 等待 `GET health` 就绪（phase === 'ready' 且 ok）；
 *   3. 逐项核对健康看板（GET state → health）：全部条目应为 ready，并列出非 ready 项；
 *   4. 抽查只读接口（queue/overview/prompts）可达且形状正确；
 *   5. 结果落盘 .artifacts/verify-live-<profile>.json 供留档。
 *
 *   node scripts/verify-live.mjs [--profile NAME] [--state-dir DIR] [--url http://127.0.0.1:PORT] [--timeout 90]
 *
 * 退出码：0 全部就绪；1 未就绪或有非 ready 健康条目（输出会指明是哪一项）。
 * 与 scripts/dsh-superagent.mjs status 的区别：status 面向服务托管（tmux/启停/退出码语义），
 * 本脚本面向「改代码 → 重挂载 → 验证」的开发回路，不启动、不停止、不修复任何东西。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = { profile: '', stateDir: '', url: '', timeout: 90 }
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]
  const value = () => argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : process.argv[++index]
  if (argument === '--profile' || argument.startsWith('--profile=')) options.profile = value()
  else if (argument === '--state-dir' || argument.startsWith('--state-dir=')) options.stateDir = value()
  else if (argument === '--url' || argument.startsWith('--url=')) options.url = value()
  else if (argument === '--timeout' || argument.startsWith('--timeout=')) options.timeout = Number(value())
  else if (argument === '--help' || argument === '-h') { console.log('usage: verify-live [--profile NAME] [--state-dir DIR] [--url URL] [--timeout 90]'); process.exit(0) }
  else { console.error(`unrecognized argument: ${argument}`); process.exit(1) }
}
const homedir = (await import('node:os')).homedir
const sleep = ms => new Promise(done => setTimeout(done, ms))
const fail = message => { console.error(message); process.exit(1) }

/**
 * 状态目录定位：--state-dir 显式指定；否则在「profile 约定目录（--profile 或生产默认）」与
 * 「开发实例（检出的 .dsh-dev-state）」之间选**启动记录最新**的一个，并把候选打印出来——
 * 桌面实例与开发实例并存时，最新的 startup.json 就是最近一次重挂载/启动的实例。
 */
function candidateStateDirs() {
  if (options.stateDir) return [resolve(options.stateDir)]
  const list = []
  if (options.profile) list.push(join(homedir(), '.dsh', 'state', options.profile))
  else list.push(join(homedir(), '.dsh', 'state', 'superagent'))
  list.push(join(ROOT, '.dsh-dev-state'))
  return list
}
function readStartup() {
  const found = []
  for (const directory of candidateStateDirs()) {
    const file = join(directory, 'startup.json')
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!parsed.listen?.port) continue
      found.push({ directory, file, at: parsed.at ?? '', port: parsed.listen.port, phase: parsed.phase ?? '', detail: parsed.detail ?? '', pid: parsed.pid ?? 0 })
    } catch { /* 损坏或半写：尝试下一个候选 */ }
  }
  if (!found.length) return undefined
  // pid 已死的记录是崩溃/被杀残留：过滤掉，避免把已停止实例当作目标。
  const alive = found.filter(item => {
    try { process.kill(item.pid, 0); return true } catch { return false }
  })
  if (!alive.length) return undefined
  if (alive.length !== found.length) console.log(`忽略已停止实例的启动记录：${found.filter(item => !alive.includes(item)).map(item => item.directory).join('、')}`)
  if (alive.length > 1) console.log(`候选实例：${alive.map(item => `${item.directory}（${item.at}，pid=${item.pid}）`).join('；')}——取最新的一个；用 --state-dir 或 --profile 显式指定。`)
  return alive.sort((left, right) => right.at.localeCompare(left.at))[0]
}

async function api(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/${path}`, { headers: { 'x-orchestrator-request': '1' } })
  const text = await response.text()
  const value = text ? JSON.parse(text) : undefined
  return { status: response.status, ok: response.ok, value }
}

async function main() {
  // 1. 启动记录：等待出现或更新（重挂载会重写它）。
  let startup
  const deadline = Date.now() + options.timeout * 1000
  while (Date.now() < deadline) {
    startup = readStartup()
    if (startup) break
    await sleep(1000)
  }
  if (!startup) fail(`在 ${candidateStateDirs().join('、')} 下都没有找到带监听端口的 startup.json；实例未运行或 stateDir 不在预期位置（用 --state-dir 显式指定）。`)
  const { port, phase, detail, pid } = startup
  console.log(`Startup: phase=${phase}${phase !== 'ready' ? ` (${detail})` : ''} pid=${pid} port=${port} stateDir=${startup.directory}`)

  // 2. 等待健康就绪。
  let health
  while (Date.now() < deadline) {
    try {
      const probe = await api(port, 'health')
      if (probe.ok && probe.value?.ok) { health = probe.value; break }
      if (!health || probe.value?.phase !== health.phase) console.log(`health: ${probe.status} ${probe.value?.phase ?? 'no-response'} ${probe.value?.detail ?? ''}`)
      health = probe.value
    } catch { /* 实例重启中：端口可能变化，重读启动记录 */ }
    const refreshed = readStartup()
    if (refreshed && refreshed.port && refreshed.port !== port) return main()
    await sleep(1000)
  }
  if (!health?.ok) fail(`实例未就绪（phase=${health?.phase ?? 'no-response'}）；详见 startup.json 与实例日志。`)
  console.log(`Health: ok (${health.detail ?? ''})`)

  // 3. 健康看板：全部条目 ready。
  const state = await api(port, 'state')
  if (!state.ok) fail(`GET state 失败（${state.status}）`)
  const entries = Object.entries(state.value?.health ?? {})
  const notReady = entries.filter(([, entry]) => entry?.state !== 'ready')
  for (const [name, entry] of entries) console.log(`  ${name}: ${entry.state}${entry.state === 'ready' ? '' : ` — ${entry.detail}`}`)
  if (notReady.length) fail(`${notReady.length} 个健康条目未就绪：${notReady.map(([name]) => name).join(', ')}`)

  // 4. 抽查只读接口。
  const checks = []
  const queue = await api(port, 'queue')
  checks.push({ name: 'queue', ok: queue.ok && typeof queue.value?.maxWorkers === 'number', detail: `maxWorkers=${queue.value?.maxWorkers} items=${queue.value?.items?.length ?? 0}` })
  const prompts = await api(port, 'prompts')
  checks.push({ name: 'prompts', ok: prompts.ok && typeof prompts.value?.revision === 'number', detail: `revision=${prompts.value?.revision} sessions=${prompts.value?.sessions?.length ?? 0}` })
  const overview = await api(port, 'overview')
  checks.push({ name: 'overview', ok: overview.ok, detail: `problems=${overview.value?.problems?.length ?? 0}` })
  for (const check of checks) console.log(`  ${check.name}: ${check.ok ? 'ok' : 'FAILED'} (${check.detail})`)

  // 5. 留档。
  const report = { at: new Date().toISOString(), profile: options.profile || 'auto', port, phase, pid,
    stateDir: startup.directory, health: Object.fromEntries(entries), checks }
  const artifactDir = join(ROOT, '.artifacts')
  mkdirSync(artifactDir, { recursive: true })
  const artifact = join(artifactDir, `verify-live-${options.profile || 'default'}.json`)
  writeFileSync(artifact, JSON.stringify(report, null, 2))
  console.log(`Report: ${artifact}`)
  console.log('VERIFY_LIVE_OK')
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
