/**
 * 调度器脚本（`worker-dispatch.mjs`）的直接单测：把 `WORKER_DISPATCH_BODY` 写入临时 stateDir 后以 Node 直接运行，
 * 不经垫片与 `writeEnvironment`，逐条验证命令识别、记录选择（显式 → 祖先登记 → 唯一记录）、PATH 清洗与转发行为。
 * 假 CLI 一律经 `programSource` 生成，Windows 上走 `.cmd` 启动器，与产品的批处理启动分支一致。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKER_DISPATCH_BODY, ticketKey } from '../src/infra/worker-sources.ts'
import { programSource, runProgram } from './fixtures/program.ts'

// 测试套件并行运行时，子进程可能超过 5 秒的默认超时。
vi.setConfig({ testTimeout: 30_000 })
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-dispatch-'))
  mkdirSync(join(dir, 'real'), { recursive: true })
  writeFileSync(join(dir, 'worker-dispatch.mjs'), WORKER_DISPATCH_BODY)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 假 CLI 打印的内容：自己的名字、收到的 argv、PATH 与标记变量。 */
interface Probe { name: string; argv: string[]; path: string; marker: string }
/** 写一个把自己名字与所见环境打印为 JSON 的假 CLI。 */
const probeCli = (name: string): string => programSource(join(dir, 'real'), name,
  `console.log(JSON.stringify({ name: ${JSON.stringify(name)}, argv, path: env.PATH, marker: env.MY_DISPATCH_MARKER }))`)
/** 直接写分发数据文件，绕开写入侧：`tickets` 的目录键按与调度器相同的规则规范化。 */
const records = (clis: Record<string, { kind: string; cli: string }>, tickets: Record<string, string> = {}): void => {
  writeFileSync(join(dir, 'worker-sources.json'), JSON.stringify({
    clis, tickets: Object.fromEntries(Object.entries(tickets).map(([directory, id]) => [ticketKey(directory), id])),
  }))
}
/** 以 Node 直接运行调度器脚本；PATH 预置 worker-bin（应被清洗）与假 CLI 所在目录。 */
const dispatch = (args: string[], options: { cwd?: string; source?: string } = {}): ReturnType<typeof runProgram> => {
  const env: Record<string, string | undefined> = { ...process.env, MY_DISPATCH_MARKER: 'kept',
    PATH: [join(dir, 'worker-bin'), join(dir, 'real'), process.env.PATH ?? ''].join(delimiter) }
  delete env.DSH_SUPERAGENT_SOURCE
  if (options.source) env.DSH_SUPERAGENT_SOURCE = options.source
  return runProgram(process.execPath, [join(dir, 'worker-dispatch.mjs'), ...args], { cwd: options.cwd ?? dir, env, timeout: 15_000 })
}
/** 失败运行的退出码与 stderr 首行。 */
const failureOf = async (args: string[], options: { cwd?: string; source?: string } = {}): Promise<{ code: number | undefined; stderr: string }> => {
  const error = await dispatch(args, options).catch((e: unknown) => e) as { code?: number; stderr?: string }
  return { code: error.code, stderr: (error.stderr ?? '').trim() }
}

describe('worker dispatch script', () => {
  it('rejects commands that no Source kind serves', async () => {
    const failure = await failureOf(['hub'])
    expect(failure).toEqual({ code: 1, stderr: 'hub is not a dsh-superagent worker command' })
  })
  it('prefers the record named by DSH_SUPERAGENT_SOURCE, but only when it serves the command', async () => {
    const cli = probeCli('gh-probe')
    records({ alpha: { kind: 'github', cli }, beta: { kind: 'github', cli }, chat: { kind: 'feishu', cli } })
    expect(JSON.parse((await dispatch(['gh'], { source: 'beta' })).stdout) as Probe).toMatchObject({ name: 'gh-probe', argv: [] })
    // 指向错误种类的记录不作数：回到歧义失败，而不是落到按位置选择。
    const failure = await failureOf(['gh'], { source: 'chat' })
    expect(failure).toEqual({ code: 1, stderr: 'gh cannot choose a Source record: this installation has 2 GitHub Sources (alpha, beta); '
      + "run it inside a ticket directory so it uses the ticket's Source record." })
  })
  it('walks up from the current directory and takes the nearest ticket registration', async () => {
    records({ alpha: { kind: 'github', cli: probeCli('gh-alpha') }, beta: { kind: 'github', cli: probeCli('gh-beta') } })
    const base = join(dir, 'tickets', 'base'), nested = join(base, 'nested')
    mkdirSync(nested, { recursive: true })
    records({ alpha: { kind: 'github', cli: probeCli('gh-alpha') }, beta: { kind: 'github', cli: probeCli('gh-beta') } },
      { [base]: 'alpha', [nested]: 'beta' })
    // 最近的一层登记获胜：嵌套目录用 beta，其父目录用 alpha。
    expect(JSON.parse((await dispatch(['gh'], { cwd: nested })).stdout) as Probe).toMatchObject({ name: 'gh-beta' })
    expect(JSON.parse((await dispatch(['gh'], { cwd: base })).stdout) as Probe).toMatchObject({ name: 'gh-alpha' })
  })
  it('falls back to the only record of the kind, never to the first of several', async () => {
    records({ only: { kind: 'github', cli: probeCli('gh-only') } })
    expect(JSON.parse((await dispatch(['gh'])).stdout) as Probe).toMatchObject({ name: 'gh-only' })
    records({ alpha: { kind: 'github', cli: probeCli('gh-alpha') }, beta: { kind: 'github', cli: probeCli('gh-beta') } })
    const failure = await failureOf(['gh'])
    expect(failure).toEqual({ code: 1, stderr: 'gh cannot choose a Source record: this installation has 2 GitHub Sources (alpha, beta); '
      + "run it inside a ticket directory so it uses the ticket's Source record." })
  })
  it('reports unavailable sources with the kinds the command serves', async () => {
    records({})
    await expect(failureOf(['gh'])).resolves.toEqual({ code: 1, stderr: 'gh is unavailable: this installation has no GitHub Source.' })
    // git-credential 只服务会托管 Git 仓库的两类来源，且向 git 而不是命令名报错。
    records({ chat: { kind: 'feishu', cli: probeCli('lark-probe') } })
    await expect(failureOf(['git-credential']))
      .resolves.toEqual({ code: 1, stderr: 'git is unavailable: this installation has no GitHub or GitLab Source.' })
  })
  it('treats a corrupt worker-sources.json as no sources at all', async () => {
    writeFileSync(join(dir, 'worker-sources.json'), '{ not json')
    await expect(failureOf(['gh'])).resolves.toEqual({ code: 1, stderr: 'gh is unavailable: this installation has no GitHub Source.' })
  })
  it('leaves its own bin directory out of the CLI\'s PATH and keeps the other entries and variables', async () => {
    records({ acme: { kind: 'github', cli: probeCli('gh-probe') } })
    const extra = join(dir, 'other')
    // worker-bin 的两种拼写（含 Windows 大小写不同）都应离开 PATH。
    const env: Record<string, string | undefined> = { ...process.env, MY_DISPATCH_MARKER: 'kept',
      PATH: [join(dir, 'worker-bin'), ...(process.platform === 'win32' ? [join(dir, 'WORKER-BIN')] : []), extra, process.env.PATH ?? ''].join(delimiter) }
    delete env.DSH_SUPERAGENT_SOURCE
    const probe = JSON.parse((await runProgram(process.execPath, [join(dir, 'worker-dispatch.mjs'), 'gh'],
      { cwd: dir, env, timeout: 15_000 })).stdout) as Probe
    // 其余条目按原顺序保留，非 PATH 变量原样传递。
    expect(probe.path).toBe([extra, process.env.PATH ?? ''].join(delimiter))
    expect(probe.marker).toBe('kept')
  })
  it('forwards arguments, injects the git credential protocol, and passes the CLI\'s exit code through', async () => {
    records({ acme: { kind: 'github', cli: probeCli('gh-probe') } })
    expect(JSON.parse((await dispatch(['gh', 'api', 'user'])).stdout) as Probe)
      .toEqual({ name: 'gh-probe', argv: ['api', 'user'], path: expect.any(String), marker: 'kept' })
    expect(JSON.parse((await dispatch(['git-credential', 'fill'])).stdout) as Probe)
      .toEqual({ name: 'gh-probe', argv: ['auth', 'git-credential', 'fill'], path: expect.any(String), marker: 'kept' })
    records({ acme: { kind: 'github', cli: programSource(join(dir, 'real'), 'gh-fail', 'return 3') } })
    await expect(failureOf(['gh'])).resolves.toMatchObject({ code: 3 })
  })
  it('reports a CLI it cannot start instead of failing silently', async () => {
    const missing = join(dir, 'real', 'nowhere')
    records({ acme: { kind: 'github', cli: missing } })
    const failure = await failureOf(['gh'])
    expect(failure).toEqual({ code: 1, stderr: `gh could not run ${missing}: spawnSync ${missing} ENOENT` })
  })
})
