#!/usr/bin/env node
/**
 * Manage a local dsh-superagent service (one DSH profile, default `superagent`) without affecting other tmux sessions.
 *
 * `status`, `start`, and `restart` exit 0 while the service runs normally; 1 when it is stopped, duplicated, unreachable, or
 * reporting a runtime error, which `restart` may fix; 2 when it runs while a component such as a Source reports an error;
 * and 3 when it runs and waits for setup. A restart fixes neither 2 nor 3: they need a person.
 *
 * The script is plain Node.js so it starts on every platform the bundle installs on; `ps` and `tmux` are still required
 * to run a service, and are resolved through PATH.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { request } from 'node:http'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const ARTIFACTS = join(ROOT, '.artifacts')
const CONTROL = join(ARTIFACTS, 'control')
const KEEP_LOGS = 20

/** Return the control directory for `profile`, creating it if needed. */
function control(profile) {
  const directory = join(CONTROL, 'profiles', profile)
  mkdirSync(directory, { recursive: true })
  return directory
}

/** Return whether `profile` was intentionally stopped. */
const stopped = profile => existsSync(join(control(profile), 'manually-stopped'))

/** Return whether command-line arguments belong to the main DSH service process for `profile`. */
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

/** The extensions a bare command name may carry on this platform, as `cmd` and `which` do. */
const EXTENSIONS = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']

/** Resolve `name` on PATH to an executable file, or return undefined. */
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

/** Quote one argument for a `cmd.exe /c` command line, doubling embedded quotes as cmd expects. */
const cmdQuote = argument => `"${argument.replaceAll('"', '""')}"`
/**
 * The file and argument list that start `program`. A batch file needs `cmd.exe`, because Windows cannot start it
 * directly; cmd strips one layer of quotes after `/s /c`, so the whole command is quoted once more.
 */
const commandOf = (program, args) => process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(program)
  ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[program, ...args].map(cmdQuote).join(' ')}"`]]
  : [program, args]

/** Return whether `pid` names a running process. */
function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Yield `[pid, command name, argv]` from `ps`. Arguments are split on whitespace, so paths with spaces become several
 * words and only `--profile` and subcommands are inspected.
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

/** Return whether `pid` is currently running the DSH service for `profile` (`ps -p` returns nothing once exited). */
const running = (pid, profile) => ps(['-p', String(pid)]).some(([found, name, args]) => found === pid && (name === 'node' || name === 'dsh') && serves(args, profile))

/**
 * Return the PIDs of all running DSH service processes for `profile`, including instances started outside this script
 * and the recorded `service.pid` while it still runs.
 */
function processes(profile) {
  const found = ps(['-ax'], true).filter(([, name, args]) => (name === 'node' || name === 'dsh') && serves(args, profile)).map(([pid]) => pid)
  let recorded
  try { recorded = Number(readFileSync(join(control(profile), 'service.pid'), 'utf8').trim()) } catch { return found }
  return Number.isInteger(recorded) && recorded > 0 && !found.includes(recorded) && running(recorded, profile) ? [...found, recorded] : found
}

/**
 * Fetch health and setup status from the management API, or return undefined if unreachable.
 * The request deliberately avoids a keep-alive agent and long-lived handles, so a CLI run exits as soon as it is done.
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

/** Reduce a management API answer to the health and setup fields the CLI reports. */
function summarize(value) {
  // Keys omitted by another version read as empty so the service is not mistaken for unreachable.
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

/** Return whether the runtime is ready or paused awaiting operator action; a component still starting does not hold this up. */
const runtimeUp = current => current !== undefined && ['ready', 'paused'].includes(current.health.runtime)

/** Return non-runtime components that are in an error state. */
const partErrors = current => Object.fromEntries(Object.entries(current.errors).filter(([name]) => name !== 'runtime').sort(([a], [b]) => a.localeCompare(b)))

/** Compute the CLI exit code from running PIDs and management API state. */
function outcome(pids, current) {
  if (pids.length !== 1 || !runtimeUp(current)) return 1
  if (current.setup) return SETUP_WAITS
  // A component's lasting error, unlike a Feishu bot check that failed during setup, requires operator action.
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

/** The current local time as `YYYY-MM-DDTHH:MM:SS+ZZZZ`. */
function timestamp() {
  const now = new Date()
  const pad = value => String(Math.trunc(Math.abs(value))).padStart(2, '0')
  const offset = -now.getTimezoneOffset()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `${offset >= 0 ? '+' : '-'}${pad(offset / 60)}${pad(offset % 60)}`
}

/** Stop the service gracefully, recording a manual stop marker when `intentional` is true. */
async function stop(options, intentional = true) {
  const pids = processes(options.profile)
  if (pids.length > 1) throw new Error('Multiple dsh-superagent processes found; refusing to choose one.')
  // Write the stop marker before waiting so monitors respect the intentional stop even if graceful shutdown times out.
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

/** Retain only the newest `KEEP_LOGS` log files for `profile`. */
function pruneLogs(profile) {
  const name = new RegExp('^' + `dsh-superagent-${profile}-`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d{8}-\\d{6}-\\d+\\.log$')
  const logs = readdirSync(ARTIFACTS).filter(file => name.test(file)).map(file => join(ARTIFACTS, file))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  for (const file of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) rmSync(file, { force: true })
}

/** Quote one word for a POSIX shell, as tmux runs the start command. */
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
    // `exec` replaces the shell so the pane PID printed by tmux is the DSH service process itself.
    const command = 'umask 077; exec ' + [dsh, '--profile', options.profile, '--no-open'].map(shellQuote).join(' ')
      + ' >> ' + shellQuote(log) + ' 2>&1'
    // Reuse an existing tmux session without disturbing other windows.
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

/** The local stamp of a log file name, `YYYYMMDD-HHMMSS`. */
function localStamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Take the profile's control lock, so two operations cannot interleave. The lock is a file naming its owner;
 * a file left by a process that no longer runs is reclaimed.
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

/** Parse the command line, writing usage errors to standard error and exiting 2 as `argparse` did. */
function parse(argv) {
  const options = {
    action: undefined,
    profile: process.env.DSH_SUPERAGENT_PROFILE || 'superagent',
    url: process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3082',
    timeout: 60, stopTimeout: 300, respectStop: false,
  }
  const fail = message => { console.error(message); console.error('usage: dsh-superagent {start,stop,restart,status} [--profile NAME] [--url URL]'); process.exit(2) }
  const actions = ['start', 'stop', 'restart', 'status']
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const value = name => argument.startsWith(name + '=') ? argument.slice(name.length + 1) : argv[++index]
    if (argument === '--respect-stop') options.respectStop = true
    else if (argument === '--profile' || argument.startsWith('--profile=')) options.profile = value('--profile')
    else if (argument === '--url' || argument.startsWith('--url=')) options.url = value('--url')
    else if (argument === '--timeout' || argument.startsWith('--timeout=')) options.timeout = Number(value('--timeout'))
    else if (argument === '--stop-timeout' || argument.startsWith('--stop-timeout=')) options.stopTimeout = Number(value('--stop-timeout'))
    else if (argument === '--help' || argument === '-h') { console.log('usage: dsh-superagent {start,stop,restart,status} [--profile NAME] [--url URL]'); process.exit(0) }
    else if (argument.startsWith('-')) fail(`unrecognized arguments: ${argument}`)
    else if (!options.action && actions.includes(argument)) options.action = argument
    else fail(`unrecognized arguments: ${argument}`)
  }
  if (!options.action) fail('the following arguments are required: action')
  if (!(options.timeout > 0) || !(options.stopTimeout > 0)) fail('--timeout and --stop-timeout must be positive')
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(options.profile)) fail('--profile must be a DSH profile name')
  return options
}

async function main() {
  const options = parse(process.argv.slice(2))
  process.umask(0o077)
  const lock = acquire(options.profile)
  try {
    if (options.respectStop && (options.action === 'start' || options.action === 'restart') && stopped(options.profile)) {
      console.log('Intentional stop is active; automatic recovery skipped.')
      return 0
    }
    if (options.action === 'status') return await status(options)
    if (options.action === 'stop' || options.action === 'restart') {
      // Only a stop keeps automatic recovery off; a restart whose stop timed out leaves it on.
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
