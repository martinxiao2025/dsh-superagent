#!/usr/bin/env node
/**
 * 推荐开发回路的一键入口（用法见 docs/006-deployment.md 的「开发与调试」）：
 * 构建 → 从包层 cordis.patch.yml 生成自包含开发覆盖层（主插件按本检出的绝对路径加载，
 * worker/router 预设逐字复制，因此升级包层预设后无需手工同步）→ 启动 `dsh web`
 * → 等插件就绪后打印面板 URL。开发状态目录固定为 <检出>/.dsh-dev-state，与生产隔离。
 *
 *   node scripts/dev-web.mjs [--no-build] [--port 3080] [--dsh <dsh 命令>]
 *
 * dsh CLI 解析顺序：--dsh > DSH_CLI 环境变量 > PATH 上的 dsh（桌面版自带 CLI 位于
 * <安装目录>\resources\runtime\cli\bin\dsh.cmd）。Ctrl+C 结束 dsh web 子进程树。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:http'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE_DIR = join(ROOT, '.dsh-dev-state')
const OVERLAY = join(ROOT, '.artifacts', 'dev.cordis.patch.yml')
const forward = path => path.replaceAll('\\', '/')
const sleep = ms => new Promise(done => setTimeout(done, ms))
const fail = message => { console.error(message); process.exit(1) }

const options = { build: true, port: 3080, dsh: process.env.DSH_CLI || '' }
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]
  const value = () => argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : process.argv[++index]
  if (argument === '--no-build') options.build = false
  else if (argument === '--port' || argument.startsWith('--port=')) options.port = Number(value())
  else if (argument === '--dsh' || argument.startsWith('--dsh=')) options.dsh = value()
  else if (argument === '--help' || argument === '-h') { console.log('usage: dev-web [--no-build] [--port 3080] [--dsh <dsh command>]'); process.exit(0) }
  else fail(`unrecognized argument: ${argument}`)
}
if (!(options.port > 0) || options.port > 65535) fail('--port must be a valid port')

/** 在 PATH 上解析 `name`；Windows 上按 PATHEXT 补全扩展名。 */
function which(name) {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      try { if (statSync(candidate).isFile()) return candidate } catch { /* 不在此目录 */ }
    }
  }
  return undefined
}

/** 找到 dsh CLI：--dsh > DSH_CLI > PATH；都没有时给出指引。 */
function findDsh() {
  const candidates = [options.dsh, 'dsh'].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate.includes('\\') || candidate.includes('/')) return existsSync(candidate) ? candidate : fail(`--dsh 指向的文件不存在：${candidate}`)
    const found = which(candidate)
    if (found) return found
  }
  return fail('未找到 dsh CLI：把它的路径传给 --dsh 或设置 DSH_CLI 环境变量（桌面版自带 CLI 位于 <安装目录>\\resources\\runtime\\cli\\bin\\dsh.cmd）。')
}

/**
 * 生成自包含覆盖层：主插件按本检出的绝对路径加载（peer 依赖从检出 node_modules 解析），
 * 预设条目逐字取自包层 cordis.patch.yml。按路径加载不经过包层，预设必须显式带上。
 */
function writeOverlay() {
  const lines = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
  const blocks = {}
  let current
  for (const line of lines) {
    const match = /^    - id: (\S+)\s*$/.exec(line)
    if (match) { current = match[1]; blocks[current] = [line] }
    else if (current) blocks[current].push(line)
  }
  const presets = ['dsh-superagent-worker-preset', 'dsh-superagent-router-preset']
    .map(id => blocks[id]).filter(Boolean).map(block => block.join('\n').replace(/\n+$/, ''))
  if (presets.length !== 2) fail('包层 cordis.patch.yml 缺少 worker/router 预设条目；请检查其结构。')
  mkdirSync(dirname(OVERLAY), { recursive: true })
  writeFileSync(OVERLAY, ['- insert:',
    '    - id: dsh-superagent',
    `      name: '${forward(ROOT)}/lib/index.js'`,
    '      config:',
    `        stateDir: ${forward(STATE_DIR)}`,
    '', ...presets.map(block => block + '\n'), ''].join('\n'))
  console.log(`Overlay: ${OVERLAY}`)
}

/** 等开发实例的插件就绪：轮询 .dsh-dev-state/startup.json 的端口并探健康接口。 */
async function waitReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const entry = JSON.parse(readFileSync(join(STATE_DIR, 'startup.json'), 'utf8'))
      if (entry.listen?.port && await healthy(entry.listen.port)) return entry
    } catch { /* 尚未写出启动记录 */ }
    await sleep(1_000)
  }
  return undefined
}
function healthy(port) {
  return new Promise(done => {
    try {
      const req = request(`http://127.0.0.1:${port}/orchestrator/api/health`, { timeout: 2000,
        headers: { 'x-orchestrator-request': '1', connection: 'close' } }, response => {
        response.on('data', () => {}); response.on('end', () => done(response.statusCode === 200))
      })
      req.on('timeout', () => { req.destroy(); done(false) })
      req.on('error', () => done(false))
      req.end()
    } catch { done(false) }
  })
}

/** 为 `cmd.exe /c` 引用一个参数，并按 cmd 的期望将内嵌引号加倍。 */
const cmdQuote = argument => `"${String(argument).replaceAll('"', '""')}"`
/** 启动 `program` 的文件与参数列表；批处理需要 cmd.exe，且 /s /c 后整体再引用一次。 */
const commandOf = (program, args) => process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(program)
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[program, ...args].map(cmdQuote).join(' ')}"`]]
  : [program, args]

async function main() {
  const dsh = findDsh()
  if (options.build) {
    console.log('Building…')
    const pnpm = which('pnpm')
    if (!pnpm) fail('PATH 上没有 pnpm；或用 --no-build 跳过构建。')
    const [pnpmFile, pnpmArgs] = commandOf(pnpm, ['build'])
    const built = spawnSync(pnpmFile, pnpmArgs, { stdio: 'inherit', windowsVerbatimArguments: process.platform === 'win32' })
    if (built.status !== 0) fail(`pnpm build 失败（${built.status}）`)
  }
  writeOverlay()
  const [file, args] = commandOf(dsh, ['web', '--patch', OVERLAY, '--no-open', '--port', String(options.port)])
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'inherit'], windowsVerbatimArguments: process.platform === 'win32' })
  let panel = ''
  child.stdout.on('data', chunk => {
    const text = chunk.toString('utf8')
    process.stdout.write(text)
    panel = /dsh web: (https?:\/\/\S+)/.exec(text)?.[1] ?? panel
  })
  const stopping = signal => {
    console.log(`\nStopping dsh web (${signal})…`)
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    else child.kill('SIGINT')
    process.exit(0)
  }
  process.on('SIGINT', () => stopping('SIGINT'))
  process.on('SIGTERM', () => stopping('SIGTERM'))
  const entry = await waitReady()
  if (!entry) fail('120 秒内开发实例未就绪；上方是 dsh web 的输出，另见 .dsh-dev-state/startup.json 的 phase/detail。')
  // 带 token 的面板 URL 可能晚于就绪到达；最多再等 5 秒拿完整地址。
  for (let index = 0; index < 10 && !panel.includes('token='); index++) await sleep(500)
  console.log('DEV_WEB_READY')
  console.log(`Panel: ${panel || `http://127.0.0.1:${options.port}`}`)
  console.log(`State: ${STATE_DIR}`)
  console.log('按 Ctrl+C 停止开发实例。')
  await new Promise(() => {})
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
