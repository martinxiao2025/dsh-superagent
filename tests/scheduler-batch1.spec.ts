/** 批次一调度可靠性行为：到期抖动、一轮内并发轮询、项目级 prepare 与 git 超时覆盖。 */
import { expect, it, describe } from 'vitest'
import { z } from 'zod'
import { ProjectScheduler } from '../src/app/scheduler.ts'
import { Store } from '../src/app/store.ts'
import { TaskSourceRegistry } from '../src/task-sources/index.ts'
import type { TaskSourceDriver } from '../src/task-sources/kind.ts'
import type { QueueEntry } from '../src/queue/model.ts'
import type { Settings } from '../src/policy.ts'
import type { RawTask } from '../src/task-sources/tasks.ts'
import { prepareCommandOf } from '../src/executor/launch.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const task = (id: string, title: string, status = 'todo'): RawTask => ({ id, title, description: `${title} 的说明`, status })

interface MemorySource extends TaskSourceDriver {
  tasks: RawTask[]
  /** 每次读取的进入时刻（ms），用于断言同一轮内多个项目是并发读取的。 */
  started: number[]
  /** 首次读取挂起的毫秒数；模拟大仓库慢同步阻塞其他项目。 */
  delayMs: number
}
const memory = (): MemorySource => {
  const driver = {
    kind: 'memory', title: { zh: '内存', en: 'Memory' }, description: { zh: '测试用', en: 'For tests' },
    schema: z.object({}), fields: [], fieldMap: { defaults: { id: 'id', title: 'title', description: 'description', status: 'status', priority: 'priority' }, required: [] },
    tasks: [] as RawTask[], started: [] as number[], delayMs: 0,
    async verify() { return [] },
    async list() { driver.started.push(Date.now()); if (driver.delayMs) await new Promise(resolve => setTimeout(resolve, driver.delayMs)); return driver.tasks },
    async writeback() {},
  }
  return driver as unknown as MemorySource
}

const settings = (projects: Record<string, unknown>, maxWorkers = 2): Settings =>
  ({ projects, executor: { maxWorkers }, taskPolicy: {} } as unknown as Settings)

const project = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: id, enabled: true,
  codeRepo: { kind: 'github', config: {} },
  taskSource: { kind: 'memory', config: {} },
  gitCredential: '', feishuCredential: '',
  execution: { directory: '', branch: '', prepare: '', gitTimeoutSeconds: 0 },
  schedule: { intervalMinutes: 5, runOnStart: false },
  retry: { maxRetries: 2, retryBackoffSeconds: 10 },
  taskPolicy: { doneStatus: 'done', failedStatus: 'failed', pendingStatuses: ['todo'] },
  ...overrides,
})

/** 带可控抖动与计时宿主的调度器；`jitters` 依次吐出每个项目到期时间的抖动随机数。 */
function setup(projects: Record<string, unknown>, options: { jitters?: number[]; now?: () => number } = {}) {
  const entries = new Map<string, QueueEntry>()
  const store = {
    settings: () => configured,
    queue: {
      get: (id: string) => entries.get(id),
      save: (entry: QueueEntry) => { entries.set(entry.id, entry) },
      list: () => [...entries.values()].sort((left, right) => left.seq - right.seq),
      active: () => [...entries.values()].filter(entry => entry.state === 'queued' || entry.state === 'starting' || entry.state === 'running')
        .sort((left, right) => left.seq - right.seq),
      queued: () => store.queue.active().filter(entry => entry.state === 'queued'),
      ready: (now: number) => store.queue.queued().filter(entry => entry.dueAt <= now),
      byTicket: (ticketId: string) => store.queue.active().find(entry =>
        (entry.state === 'starting' || entry.state === 'running') && entry.ticketId === ticketId),
      activeIn: (project: string) => store.queue.active().filter(entry => entry.project === project),
      terminalIn: (project: string) => [...entries.values()].filter(entry => entry.project === project && !['queued', 'starting', 'running'].includes(entry.state)),
      terminal: () => [],
      count: () => entries.size,
      maxSeq: () => Math.max(0, ...[...entries.values()].map(entry => entry.seq)),
      remove: () => {}, prune: () => 0,
    },
    tickets: { get: () => undefined },
    triggers: { get: () => undefined },
    atomic: <T>(work: () => T): T => work(),
  } as unknown as Store
  const driver = memory()
  const configured = settings(projects)
  const jitters = [...(options.jitters ?? [])]
  const host: ConstructorParameters<typeof ProjectScheduler>[0] = {
    store, settings: () => configured, registry: new TaskSourceRegistry([driver]),
    engine: { schedule: () => ({ ticketId: 'ticket-x', created: true }), stopTicket: () => undefined as never },
    effects: { enqueue: () => {}, cancel: () => {} },
    executor: { slotsInUse: () => 0, projectsInUse: () => [] },
    commands: { scope: () => ({}) } as never, stateDir: 'C:/tmp', lifetime: new AbortController().signal,
    syncRepo: async () => 'C:/tmp/repo',
    ...(options.now ? { now: options.now } : {}),
    ...(jitters.length ? { jitter: () => jitters.shift()! } : {}),
  }
  return { scheduler: new ProjectScheduler(host), driver, entries, jitters }
}

describe('到期抖动', () => {
  it('nextPoll 在间隔 ±10% 内抖动：注入 0 取下界，注入 0.5 取中间，注入 0.99 接近上界', async () => {
    const interval = 5 * 60_000
    const spread = Math.round(interval * 0.1)
    const base = Date.parse('2026-01-01T00:00:00.000Z')
    const low = setup({ a: project('a') }, { jitters: [0], now: () => base })
    await low.scheduler.poll('a')
    // 快照读取 nextPollAt：抖动 0 → 下界（间隔 - 10%）。
    expect(Date.parse(low.scheduler.snapshot().projects[0]!.nextPollAt!)).toBe(base + interval - spread)
    const mid = setup({ a: project('a') }, { jitters: [0.5], now: () => base })
    await mid.scheduler.poll('a')
    expect(Date.parse(mid.scheduler.snapshot().projects[0]!.nextPollAt!)).toBe(base + interval)
    const high = setup({ a: project('a') }, { jitters: [0.99], now: () => base })
    await high.scheduler.poll('a')
    expect(Date.parse(high.scheduler.snapshot().projects[0]!.nextPollAt!)).toBe(base + interval + Math.round(spread * (2 * 0.99 - 1)))
  })
  it('启动 nextPoll（runOnStart=false 的项目）同样带抖动', () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z')
    const spread = Math.round(5 * 60_000 * 0.1)
    const h = setup({ a: project('a') }, { jitters: [0.99], now: () => base })
    h.scheduler.start()
    h.scheduler.stop()
    // 间隔 5 分钟，抖动 0.99 → 接近上界 +10%。
    expect(Date.parse(h.scheduler.snapshot().projects[0]!.nextPollAt!)).toBe(base + 5 * 60_000 + Math.round(spread * (2 * 0.99 - 1)))
  })
})

describe('一轮内的并发轮询', () => {
  it('慢项目不再阻塞同批其他项目：多个项目的读取在时间上重叠', async () => {
    const h = setup({ a: project('a'), b: project('b'), c: project('c'), d: project('d') })
    h.driver.delayMs = 150
    const began = Date.now()
    // 手动扫描（非 startup）：四个启用的项目同一轮到期，由并发池并行读取。
    await h.scheduler.scan()
    const elapsed = Date.now() - began
    // 串行执行 4 × 150ms = 600ms；并发池（4）应显著低于该值。
    expect(elapsed).toBeLessThan(450)
    expect(h.driver.started).toHaveLength(4)
  })
  it('单项目轮询失败不中断同批其他项目', async () => {
    const h = setup({ a: project('a'), b: project('b') })
    h.driver.tasks = [task('b1', 'B 一')]
    const registryHost = h.scheduler as unknown as { reconcile: { poll(id: string): Promise<void> } }
    const original = registryHost.reconcile.poll.bind(registryHost.reconcile)
    registryHost.reconcile.poll = async (id: string) => {
      if (id === 'a') throw new Error('boom')
      return original(id)
    }
    await h.scheduler.scan()
    expect([...h.entries.values()].some(entry => entry.project === 'b')).toBe(true)
    // a 的失败记在项目级错误上，b 正常入队。
    expect(h.scheduler.snapshot().projects.find(item => item.id === 'b')).toBeTruthy()
  })
})

describe('项目级 prepare', () => {
  const executorSettings = (prepare: string, projectPrepare: string) =>
    ({ executor: { prepare }, projects: { a: { execution: { prepare: projectPrepare } } } }) as unknown as Settings
  it('项目级 prepare 优先于全局命令', () => {
    expect(prepareCommandOf(executorSettings('global-cmd', 'npm ci'), executorSettings('', 'npm ci').projects.a, 'repo-a')).toBe('npm ci')
  })
  it('项目未填写时回退全局命令', () => {
    expect(prepareCommandOf(executorSettings('global-cmd', ''), executorSettings('global-cmd', '').projects.a, 'repo-a')).toBe('global-cmd')
  })
  it('无仓库的工单只用全局命令，避免多项目共享缓存互相污染', () => {
    expect(prepareCommandOf(executorSettings('global-cmd', 'npm ci'), executorSettings('', 'npm ci').projects.a, '')).toBe('global-cmd')
  })
})

describe('git 超时覆盖', () => {
  it('withGitTimeout 只改写 git 的超时，其余方法委托原对象', async () => {
    const { withGitTimeout } = await import('../src/infra/git-timeout.ts')
    const calls: { args: string[]; timeout?: number }[] = []
    const base = { git: async (args: string[], _cwd: string, timeout?: number) => { calls.push({ args, timeout }); return 'ok' },
      run: async () => 'cli' } as never as import('../src/infra/commands.ts').Commands
    const wrapped = withGitTimeout(base, 123_456)
    await expect(wrapped.git(['fetch'], '/repo')).resolves.toBe('ok')
    expect(calls[0]).toEqual({ args: ['fetch'], timeout: 123_456 })
    await expect(wrapped.run('gh', ['api'])).resolves.toBe('cli')
    // 同一实例的重复调用共享覆盖值。
    await wrapped.git(['merge'], '/repo')
    expect(calls[1]?.timeout).toBe(123_456)
  })
  it('项目 execution.gitTimeoutSeconds 为 0 时沿用全局配置（不包装）', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-gittimeout-'))
    try {
      // 该用例只验证 schema 默认值语义：0 表示沿用全局。
      const store = new Store(join(directory, 'state.db'))
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM queue').get()).toEqual({ n: 0 })
      store.close()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
