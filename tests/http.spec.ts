import { expect, it } from 'vitest'
import { z } from 'zod'
import { UserError } from '../src/core/index.ts'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import type { StartupStatus } from '../src/app/startup.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
type Route = { kind?: string; path?: string }
/** 在伪造的 Web 服务器上登记管理路由，返回带默认面板头的请求辅助函数与登记参数。 */
function mount(source: HttpHost | (() => HttpHost | undefined), status?: () => StartupStatus, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const routes: Route[] = []
  const ctx = { webServer: { host, port: 3082, register: (route: Route & { handler: Handler }) => {
    handler = route.handler
    routes.push({ kind: route.kind, path: route.path })
    return () => {}
  } } }
  registerHttp(ctx as never, source as never, status as never)
  const call = async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  return { call, routes }
}
/** 用已就绪的运行时挂载管理路由（`Runtime` 自挂载与测试的独立运行时都走这条路径）。 */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  return mount({ ready: Promise.resolve(), ...runtime } as unknown as HttpHost, undefined, host).call
}
/** 运行时尚未创建或初始化失败：请求辅助函数与启动状态一起返回。 */
function servePending(status: StartupStatus, host = '127.0.0.1') {
  return mount(() => undefined, () => status, host)
}

it('creates and deletes Source records and answers the health probe', async () => {
  const calls: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}) },
    machine: { stateDir: '/srv/dsh-superagent' },
    sources: { instances: () => [{ id: 'github', kind: 'github', enabled: true, installed: true }], kindByName: () => ({ health: ['github'] }) },
    health: { github: { state: 'ready', detail: '' } },
    configured: () => true, sourceProblems: {},
    settings: {
      save: async () => ({ saved: true, revision: 0, restarting: false }),
      createSource: async (...args: unknown[]) => { calls.push(args); return { id: 'github-2', revision: 0, restarting: true } },
      removeSource: async (...args: unknown[]) => { calls.push(args); return { removed: true, restarting: true } },
    },
  })
  expect(await call('POST', 'sources', { kind: 'github', name: '第二个 GitHub' })).toEqual({ status: 200, body: { id: 'github-2', revision: 0,
    restarting: true } })
  expect(calls[0]).toEqual(['github', undefined, undefined, 'panel', '第二个 GitHub'])
  expect(await call('DELETE', 'sources/github')).toEqual({ status: 200, body: { removed: true, restarting: true } })
  expect(calls[1]).toEqual(['github', 'panel'])
  expect(await call('GET', 'health')).toMatchObject({ status: 200, body: { ok: true, stage: 'ready', configured: true, paused: false,
    listen: { host: '127.0.0.1', port: 3082 }, machine: { stateDir: '/srv/dsh-superagent' },
    sources: [{ id: 'github', kind: 'github', enabled: true, installed: true, state: 'ready' }] } })
})

it('serves the scheduling queue snapshot for the panel', async () => {
  const snapshot = { at: '2026-01-01T00:00:00.000Z', maxWorkers: 2, used: 1, items: [{ id: 'q1', project: 'a', projectName: 'A', task: 't1',
    item: 0, title: '一', state: 'running' as const, attempt: 0, dueAt: 0, ticketId: 'ticket-1', enqueuedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z' }] }
  const call = serve({ configured: () => true, queue: () => snapshot })
  expect(await call('GET', 'queue')).toEqual({ status: 200, body: snapshot })
})

it('serves a Project\'s Tasks and queue state for the panel', async () => {
  const settings = SettingsSchema.parse({ projects: { a: { name: 'A', codeRepo: 'github', taskSource: 'sheet' } },
    codeRepos: { github: { kind: 'github', name: 'GitHub', config: { repository: 'acme/widgets' } } },
    taskSources: { sheet: { kind: 'excel', name: '清单' } } })
  const item = { id: 'q1', project: 'a', projectName: 'A', task: 't1', item: 0, title: '一', state: 'running' as const, attempt: 0,
    dueAt: 0, ticketId: 'ticket-1', enqueuedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  const call = serve({ configured: () => true, store: { settings: () => settings },
    queue: () => ({ at: '2026-01-01T00:00:00.000Z', maxWorkers: 2, used: 1, items: [item], projects: [] }) })
  expect(await call('GET', 'projects/a/tasks')).toEqual({ status: 200, body: {
    project: { id: 'a', name: 'A', enabled: true, codeRepo: { id: 'github', name: 'GitHub' },
      taskSource: { id: 'sheet', name: '清单' }, execution: settings.projects.a!.execution,
      schedule: settings.projects.a!.schedule, retry: settings.projects.a!.retry, taskPolicy: settings.projects.a!.taskPolicy },
    at: '2026-01-01T00:00:00.000Z', maxWorkers: 2, used: 1, queued: 0, running: 1, items: [item] } })
  expect(await call('GET', 'projects/missing/tasks')).toEqual({ status: 404, body: { error: 'Project not found' } })
})


it('answers a Source deletion that still has unfinished Tickets with 409 and its error code', async () => {
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}) },
    sources: { instances: () => [] },
    settings: { save: async () => ({}), removeSource: async () => {
      throw new UserError('sourceInUse', { source: 'feishu', count: '2' })
    } },
  })
  expect(await call('DELETE', 'sources/feishu')).toEqual({ status: 409, body: { error: 'The feishu Source still has 2 unfinished Tickets; disable it to end them',
    code: 'sourceInUse', values: { source: 'feishu', count: '2' } } })
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // 在调用 settings.save 之前校验块名称：拒绝未知块或不存在的来源。
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // 无效的 offset 默认为 0，超过路由上限的 limit 会被截断。
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // IPv6 回环同样算回环地址；Host 校验移到请求期后，监听 0.0.0.0 不再在注册阶段抛错。
  expect(await post({ host: '[::1]:3082', origin: 'http://[::1]:3082' })).toMatchObject({ status: 200 })
  expect(await post({ host: '0.0.0.0:3082' })).toEqual({ status: 403,
    body: { error: 'Same-origin management request required' } })
  expect(() => serve({}, '0.0.0.0')).not.toThrow()
})

it('keeps the management prefix mounted and explains a pending or failed startup with 200 and 503', async () => {
  const pending: StartupStatus = { phase: 'locked', detail: '状态目录锁被占用，最多等待 35 秒（已等待 2 秒）',
    stateDir: 'C:\\state', error: { name: 'Error', message: 'Lock file is already being held' } }
  const { call, routes } = servePending(pending)
  // 前缀在运行时创建之前就登记，宽度恰好到 /orchestrator/api，其余 /orchestrator/* 仍归宿主页面路由。
  expect(routes).toEqual([{ kind: 'prefix', path: '/orchestrator/api' }])
  // 健康探针在初始化失败时仍返回 200，并给出阶段、原因与状态目录。
  expect(await call('GET', 'health')).toEqual({ status: 200, body: { ok: false, stage: 'locked', phase: 'locked',
    detail: pending.detail, error: { name: 'Error', message: 'Lock file is already being held' }, configured: false, paused: false,
    problem: null, listen: { host: '127.0.0.1', port: 3082 }, machine: { stateDir: 'C:\\state' }, sources: [] } })
  // 其余接口返回 503 诊断，而不是空体 404。
  expect(await call('GET', 'state')).toEqual({ status: 503, body: { error: pending.detail, code: 'startupPending',
    phase: 'locked', detail: pending.detail, stateDir: 'C:\\state' } })
  const failed = servePending({ phase: 'failed', detail: '', stateDir: '/srv/state' })
  expect(await failed.call('POST', 'tickets/t9/retry')).toEqual({ status: 503,
    body: { error: 'dsh-superagent is not ready', code: 'startupPending', phase: 'failed', detail: '', stateDir: '/srv/state' } })
})

it('serves the runtime on an already mounted prefix once it is attached', async () => {
  let runtime: HttpHost | undefined
  // 与 AdminMount 一致：启动状态由取值函数提供，尚未挂上运行时时报告 starting。
  const { call } = mount(() => runtime, () => runtime
    ? { phase: 'ready', detail: '', stateDir: '/srv/state' }
    : { phase: 'starting', detail: '', stateDir: '/srv/state' })
  // 运行时还没创建：请求已经由本插件的前缀回答，健康探针 200、其余接口 503，宿主不再给出空体 404。
  expect(await call('GET', 'health')).toMatchObject({ status: 200, body: { ok: false, phase: 'starting' } })
  expect((await call('GET', 'state')).status).toBe(503)
  runtime = { ready: Promise.resolve(), store: { settings: () => SettingsSchema.parse({}) },
    sources: { instances: () => [] }, configured: () => true,
    machine: { stateDir: '/srv/state' } } as unknown as HttpHost
  expect(await call('GET', 'health')).toMatchObject({ status: 200,
    body: { ok: true, stage: 'ready', phase: 'ready', machine: { stateDir: '/srv/state' } } })
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})
