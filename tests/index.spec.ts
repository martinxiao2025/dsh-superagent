import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, type Machine } from '../src/deployment.ts'
import { apply } from '../src/index.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
// 记录注册与构造的先后顺序，用于证明管理路由先于 Runtime 挂载。
const trace = vi.hoisted(() => [] as string[])
// 打桩 Runtime，以捕获解析后的 Machine 设置和重启回调；`readyReject` 让初始化失败可注入。
const runtimes = vi.hoisted(() => [] as { machine: Machine; restart: () => void; boot?: unknown }[])
const control = vi.hoisted(() => ({ readyReject: false }))
vi.mock('../src/app/runtime.ts', () => ({ Runtime: class {
  readonly ready: Promise<void>
  constructor(_ctx: unknown, readonly machine: Machine, readonly restart: () => void, readonly boot?: unknown) {
    trace.push('runtime:construct')
    this.ready = control.readyReject ? Promise.reject(new Error('database is locked')) : Promise.resolve()
    runtimes.push(this)
  }
  configured() { return true }
  startSources() {}
  async stop() {}
} }))
/** 只替换取锁：其余启动记录函数保持真实实现，测试据此检查写出的 startup.json。 */
const locks = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'elocked' }))
vi.mock('../src/app/startup.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/app/startup.ts')>()
  return { ...original, acquireStateLock: vi.fn(async (_dir: string,
    options?: { onWait?: (elapsedMs: number) => void }) => {
    if (locks.mode === 'elocked') {
      options?.onWait?.(1200)
      throw Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' })
    }
    return { release: async () => {}, onCompromised: () => {} }
  }) }
})
/** 模拟 Cordis 加载器原地更新易变配置引用。 */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }
const dirs: string[] = []
/** 每个用例独立的真实状态目录：启动记录会写在这里，便于直接读取核对。 */
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'dsh-index-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => { control.readyReject = false; locks.mode = 'ok'; trace.length = 0; runtimes.length = 0 })

function context() {
  const handlers = new Map<string, () => void>()
  const configure = vi.fn(() => () => {})
  const describe = vi.fn(() => [])
  const routes: { kind?: string; path?: string; handler: Handler }[] = []
  const ctx = {
    webServer: { host: '127.0.0.1', port: 3082, register: (route: { kind?: string; path?: string; handler: Handler }) => {
      trace.push('http:register')
      routes.push(route)
      return () => {}
    } },
    on: vi.fn((name: string, handler: () => void) => { handlers.set(name, handler) }),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => { callback({ effect: (effect: () => unknown) => effect(), settings: { configure } }) }),
    effect: vi.fn(),
    fiber: { restart: vi.fn(async () => {}) },
    get: vi.fn((name: string) => name === 'settings' ? { describe } : undefined),
    logger: { info: vi.fn(), error: vi.fn() },
  }
  return { ctx, handlers, configure, describe, routes }
}
/** 用面板同源头调用已登记的管理路由。 */
async function request(handler: Handler, method: string, path: string) {
  let status = 0, text = ''
  const req = { method, url: `/orchestrator/api/${path}`,
    headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() {} }
  await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}
const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>

it('reads a limit DSH commits a new value of without a restart, and asks DSH to generate no settings page', async () => {
  const { ctx, handlers, configure } = context()
  const dir = tempDir()
  const config = Config({ stateDir: dir, promptMaxChars: 5000 })
  await apply(ctx as never, config)
  expect(configure).toHaveBeenCalledExactlyOnceWith({ auto: false }, ctx.fiber)
  const { machine } = runtimes.at(-1)!
  expect(machine.promptMaxChars.get()).toBe(5000)
  commit(config.promptMaxChars, 8000)
  expect(machine.promptMaxChars.get()).toBe(8000)
  expect(handlers.has('loader/volatile-update')).toBe(false)
  expect(ctx.fiber.restart).not.toHaveBeenCalled()
  // 管理路由先于 Runtime 构造，初始化成功时最终阶段为 ready。
  expect(trace).toEqual(['http:register', 'runtime:construct'])
  expect(read(dir, 'startup.json')).toMatchObject({ phase: 'ready', stateDir: dir, listen: { host: '127.0.0.1', port: 3082 } })
  expect(read(dir, 'startup.prev.json')).toMatchObject({ phase: 'store-open' })
})

it('asks DSH to read its settings entry again once a restart it started finished', async () => {
  const { ctx, describe } = context()
  let finish = () => {}
  ctx.fiber.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await apply(ctx as never, Config({ stateDir: tempDir() }))
  // 保存来源账号的修改会重启 dsh-superagent，它会重新执行 setup 并刷新设置描述符。
  runtimes.at(-1)!.restart()
  await Promise.resolve()
  expect(describe).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
})

it('keeps the management route mounted and reports the lock phase when another instance holds the state lock', async () => {
  const { ctx, routes } = context()
  const dir = tempDir()
  locks.mode = 'elocked'
  // 锁等待超时不再让插件 apply 失败：面板仍能打开，健康接口与 503 说明卡在锁阶段。
  await expect(apply(ctx as never, Config({ stateDir: dir }))).resolves.toBeUndefined()
  expect(trace).toEqual(['http:register'])
  expect(runtimes).toHaveLength(0)
  expect(routes).toEqual([{ kind: 'prefix', path: '/orchestrator/api', handler: expect.any(Function) }])
  expect(await request(routes[0]!.handler, 'GET', 'health')).toMatchObject({ status: 200,
    body: { ok: false, phase: 'locked', machine: { stateDir: dir } } })
  expect(await request(routes[0]!.handler, 'GET', 'state')).toMatchObject({ status: 503,
    body: { code: 'startupPending', phase: 'locked', stateDir: dir } })
  expect(read(dir, 'startup.json')).toMatchObject({ phase: 'locked',
    error: { name: 'Error', message: 'Lock file is already being held' } })
})

it('reports a failed initialization without unmounting the management route', async () => {
  const { ctx, routes } = context()
  const dir = tempDir()
  control.readyReject = true
  await expect(apply(ctx as never, Config({ stateDir: dir }))).resolves.toBeUndefined()
  // Runtime 构造完成后 ready 失败：路由仍由本插件持有，并返回可诊断的 503。
  expect(trace).toEqual(['http:register', 'runtime:construct'])
  expect(routes).toHaveLength(1)
  expect(await request(routes[0]!.handler, 'GET', 'health')).toMatchObject({ status: 200,
    body: { ok: false, phase: 'failed', detail: expect.stringContaining('database is locked') } })
  expect(await request(routes[0]!.handler, 'GET', 'state')).toMatchObject({ status: 503,
    body: { code: 'startupPending', phase: 'failed', detail: expect.stringContaining('database is locked'), stateDir: dir } })
  expect(read(dir, 'startup.json')).toMatchObject({ phase: 'failed', error: { message: 'database is locked' } })
})

it('refuses keys of the previous configuration before registering anything', async () => {
  const { ctx } = context()
  await expect(apply(ctx as never, Config({ stateDir: tempDir(), github: { cli: 'gh' } } as never))).rejects.toThrow('github (now on each GitHub Source record)')
  expect(ctx.on).not.toHaveBeenCalled()
  expect(ctx.inject).not.toHaveBeenCalled()
  expect(trace).toEqual([])
})
