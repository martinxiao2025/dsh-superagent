#!/usr/bin/env node
/**
 * 管理本地 dsh-superagent 服务（一个 DSH 配置文件，默认 `superagent`），且不影响其他 tmux 会话。
 *
 * 服务正常运行时，`status`、`start` 和 `restart` 退出码为 0；服务已停止、重复、不可达或
 * 报告运行时错误时为 1，`restart` 可能修复该错误；当某个组件（例如来源）报告错误而服务仍在运行时为 2；
 * 服务运行并等待设置时为 3。重启既不能修复 2 也不能修复 3：它们需要人处理。
 *
 * 脚本是纯 Node.js，因此能在捆绑包安装的每个平台上启动；运行服务仍需要 `ps` 和 `tmux`，
 * 它们通过 PATH 解析。
 */
import { spawnSync } from 'node:child_process'
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { request } from 'node:http'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const ARTIFACTS = join(ROOT, '.artifacts')
const CONTROL = join(ARTIFACTS, 'control')
const KEEP_LOGS = 20

/** 返回 `profile` 的控制目录，必要时创建它。 */
function control(profile) {
  const directory = join(CONTROL, 'profiles', profile)
  mkdirSync(directory, { recursive: true })
  return directory
}

/** 返回 `profile` 是否被有意停止。 */
const stopped = profile => existsSync(join(control(profile), 'manually-stopped'))

/** 返回命令行参数是否属于 `profile` 的主 DSH 服务进程。 */
function serves(args, profile) {
  const words = []
  let matched = false
  let value = false
  for (const word of args.slice(1)) {
    if (value) {
      matched = matched || word === profile
      value = false
    } else if (word === '--profile') value = true
    else if (word === '--profile=' + profile) matched = true
    else if (!word.startsWith('-')) words.push(word)
  }
  return matched && !words.includes('plugin')
}

/** 裸命令名在此平台上可能携带的扩展名，正如 `cmd` 和 `which` 所做的那样。 */
const EXTENSIONS = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']

/** 在 PATH 上将 `name` 解析为可执行文件，找不到则返回 undefined。 */
function which(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    for (const extension of EXTENSIONS) {
      const candidate = join(directory, name + extension)
      try { if (statSync(candidate).isFile()) return candidate } catch { /* Not in this directory. */ }
    }
  }
  return undefined
}

/** 为 `cmd.exe /c` 命令行引用一个参数，并按 cmd 的期望将内嵌引号加倍。 */
const cmdQuote = argument => `"${argument.replaceAll('"', '""')}"`
/**
 * 启动 `program` 的文件与参数列表。批处理文件需要 `cmd.exe`，因为 Windows 无法直接启动它；
 * cmd 会在 `/s /c` 后剥掉一层引号，因此整个命令会再引用一次。
 */
const commandOf = (program, args) => process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(program)
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[program, ...args].map(cmdQuote).join(' ')}"`]]
  : [program, args]

/** 返回 `pid` 是否指向一个正在运行的进程。 */
function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 从 `ps` 产生 `[pid, 命令名, argv]`。参数按空白拆分，因此含空格的路径会变成多个
 * 词，只有 `--profile` 和子命令会被检查。
 */
function ps(options = [], check = false) {
  const program = which('ps')
  if (!program) throw new Error('ps must be on PATH.')
  const [file, args] = commandOf(program, ['-ww', ...options, '-o', 'pid=,ucomm=,args='])
  const result = spawnSync(file, args, { encoding: 'utf8', windowsVerbatimArguments: process.platform === 'win32' })
  if (check && result.status !== 0) throw new Error('ps failed.')
  const found = []
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const match = /^(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match) found.push([Number(match[1]), match[2], match[3].split(/\s+/)])
  }
  return found
}

/** 返回 `pid` 当前是否正在运行 `profile` 的 DSH 服务（进程退出后 `ps -p` 不返回任何内容）。 */
const running = (pid, profile) => ps(['-p', String(pid)]).some(([found, name, args]) => found === pid && (name === 'node' || name === 'dsh') && serves(args, profile))

/**
 * 返回 `profile` 的所有正在运行的 DSH 服务进程 PID，包括在本脚本之外启动的实例
 * 以及仍在运行的已记录 `service.pid`。
 */
function processes(profile) {
  const found = ps(['-ax'], true).filter(([, name, args]) => (name === 'node' || name === 'dsh') && serves(args, profile)).map(([pid]) => pid)
  let recorded
  try { recorded = Number(readFileSync(join(control(profile), 'service.pid'), 'utf8').trim()) } catch { return found }
  return Number.isInteger(recorded) && recorded > 0 && !found.includes(recorded) && running(recorded, profile) ? [...found, recorded] : found
}

/**
 * 从管理 API 获取健康状态与设置状态，不可达时返回 undefined。
 * 请求特意避免 keep-alive 代理和长期句柄，因此 CLI 运行完成后会立即退出。
 */
function state(url) {
  return new Promise(resolve => {
    let settled = false
    const done = value => { if (!settled) { settled = true; resolve(value) } }
    try {
      const req = request(new URL(url.replace(/\/+$/, '') + '/orchestrator/api/state'), {
        agent: false, timeout: 2000, headers: { 'x-orchestrator-request': '1', connection: 'close' },
      }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', () => done(undefined))
        response.on('end', () => {
          if (!(response.statusCode >= 200 && response.statusCode < 300)) return done(undefined)
          try { done(summarize(JSON.parse(Buffer.concat(chunks).toString('utf8')))) } catch { done(undefined) }
        })
      })
      req.on('timeout', () => { req.destroy(); done(undefined) })
      req.on('error', () => done(undefined))
      req.end()
    } catch { done(undefined) }
  })
}

/**
 * 向管理 API 发送一个 JSON POST；不可达或非 2xx 时抛错。
 * `reset` 用它触发运行时的「备份—清空—重启」流程，因此超时比状态查询长。
 */
function post(url, path, body, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = request(new URL(url.replace(/\/+$/, '') + '/orchestrator/api' + path), {
      agent: false, timeout, method: 'POST',
      headers: { 'x-orchestrator-request': '1', connection: 'close', 'content-type': 'application/json', 'content-length': payload.length },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!(response.statusCode >= 200 && response.statusCode < 300)) return reject(new Error(`The service answered ${response.statusCode}: ${text}`))
        try { resolve(JSON.parse(text)) } catch { resolve(text) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('The service did not answer in time.')) })
    req.on('error', reject)
    req.end(payload)
  })
}

/** 将管理 API 的回答精简为 CLI 所报告的 health 与 setup 字段。 */
function summarize(value) {
  // 另一个版本省略的键会读为空，以免服务被误认为不可达。
  const health = value.health ?? {}
  const setup = value.setup ?? {}
  const entries = Object.entries(health).map(([name, entry]) => [name, entry && typeof entry === 'object' ? entry : {}])
  return {
    health: Object.fromEntries(entries.map(([name, entry]) => [name, entry.state ?? null])),
    errors: Object.fromEntries(entries.filter(([, entry]) => entry.state === 'error').map(([name, entry]) => [name, String(entry.detail ?? '')])),
    setup: setup.problem ?? null,
    feishu: setup.feishuProblem ?? null,
  }
}

const PART_ERROR = 2
const SETUP_WAITS = 3
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))

/** 返回运行时是否已就绪，或暂停等待操作者操作；仍在启动的组件不会阻止这一判断。 */
const runtimeUp = current => current !== undefined && ['ready', 'paused'].includes(current.health.runtime)

/** 返回处于错误状态的非常规运行时组件。 */
const partErrors = current => Object.fromEntries(Object.entries(current.errors).filter(([name]) => name !== 'runtime').sort(([a], [b]) => a.localeCompare(b)))

/** 根据运行中的 PID 和管理 API 状态计算 CLI 退出码。 */
function outcome(pids, current) {
  if (pids.length !== 1 || !runtimeUp(current)) return 1
  if (current.setup) return SETUP_WAITS
  // 组件的持续错误不同于设置期间失败的飞书机器人检查，需要操作者处理。
  return Object.keys(partErrors(current)).length ? PART_ERROR : 0
}

async function status(options) {
  const pids = processes(options.profile)
  const current = pids.length ? await state(options.url) : undefined
  process.stdout.write(JSON.stringify({
    pids, cwd: ROOT, url: options.url, manually_stopped: stopped(options.profile),
    health: current ? current.health : null, errors: current ? current.errors : null,
    setup: current ? current.setup : null, feishu: current ? current.feishu : null,
  }, null, 2) + '\n')
  return outcome(pids, current)
}

/** 当前本地时间，格式为 `YYYY-MM-DDTHH:MM:SS+ZZZZ`。 */
function timestamp() {
  const now = new Date()
  const pad = value => String(Math.trunc(Math.abs(value))).padStart(2, '0')
  const offset = -now.getTimezoneOffset()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `${offset >= 0 ? '+' : '-'}${pad(offset / 60)}${pad(offset % 60)}`
}

/** 优雅停止服务；当 `intentional` 为 true 时记录手动停止标记。 */
async function stop(options, intentional = true) {
  const pids = processes(options.profile)
  if (pids.length > 1) throw new Error('Multiple dsh-superagent processes found; refusing to choose one.')
  // 在等待之前写入停止标记，这样即使优雅关闭超时，监控也会尊重这次有意停止。
  if (intentional) writeFileSync(join(control(options.profile), 'manually-stopped'), timestamp() + '\n')
  for (const pid of pids) process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGINT')
  const deadline = Date.now() + options.stopTimeout * 1000
  while (pids.some(pid => running(pid, options.profile))) {
    if (Date.now() >= deadline) throw new Error('Graceful stop timed out; no forced kill was sent. Check status.')
    await sleep(500)
  }
  rmSync(join(control(options.profile), 'service.pid'), { force: true })
  console.log(intentional ? 'dsh-superagent stopped. Automatic recovery is paused until start/restart.' : 'dsh-superagent stopped.')
}

/** 只保留 `profile` 最新的 `KEEP_LOGS` 个日志文件。 */
function pruneLogs(profile) {
  const name = new RegExp('^' + `dsh-superagent-${profile}-`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d{8}-\\d{6}-\\d+\\.log$')
  const logs = readdirSync(ARTIFACTS).filter(file => name.test(file)).map(file => join(ARTIFACTS, file))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  for (const file of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) rmSync(file, { force: true })
}

/** 为 POSIX shell 引用一个词，正如 tmux 运行启动命令那样。 */
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`

async function start(options) {
  const session = 'dsh-' + options.profile
  const pids = processes(options.profile)
  if (pids.length > 1) throw new Error('Multiple dsh-superagent processes found; refusing to start another.')
  if (!pids.length) {
    const dsh = which('dsh')
    const tmux = which('tmux')
    if (!dsh || !tmux) throw new Error('Both dsh and tmux must be on PATH.')
    const exists = (() => { const [file, args] = commandOf(tmux, ['has-session', '-t', '=' + session]); return spawnSync(file, args, { windowsVerbatimArguments: process.platform === 'win32' }).status === 0 })()
    if (await state(options.url) !== undefined) throw new Error('An existing orchestrator answers at this URL; refusing duplicate startup.')
    const log = join(ARTIFACTS, `dsh-superagent-${options.profile}-${localStamp()}-${process.pid}.log`)
    writeFileSync(log, '')
    pruneLogs(options.profile)
    // `exec` 替换 shell，因此 tmux 打印的面板 PID 就是 DSH 服务进程本身。
    const command = 'umask 077; exec ' + [dsh, '--profile', options.profile, '--no-open'].map(shellQuote).join(' ')
      + ' >> ' + shellQuote(log) + ' 2>&1'
    // 复用现有 tmux 会话，而不打扰其他窗口。
    const target = exists ? ['new-window', '-t', '=' + session + ':'] : ['new-session', '-s', session]
    const [tmuxFile, tmuxArgs] = commandOf(tmux, [...target, '-d', '-P', '-F', '#{pane_pid}', '-n', 'server', '-c', ROOT, command])
    const result = spawnSync(tmuxFile, tmuxArgs, { encoding: 'utf8', windowsVerbatimArguments: process.platform === 'win32' })
    if (result.status !== 0) throw new Error(`tmux failed: ${(result.stderr ?? '').trim()}`)
    const pane = String(result.stdout ?? '').trim()
    if (/^\d+$/.test(pane)) writeFileSync(join(control(options.profile), 'service.pid'), pane + '\n')
    console.log('Log: ' + log)
  } else {
    writeFileSync(join(control(options.profile), 'service.pid'), `${pids[0]}\n`)
    console.log(`dsh-superagent already running (PID ${pids[0]}); no duplicate started.`)
  }
  rmSync(join(control(options.profile), 'manually-stopped'), { force: true })
  const deadline = Date.now() + options.timeout * 1000
  while (Date.now() < deadline) {
    const current = await state(options.url)
    if (processes(options.profile).length && runtimeUp(current)) {
      const code = await status(options)
      if (current.setup) {
        console.log('dsh-superagent is waiting for setup: ' + String(current.setup.detail ?? ''))
        console.log('Open the URL DSH printed in the log, then the dsh-superagent overview.')
      }
      if (current.feishu) {
        console.log('dsh-superagent runs without Feishu: ' + String(current.feishu.detail ?? ''))
        console.log('Fix it on the Feishu card of the Source settings.')
      }
      for (const [name, detail] of Object.entries(partErrors(current))) console.log(`${name} reports an error, which a restart does not fix: ${detail}`)
      return code
    }
    await sleep(1000)
  }
  await status(options)
  throw new Error('Startup health check timed out; inspect the log. Any running process was left intact.')
}

/**
 * 备份并清空状态目录。只对正在运行的服务生效：CLI 不解析 DSH 配置，
 * 因此服务停止时无法可靠得知状态目录；那种情况应使用 `resetState` 启动参数。
 */
async function reset(options) {
  if (!options.yes) throw new Error('reset deletes the state directory after backing it up; pass --yes to confirm.')
  const pids = processes(options.profile)
  if (!pids.length) throw new Error('dsh-superagent is not running; set resetState in the DSH config to reset on startup instead.')
  if (!(await state(options.url))) throw new Error('The running service does not answer the management API; set resetState in the DSH config and restart.')
  const report = await post(options.url, '/admin/reset', { confirm: 'RESET' })
  console.log(JSON.stringify(report, null, 2))
  return 0
}

/** 日志文件名的本地时间戳，格式为 `YYYYMMDD-HHMMSS`。 */
function localStamp() {
  const now = new Date()
  const pad = value => String(Math.trunc(Math.abs(value))).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

// ── 卸载清理 ────────────────────────────────────────────────────────────────
// 插件在 DSH 一侧的足迹：profile 的 cordis.patch.yml 条目、package.json 的
// bundles/dependencies、node_modules 里的 dsh-superagent（link 安装是目录连接，
// tgz 安装是真实目录）、状态目录与其同级锁目录、以及本仓库 .artifacts 里的
// 日志和控制文件。桌面版实例持有状态锁：编辑 patch 会触发重组卸载，锁随之释放。

/** profile patch 里属于本插件的所有条目 id（worker/router 预设通常随包自带，但求稳）。 */
const PLUGIN_IDS = ['dsh-superagent', 'dsh-superagent-worker-preset', 'dsh-superagent-router-preset']

/** 列出 `dshHome` 下引用了本插件的 profile 名。 */
function profilesWithPlugin(dshHome) {
  const root = join(dshHome, 'profiles')
  let names = []
  try { names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { return [] }
  return names.filter(name => {
    try { return readFileSync(join(root, name, 'cordis.patch.yml'), 'utf8').split(/\r?\n/).some(line => PLUGIN_IDS.some(id => line === `- id: ${id}`)) }
    catch { return false }
  })
}

/**
 * 从 patch 文本中移除插件的顶层条目块。每个块从 `- id: …` 行持续到下一个
 * 顶层 `- ` 行或文件尾；返回剩余文本与被移除的块（供解析 `stateDir` 与还原）。
 */
function withoutPluginBlocks(text) {
  const lines = text.split(/\r?\n/)
  const kept = []
  const blocks = []
  let index = 0
  while (index < lines.length) {
    const hit = /^- id: (dsh-superagent(?:-worker-preset|-router-preset)?)\s*$/.exec(lines[index])
    if (hit) {
      const block = [lines[index]]
      while (++index < lines.length && !/^- /.test(lines[index])) block.push(lines[index])
      blocks.push({ id: hit[1], lines: block })
    } else kept.push(lines[index++])
  }
  return { text: kept.join('\n'), blocks }
}

/** 从插件的 patch 块中读取 `stateDir:` 配置值（去除可能的首尾引号）。 */
function stateDirOf(blocks) {
  for (const line of blocks.find(block => block.id === 'dsh-superagent')?.lines ?? []) {
    const match = /^\s+stateDir:\s*(.+?)\s*$/.exec(line)
    if (match) return match[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

/** 从 profile package.json 文本中移除本插件的 bundles 与 dependencies 引用；无变化返回 undefined。 */
function withoutPackageEntries(text) {
  const value = JSON.parse(text)
  let changed = false
  const bundles = value?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    const next = bundles.filter(name => name !== 'dsh-superagent')
    if (next.length !== bundles.length) { value.dsh.profile.bundles = next; changed = true }
  }
  if (value?.dependencies && Object.prototype.hasOwnProperty.call(value.dependencies, 'dsh-superagent')) {
    delete value.dependencies['dsh-superagent']
    if (!Object.keys(value.dependencies).length) delete value.dependencies
    changed = true
  }
  return changed ? JSON.stringify(value, null, 2) + '\n' : undefined
}

/** 从 pnpm-lock.yaml 文本中移除本插件的 importer 依赖条目；形状不匹配时返回 undefined（保留原文件）。 */
function withoutLockfileEntry(text) {
  const lines = text.split(/\r?\n/)
  const kept = []
  let removed = false
  for (let index = 0; index < lines.length; index++) {
    if (/^\s+dsh-superagent:\s*$/.test(lines[index] ?? '') && /^\s+specifier:\s*link:/.test(lines[index + 1] ?? '')
      && /^\s+version:\s*link:/.test(lines[index + 2] ?? '')) { index += 2; removed = true; continue }
    kept.push(lines[index])
  }
  return removed ? kept.join('\n') : undefined
}

/**
 * 返回 `stateDir` 的锁是否被活着的实例持有。proper-lockfile 的锁是同级 `.lock`
 * 目录，进程退出即删除；`startup.json` 的 pid 已死且锁目录超过 30 秒未刷新时，
 * 视为崩溃残留的过期锁。
 */
function lockHeld(stateDir) {
  const lock = stateDir + '.lock'
  if (!existsSync(lock)) return false
  try {
    const startup = JSON.parse(readFileSync(join(stateDir, 'startup.json'), 'utf8'))
    if (Number.isInteger(startup?.pid) && !alive(startup.pid) && Date.now() - statSync(lock).mtimeMs > 30_000) return false
  } catch { /* 锁存在但没有可解读的 startup.json 时按持有处理 */ }
  return true
}

/**
 * 卸载清理：从 DSH profile 移除插件引用并删除其状态与本仓库工件。
 * 备份到 `~/dsh-superagent-backup/clean-<stamp>/`（`--no-backup` 跳过）。
 * 桌面版宿主监视 profile 配置（实测 0.2.2-rc.1 有 30–90 秒延迟）：外部实例持有状态锁时，
 * 先改 patch 触发重组卸载并等待锁释放（默认 240 秒）；超时则还原 patch 并中止，不动任何状态。
 */
async function clean(options) {
  if (!options.yes) throw new Error('clean removes dsh-superagent from the DSH profile and deletes its state after a backup; pass --yes to confirm.')
  const dshHome = options.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = join(dshHome, 'profiles', options.profile)
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const packageFile = join(profileDir, 'package.json')
  const lockFile = join(profileDir, 'pnpm-lock.yaml')
  const moduleDir = join(profileDir, 'node_modules', 'dsh-superagent')
  const patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  const { text: nextPatch, blocks } = withoutPluginBlocks(patchText)
  const stateDir = options.stateDir || stateDirOf(blocks) || join(dshHome, 'state', 'superagent')
  const stateLock = stateDir + '.lock'
  const removed = []
  const manual = [
    'hourly-check prompt in your daily DSH profile (see docs/006-deployment.md)',
    'CLI wrappers and their config: ~/.local/bin/gh-agent, ~/.config/gh-agent, ~/.local/bin/lark-bot, ~/.lark-cli-dsh-superagent',
    'old backups under ~/dsh-superagent-backup/ and the pnpm store (pnpm store prune)',
  ]
  if (!blocks.length && !existsSync(moduleDir) && !existsSync(stateDir)) {
    console.log(`No dsh-superagent found in DSH profile ${options.profile}; nothing to clean.`)
    return 0
  }
  // 本脚本托管的服务先优雅停止；没有 ps（例如只有桌面版）时跳过该检查。
  try { if (processes(options.profile).length) await stop(options, false) }
  catch (error) { if (!/ps must be on PATH/.test(String(error instanceof Error ? error.message : error))) throw error }
  const backupRoot = join(homedir(), 'dsh-superagent-backup', 'clean-' + localStamp())
  const backUpFile = (file, name) => { mkdirSync(join(backupRoot, 'profile'), { recursive: true }); cpSync(file, join(backupRoot, 'profile', name)) }
  if (options.backup) {
    mkdirSync(backupRoot, { recursive: true })
    if (existsSync(stateDir)) cpSync(stateDir, join(backupRoot, 'state'), { recursive: true })
    if (existsSync(patchFile)) backUpFile(patchFile, 'cordis.patch.yml')
    if (existsSync(packageFile)) backUpFile(packageFile, 'package.json')
    if (existsSync(lockFile)) backUpFile(lockFile, 'pnpm-lock.yaml')
  }
  // 外部实例（桌面版）持有状态锁：先做 patch 手术触发重组卸载，锁释放前不删任何状态。
  const externallyHeld = lockHeld(stateDir)
  if (blocks.length) {
    writeFileSync(patchFile, nextPatch)
    removed.push(`${patchFile} (${blocks.map(block => block.id).join(', ')} removed)`)
  }
  if (externallyHeld) {
    console.log(`The state lock is held by a running dsh-superagent (stateDir ${stateDir}); the desktop host notices profile edits with a delay — waiting up to ${options.lockWait} s for the unload…`)
    const deadline = Date.now() + options.lockWait * 1000
    while (lockHeld(stateDir)) {
      if (Date.now() >= deadline) {
        if (blocks.length) writeFileSync(patchFile, patchText)  // 还原 patch，不留半卸载状态
        throw new Error(`The state lock was not released within ${options.lockWait} s. Close DeepSeek Harness, or run 'dsh plugin --profile ${options.profile} remove dsh-superagent' first, then run clean again; the profile patch was restored.`)
      }
      await sleep(500)
    }
  }
  const nextPackage = existsSync(packageFile) ? withoutPackageEntries(readFileSync(packageFile, 'utf8')) : undefined
  if (nextPackage) { writeFileSync(packageFile, nextPackage); removed.push(`${packageFile} (bundles/dependencies entry removed)`) }
  if (existsSync(moduleDir)) {
    // link 安装是目录连接（lstat 视为符号链接）：只删链接本身；tgz 安装是真实目录才递归删。
    if (lstatSync(moduleDir).isSymbolicLink()) rmSync(moduleDir, { force: true })
    else rmSync(moduleDir, { recursive: true, force: true })
    removed.push(`${moduleDir} (link removed)`)
  }
  if (existsSync(lockFile)) {
    const nextLock = withoutLockfileEntry(readFileSync(lockFile, 'utf8'))
    if (nextLock) { writeFileSync(lockFile, nextLock); removed.push(`${lockFile} (importer entry removed)`) }
    else manual.unshift(`run pnpm install in ${profileDir} to prune the dsh-superagent entry from pnpm-lock.yaml`)
  }
  const stateEntries = existsSync(stateDir) ? readdirSync(stateDir) : []
  if (stateEntries.length) {
    rmSync(stateDir, { recursive: true, force: true })
    removed.push(`${stateDir} (${stateEntries.length} entries: ${stateEntries.join(', ')})`)
  }
  if (existsSync(stateLock)) { rmSync(stateLock, { recursive: true, force: true }); removed.push(`${stateLock} (stale lock)`) }
  const controlDir = join(CONTROL, 'profiles', options.profile)
  if (existsSync(controlDir)) { rmSync(controlDir, { recursive: true, force: true }); removed.push(`${controlDir}`) }
  const logPattern = new RegExp('^' + `dsh-superagent-${options.profile}-`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d{8}-\\d{6}-\\d+\\.log$')
  const logs = existsSync(ARTIFACTS) ? readdirSync(ARTIFACTS).filter(file => logPattern.test(file)) : []
  for (const file of logs) rmSync(join(ARTIFACTS, file), { force: true })
  if (logs.length) removed.push(`${logs.length} service log(s) under ${ARTIFACTS}`)
  console.log(JSON.stringify({ profile: options.profile, dshHome, stateDir, backup: options.backup ? backupRoot : null, removed, manual }, null, 2))
  console.log('Note: DSH sessions that still reference the dsh-superagent-worker/router presets will fail to restore with agent-preset/not-found.')
  return 0
}

/**
 * 取得配置文件的控制锁，使两个操作无法交错。锁是一个命名其所有者的文件；
 * 已不再运行的进程留下的文件会被回收。
 */
function acquire(profile) {
  const lock = join(control(profile), 'operation.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(lock, 'wx')
      writeSync(descriptor, String(process.pid))
      closeSync(descriptor)
      return lock
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = Number(readFileSync(lock, 'utf8').trim())
      if (!owner || alive(owner)) throw new Error('Another dsh-superagent control operation is in progress.')
      rmSync(lock, { force: true })
    }
  }
  throw new Error('Another dsh-superagent control operation is in progress.')
}

/** 解析命令行，将用法错误写入标准错误，并像 `argparse` 那样以 2 退出。 */
function parse(argv) {
  const options = {
    action: undefined,
    profile: process.env.DSH_SUPERAGENT_PROFILE || 'superagent',
    url: process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3082',
    timeout: 60, stopTimeout: 300, respectStop: false, yes: false,
    dshHome: '', stateDir: '', backup: true, lockWait: 240, profileExplicit: false,
  }
  const usage = 'usage: dsh-superagent {start,stop,restart,status,reset,clean} [--profile NAME] [--url URL] [--yes]\n'
    + '       dsh-superagent clean [--dsh-home DIR] [--state-dir DIR] [--no-backup] [--lock-wait SECONDS] --yes'
  const fail = message => { console.error(message); console.error(usage); process.exit(2) }
  const actions = ['start', 'stop', 'restart', 'status', 'reset', 'clean']
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const value = name => argument.startsWith(name + '=') ? argument.slice(name.length + 1) : argv[++index]
    if (argument === '--respect-stop') options.respectStop = true
    else if (argument === '--yes' || argument === '-y') options.yes = true
    else if (argument === '--no-backup') options.backup = false
    else if (argument === '--profile' || argument.startsWith('--profile=')) { options.profile = value('--profile'); options.profileExplicit = true }
    else if (argument === '--url' || argument.startsWith('--url=')) options.url = value('--url')
    else if (argument === '--dsh-home' || argument.startsWith('--dsh-home=')) options.dshHome = value('--dsh-home')
    else if (argument === '--state-dir' || argument.startsWith('--state-dir=')) options.stateDir = value('--state-dir')
    else if (argument === '--lock-wait' || argument.startsWith('--lock-wait=')) options.lockWait = Number(value('--lock-wait'))
    else if (argument === '--timeout' || argument.startsWith('--timeout=')) options.timeout = Number(value('--timeout'))
    else if (argument === '--stop-timeout' || argument.startsWith('--stop-timeout=')) options.stopTimeout = Number(value('--stop-timeout'))
    else if (argument === '--help' || argument === '-h') { console.log(usage); process.exit(0) }
    else if (argument.startsWith('-')) fail(`unrecognized arguments: ${argument}`)
    else if (!options.action && actions.includes(argument)) options.action = argument
    else fail(`unrecognized arguments: ${argument}`)
  }
  if (!options.action) fail('the following arguments are required: action')
  if (!(options.timeout > 0) || !(options.stopTimeout > 0)) fail('--timeout and --stop-timeout must be positive')
  if (!(options.lockWait > 0)) fail('--lock-wait must be positive')
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(options.profile)) fail('--profile must be a DSH profile name')
  return options
}

async function main() {
  const options = parse(process.argv.slice(2))
  process.umask(0o077)
  // clean 可能自动检测 profile；控制锁与工件目录必须按最终 profile 命名。
  if (options.action === 'clean' && !options.profileExplicit) {
    const dshHome = options.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
    const detected = profilesWithPlugin(dshHome)
    if (detected.length === 1) { options.profile = detected[0]; console.log(`Found dsh-superagent in DSH profile: ${options.profile}`) }
    else if (detected.length > 1) throw new Error(`dsh-superagent is installed in several profiles (${detected.join(', ')}); pass --profile to choose one.`)
  }
  const lock = acquire(options.profile)
  try {
    if (options.respectStop && (options.action === 'start' || options.action === 'restart') && stopped(options.profile)) {
      console.log('Intentional stop is active; automatic recovery skipped.')
      return 0
    }
    if (options.action === 'status') return await status(options)
    if (options.action === 'reset') return await reset(options)
    if (options.action === 'clean') return await clean(options)
    if (options.action === 'stop' || options.action === 'restart') {
      // 只有停止会让自动恢复保持关闭；停止超时的重启会使其保持开启。
      await stop(options, options.action === 'stop')
    }
    if (options.action === 'start' || options.action === 'restart') return await start(options)
    return 0
  } finally { rmSync(lock, { force: true }) }
}

main().then(code => { process.exitCode = code }, error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
