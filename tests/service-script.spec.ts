/** 使用带空格的临时检出路径以及打桩的 ps、tmux 和 dsh 程序测试 scripts/dsh-superagent.mjs。 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync }
  from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { programSource } from './fixtures/program.ts'

let root: string
let server: Server | undefined
let sleepers: ChildProcess[] = []
const control = (profile: string) => join(root, '.artifacts', 'control', 'profiles', profile)
const constant = (value: string) => JSON.stringify(value)
/** 将假程序写入检出的 `bin`，`run` 会把它放在 PATH 最前面。 */
const program = (name: string, body: string) => programSource(join(root, 'bin'), name, body)
/** 启动一个保持存活的真实 Node 进程，使假 ps 能列出它，脚本也能向它发送信号。 */
function sleeper(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  sleepers.push(child)
  return child.pid!
}
const service = (pid: number, profile = 'superagent') => `${pid} node node /opt/my tools/dsh --profile ${profile} --no-open`
/** 为假 ps 写入活动进程行（`pid ucomm args`）。以 `after:<pid> ` 为前缀的条目仅在该 PID 退出后出现。 */
const processes = (...lines: string[]) => writeFileSync(join(root, 'ps.txt'), lines.map(line => `${line}\n`).join(''))
const started = (...lines: string[]) => writeFileSync(join(root, 'ps-started.txt'), lines.map(line => `${line}\n`).join(''))
/** 一个假 `tmux`，记录其参数，并在创建会话时打印写入 `pane` 的 PID。 */
const tmuxFake = (sessionExists = false) => program('tmux', `const fs = require('node:fs')
const root = ${constant(root)}
fs.appendFileSync(root + '/tmux.log', argv.join('\\n') + '\\n---\\n')
if (argv[0] === 'has-session') return ${sessionExists ? 0 : 1}
if (argv[0].startsWith('new-')) {
  fs.writeFileSync(root + '/launched', '')
  process.stdout.write(fs.readFileSync(root + '/pane', 'utf8'))
  return 0
}
return 1`)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent.mjs'), join(root, 'scripts', 'dsh-superagent.mjs'))
  processes()
  program('ps', `const fs = require('node:fs')
const root = ${constant(root)}
let list = root + '/ps.txt'
if (fs.existsSync(root + '/launched') && fs.existsSync(root + '/ps-started.txt')) list = root + '/ps-started.txt'
const index = argv.indexOf('-p')
const want = index >= 0 ? argv[index + 1] : undefined
const alive = pid => { try { process.kill(Number(pid), 0); return true } catch { return false } }
for (const raw of fs.readFileSync(list, 'utf8').split('\\n')) {
  if (!raw) continue
  let line = raw
  let ghost = false
  if (line.startsWith('ghost:')) { ghost = true; line = line.slice('ghost:'.length) }
  if (line.startsWith('after:')) {
    const rest = line.slice('after:'.length)
    const dependency = rest.slice(0, rest.indexOf(' '))
    if (alive(dependency)) continue
    line = rest.slice(dependency.length + 1)
  }
  const pid = line.slice(0, line.indexOf(' '))
  if (!ghost && !alive(pid)) continue
  if (want !== undefined && pid !== want) continue
  console.log(line)
}`)
  tmuxFake()
  program('dsh', 'return 0')
})
afterEach(() => {
  server?.close(); server = undefined
  for (const child of sleepers) child.kill()
  sleepers = []
  rmSync(root, { recursive: true, force: true })
})
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(process.execPath, [join(root, 'scripts', 'dsh-superagent.mjs'), ...args],
    { env: { ...process.env, PATH: [join(root, 'bin'), process.env.PATH].join(delimiter), DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '' },
      timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
/** 启动一个模拟 HTTP 服务器；除非 always 为 true，否则在 tmux 启动服务前返回 503。 */
async function answering(state: unknown = READY, always = false): Promise<string> {
  server = createServer((_request, response) => {
    if (!always && !existsSync(join(root, 'launched'))) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
const status = async (profile: string, url = 'http://127.0.0.1:9') =>
  JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as { pids: number[]; manually_stopped: boolean }

it('refuses to stop when two processes serve the profile, before it writes the stop marker', async () => {
  processes(service(sleeper()), `${sleeper()} node node /opt/dsh --profile=superagent`)
  expect(await run('stop')).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes found') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
})
it('keeps a stop per profile', async () => {
  expect(await run('stop', '--profile', 'one')).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  expect(await status('one')).toMatchObject({ manually_stopped: true })
  expect(await status('two')).toMatchObject({ manually_stopped: false })
  const skipped = await run('--respect-stop', 'start', '--profile', 'one')
  expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('Intentional stop is active') })
})
it('takes no `dsh plugin` command of the profile for its service', async () => {
  const service = sleeper()
  processes(`${sleeper()} node node /opt/my tools/dsh plugin --profile superagent add link:/x`,
    `${service} node node /opt/my tools/dsh --profile superagent --no-open`)
  expect(await status('superagent')).toMatchObject({ pids: [service] })
})
it('records the service PID at start, and still refuses a second instance the scan finds', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  const start = await run('start', '--url', url, '--timeout', '10')
  expect(start).toMatchObject({ code: 0, stdout: expect.stringContaining(`"pids": [\n    ${pid}\n  ]`) })
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  const tmux = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').find(call => call.startsWith('new-session'))!.split('\n')
  // 检出的路径含有空格，它作为一个参数，其中的日志路径为 tmux 运行的 POSIX shell 加上了引号。
  const checkout = realpathSync(root)
  expect(tmux).toEqual(expect.arrayContaining(['-P', '-F', '#{pane_pid}', '-c', checkout]))
  const command = tmux.find(word => word.startsWith('umask 077; exec '))!
  expect(command).toContain(`>> '${join(checkout, '.artifacts')}`)
  expect(command).toMatch(/dsh-superagent-superagent-\d{8}-\d{6}-\d+\.log' 2>&1$/)
  const second = sleeper()
  started(service(pid), `${second} node node /opt/dsh --profile superagent`)
  const again = await run('start', '--url', url, '--timeout', '10')
  expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes') })
  expect(await status('superagent')).toMatchObject({ pids: [pid, second] })
}, 20_000)
it('waits only for the process it stopped', async () => {
  const pid = sleeper()
  // 被停止的实例结束后，另一个实例会出现。
  processes(service(pid), `after:${pid} ${sleeper()} node node /opt/dsh --profile superagent`)
  expect(await run('stop', '--stop-timeout', '5')).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped') })
}, 20_000)
it('keeps only the newest logs it wrote for the profile', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  for (const profile of ['superagent', 'other']) for (let index = 0; index < 25; index++) {
    const log = join(root, '.artifacts', `dsh-superagent-${profile}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
    writeFileSync(log, '')
    utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
  }
  writeFileSync(join(root, '.artifacts', 'dsh-superagent-20260901-000000-1.log'), '')
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const logs = readdirSync(join(root, '.artifacts'))
  const own = logs.filter(name => name.startsWith('dsh-superagent-superagent-')).sort()
  expect(own).toHaveLength(20)
  // 最旧的日志被删除；新日志保留，并保留最新的若干较早日志。其他配置文件的日志和旧命名保留。
  expect(own).not.toContain('dsh-superagent-superagent-20260901-000000-1.log')
  expect(own.filter(name => !name.startsWith('dsh-superagent-superagent-20260901-'))).toHaveLength(1)
  expect(logs.filter(name => name.startsWith('dsh-superagent-other-'))).toHaveLength(25)
  expect(logs).toContain('dsh-superagent-20260901-000000-1.log')
}, 20_000)
it('reports a service whose Feishu bot setup could not check as running, and reads an answer with keys missing', async () => {
  processes(service(sleeper()))
  const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
    setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
  expect(await run('status', '--url', await answering(feishu, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'ready' } } }, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'error' } } }, true))).toMatchObject({ code: 1 })
})
it('exits 2 while a part such as a Source reports an error, which a restart does not fix, and prints what it reports', async () => {
  processes(service(sleeper()))
  const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
  const url = await answering(github, true)
  const checked = await run('status', '--url', url)
  expect(checked.code).toBe(2)
  expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('github reports an error, which a restart does not fix: bad token') })
}, 20_000)
it('exits 3 while the service waits for setup, from status and from start, which a restart does not fix', async () => {
  processes(service(sleeper()))
  const waiting = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
  const url = await answering(waiting, true)
  expect(await run('status', '--url', url)).toMatchObject({ code: 3 })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 3, stdout: expect.stringContaining('waiting for setup: The GitHub Source names no repository.') })
}, 20_000)
it('restarts the service, and a restart whose graceful stop timed out does not keep recovery off', async () => {
  const url = await answering()
  const old = sleeper(), pid = sleeper()
  processes(service(old))
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  const restarted = await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '5')
  expect(restarted).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped.') })
  expect(restarted.stdout).not.toContain('Automatic recovery is paused')
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  // 未能及时停止的服务会保持运行，下一次检查可以重启它。
  rmSync(join(root, 'launched'))
  processes(`ghost:${sleeper()} node node /opt/dsh --profile superagent --no-open`)
  expect(await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '1'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(await status('superagent')).toMatchObject({ manually_stopped: false })
}, 20_000)
it('refuses a second control operation while one holds the profile\'s lock', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const held = join(root, 'held')
  const holder = spawn(process.execPath, ['-e', `const fs = require('node:fs')
const descriptor = fs.openSync(${constant(join(control('superagent'), 'operation.lock'))}, 'wx')
fs.writeSync(descriptor, String(process.pid))
fs.writeFileSync(${constant(held)}, '')
setInterval(() => {}, 1000)`], { stdio: 'ignore' })
  sleepers.push(holder)
  while (!existsSync(held)) await new Promise(resolve => setTimeout(resolve, 50))
  expect(await run('status')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('Another dsh-superagent control operation is in progress') })
}, 20_000)
it('refuses to start a service while no process runs it but something answers at its URL', async () => {
  const url = await answering(READY, true)
  expect(await run('start', '--url', url, '--timeout', '5'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('An existing orchestrator answers at this URL') })
  expect(readFileSync(join(root, 'tmux.log'),
    'utf8').split('---\n').filter(Boolean).map(call => call.split('\n')[0])).toEqual(['has-session'])
}, 20_000)
it('starts the service in a new window of the profile\'s tmux session when the session exists', async () => {
  tmuxFake(true)
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const calls = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').map(call => call.split('\n'))
  expect(calls.find(call => call[0] === 'new-window')).toEqual(expect.arrayContaining(['-t', '=dsh-superagent:']))
  expect(calls.some(call => call[0] === 'new-session')).toBe(false)
}, 20_000)
it('exits 1 when the started service does not answer in time, and leaves its process running', async () => {
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Startup health check timed out') })
  expect(() => process.kill(pid, 0)).not.toThrow()
}, 20_000)
it('does not signal a process that took the recorded service PID, and keeps a stop that timed out', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const other = sleeper()
  processes(`${other} sleep sleep 60`)
  writeFileSync(join(control('superagent'), 'service.pid'), `${other}\n`)
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 0 })
  expect(() => process.kill(other, 0)).not.toThrow()
  // 未能及时停止的服务会保留停止标记，因此恢复流程不会再次启动它。
  rmSync(join(control('superagent'), 'manually-stopped'))
  processes(`ghost:${sleeper()} node node /opt/my tools/dsh --profile superagent --no-open`)
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(true)
}, 20_000)

// ── clean：卸载清理 ─────────────────────────────────────────────────────────
/** 在 `root` 下伪造一个 DSH home：一个引用了本插件的 profile 及其状态目录。 */
function fakeDshHome() {
  const home = join(root, 'dsh-home')
  const profileDir = join(home, 'profiles', 'superagent')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  const stateDir = join(root, 'state superagent')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: ${stateDir}
`)
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'superagent-profile',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-web', 'dsh-superagent'] } },
    dependencies: { '@deepseek-ai/dsh-web': '0.2.1', 'dsh-superagent': `link:${root.replaceAll('\\', '/')}` },
  }, null, 2) + '\n')
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      '@deepseek-ai/dsh-web':
        specifier: 0.2.1
        version: 0.2.1
      dsh-superagent:
        specifier: link:${root.replaceAll('\\', '/')}
        version: link:${root.replaceAll('\\', '/')}

packages: {}
`)
  mkdirSync(join(profileDir, 'node_modules', 'dsh-superagent'), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', 'dsh-superagent', 'package.json'), '{"name": "dsh-superagent"}\n')
  writeFileSync(join(stateDir, 'orchestrator.sqlite'), '')
  writeFileSync(join(stateDir, 'notes.txt'), 'foreign')
  return { home, profileDir, stateDir }
}
/** `run`，但把脚本看到的用户主目录重定向到 `home`（备份写入那里）。 */
function runAs(home: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(process.execPath, [join(root, 'scripts', 'dsh-superagent.mjs'), ...args],
    { env: { ...process.env, HOME: home, USERPROFILE: home, PATH: [join(root, 'bin'), process.env.PATH].join(delimiter), DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '' },
      timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}

it('clean refuses without --yes and leaves the install in place', async () => {
  const { home, profileDir, stateDir } = fakeDshHome()
  const before = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  expect(await run('clean', '--dsh-home', home)).toMatchObject({ code: 1, stderr: expect.stringContaining('pass --yes to confirm') })
  expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(before)
  expect(existsSync(stateDir)).toBe(true)
})
it('clean removes plugin references, the module directory, the state and this profile\'s artifacts, and backs everything up', async () => {
  const { home, profileDir, stateDir } = fakeDshHome()
  mkdirSync(control('superagent'), { recursive: true })
  writeFileSync(join(control('superagent'), 'manually-stopped'), '')
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  writeFileSync(join(root, '.artifacts', 'dsh-superagent-superagent-20260901-000000-1.log'), '')
  writeFileSync(join(root, '.artifacts', 'dsh-superagent-other-20260901-000000-1.log'), '')
  const backupHome = join(root, 'home')
  mkdirSync(backupHome, { recursive: true })
  const cleaned = await runAs(backupHome, 'clean', '--dsh-home', home, '--yes')
  expect(cleaned).toMatchObject({ code: 0, stdout: expect.stringContaining('"removed"') })
  // patch 只剩无关条目，package.json 去掉本插件但保留其他依赖，lockfile 条目消失。
  expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).not.toContain('dsh-superagent')
  expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('- id: webserver')
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  expect(pkg.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-web'])
  expect(pkg.dependencies).toEqual({ '@deepseek-ai/dsh-web': '0.2.1' })
  expect(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')).not.toContain('dsh-superagent')
  expect(existsSync(join(profileDir, 'node_modules', 'dsh-superagent'))).toBe(false)
  expect(existsSync(stateDir)).toBe(false)
  expect(existsSync(control('superagent'))).toBe(false)
  const artifacts = readdirSync(join(root, '.artifacts'))
  expect(artifacts).toContain('dsh-superagent-other-20260901-000000-1.log')
  expect(artifacts).not.toContain('dsh-superagent-superagent-20260901-000000-1.log')
  // 备份包含 patch 原文与状态目录的外来文件。
  const backups = readdirSync(join(backupHome, 'dsh-superagent-backup'))
  expect(backups).toHaveLength(1)
  expect(readFileSync(join(backupHome, 'dsh-superagent-backup', backups[0]!, 'profile', 'cordis.patch.yml'), 'utf8')).toContain('- id: dsh-superagent')
  expect(existsSync(join(backupHome, 'dsh-superagent-backup', backups[0]!, 'state', 'notes.txt'))).toBe(true)
})
it('clean restores the patch and keeps the state when an external instance holds the state lock', async () => {
  const { home, profileDir, stateDir } = fakeDshHome()
  mkdirSync(stateDir + '.lock', { recursive: true })
  writeFileSync(join(stateDir, 'startup.json'), JSON.stringify({ pid: sleeper(), phase: 'ready' }))
  const before = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  mkdirSync(join(root, 'home'), { recursive: true })
  const result = await runAs(join(root, 'home'), 'clean', '--dsh-home', home, '--lock-wait', '1', '--yes')
  expect(result).toMatchObject({ code: 1, stderr: expect.stringContaining('state lock was not released') })
  expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(before)
  expect(existsSync(join(profileDir, 'node_modules', 'dsh-superagent'))).toBe(true)
  expect(existsSync(stateDir)).toBe(true)
}, 20_000)
it('clean removes a stale state lock left by a dead instance', async () => {
  const { home, stateDir } = fakeDshHome()
  rmSync(join(stateDir, 'notes.txt'))
  mkdirSync(stateDir + '.lock', { recursive: true })
  writeFileSync(join(stateDir, 'startup.json'), JSON.stringify({ pid: 999_999, phase: 'ready' }))
  const lock = stateDir + '.lock'
  utimesSync(lock, 1_700_000_000, 1_700_000_000)
  expect(await runAs(join(root, 'home'), 'clean', '--dsh-home', home, '--yes')).toMatchObject({ code: 0 })
  expect(existsSync(lock)).toBe(false)
})
it('clean reports nothing to do when no profile references the plugin', async () => {
  const home = join(root, 'dsh-home')
  mkdirSync(join(home, 'profiles', 'fresh'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'fresh', 'cordis.patch.yml'), '- id: webserver\n')
  expect(await run('clean', '--dsh-home', home, '--yes'))
    .toMatchObject({ code: 0, stdout: expect.stringContaining('nothing to clean') })
})
it('clean auto-detects the only profile that has the plugin and leaves other profiles alone', async () => {
  const { home, profileDir, stateDir } = fakeDshHome()
  const other = join(home, 'profiles', 'other')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'cordis.patch.yml'), '- id: webserver\n')
  writeFileSync(join(other, 'package.json'), '{"dsh": {"profile": {"bundles": ["dsh-superagent"]}}}\n')
  const result = await runAs(join(root, 'home'), 'clean', '--dsh-home', home, '--yes')
  expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('Found dsh-superagent in DSH profile: superagent') })
  expect(existsSync(stateDir)).toBe(false)
  expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).not.toContain('dsh-superagent')
  // 另一个 profile 虽然手写了 bundles 引用，但没有被清理：自动检测只认 patch 条目，避免误伤。
  expect(readFileSync(join(other, 'package.json'), 'utf8')).toContain('dsh-superagent')
})
