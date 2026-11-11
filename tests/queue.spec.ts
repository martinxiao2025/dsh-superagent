/** 项目调度队列：轮询入队、全局 FIFO + 项目轮转、消失取消、失败退避与最终失败。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { ProjectScheduler } from '../src/app/scheduler.ts'
import { key } from '../src/core/ids.ts'
import { Store } from '../src/app/store.ts'
import { TaskSourceRegistry } from '../src/task-sources/index.ts'
import type { TaskSourceDriver } from '../src/task-sources/kind.ts'
import type { QueueEntry } from '../src/queue/model.ts'
import type { Settings } from '../src/policy.ts'
import type { RawTask } from '../src/task-sources/tasks.ts'

const task = (id: string, title: string, status = 'todo'): RawTask => ({ id, title, description: `${title} 的说明`, status })

/** 内存任务来源：测试直接改 `tasks` 模拟来源变化；`calls` 记录读取次数，用于断言互斥。 */
interface MemorySource extends TaskSourceDriver {
  tasks: RawTask[]
  written: { taskId: string; status: string }[]
  calls: number
}
const memory = (): MemorySource => {
  const driver = {
    kind: 'memory', title: { zh: '内存', en: 'Memory' }, description: { zh: '测试用', en: 'For tests' },
    schema: z.object({}), fields: [], fieldMap: { defaults: { id: 'id', title: 'title', description: 'description', status: 'status', priority: 'priority' }, required: [] },
    tasks: [] as RawTask[], written: [] as { taskId: string; status: string }[], calls: 0,
    async verify() { return [] },
    async list() { driver.calls += 1; return driver.tasks },
    async writeback(_config: unknown, target: { taskId: string }, status: string) { driver.written.push({ taskId: target.taskId, status }) },
  }
  return driver as unknown as MemorySource
}

/** 一台内存宿主：真实调度器，队列、工单与执行器状态由测试控制。 */
function setup(projects: Record<string, unknown>, maxWorkers = 2) {
  const entries = new Map<string, QueueEntry>()
  const tickets = new Map<string, { id: string; assignments: unknown[]; undelivered: unknown[]; ended?: { outcome: string; by: string; at: string } }>()
  /** 与真实引擎一致：同一触发器只创建一个工单，重复投递拿回已存在的工单。 */
  const byTrigger = new Map<string, string>()
  const effects: { kind: string; key: string; payload: unknown }[] = []
  let clock = Date.parse('2026-01-01T00:00:00.000Z')
  let created = 0
  const settings = {
    projects, codeRepos: Object.fromEntries(Object.keys(projects).map(id => [`repo-${id}`, { enabled: true, kind: 'github', name: id, config: {} }])),
    taskSources: Object.fromEntries(Object.keys(projects).map(id => [`source-${id}`, { enabled: true, kind: 'memory', name: id, config: {} }])),
    executor: { maxWorkers }, taskPolicy: {},
  } as unknown as Settings
  const store = {
    settings: () => settings,
    queue: {
      get: (id: string) => entries.get(id),
      save: (entry: QueueEntry) => { entries.set(entry.id, entry) },
      list: () => [...entries.values()].sort((left, right) => left.seq - right.seq),
      active: () => [...entries.values()].filter(entry => entry.state === 'queued' || entry.state === 'starting' || entry.state === 'running')
        .sort((left, right) => left.seq - right.seq),
      maxSeq: () => Math.max(0, ...[...entries.values()].map(entry => entry.seq)),
      remove: (project: string) => { for (const [id, entry] of entries) if (entry.project === project) entries.delete(id) },
      prune: () => 0,
    },
    tickets: { get: (id: string) => tickets.get(id) },
    atomic: <T>(work: () => T): T => work(),
  } as unknown as Store
  const driver = memory()
  /** 调度器宿主；热加载测试用同一份宿主（同一份状态）重建调度器实例。 */
  const host = { store, settings: () => settings, registry: new TaskSourceRegistry([driver]),
    engine: {
      schedule: input => {
        const existing = byTrigger.get(input.trigger.id)
        if (existing) return { ticketId: existing, created: false }
        const ticketId = `ticket-${++created}`
        byTrigger.set(input.trigger.id, ticketId)
        tickets.set(ticketId, { id: ticketId, assignments: [], undelivered: [] })
        expect(input.projectName).toBeTruthy()
        return { ticketId, created: true }
      },
      stopTicket: (id, reason) => {
        const ticket = tickets.get(id)
        if (ticket) ticket.ended = { outcome: 'stopped', by: 'human', at: reason ?? '' }
        return ticket as never
      },
    },
    effects: {
      enqueue: (kind: string, key: string, payload: unknown) => { effects.push({ kind, key, payload }) },
      cancel: (kind: string, key: string) => {
        for (let index = effects.length - 1; index >= 0; index--) if (effects[index]!.kind === kind && effects[index]!.key === key) effects.splice(index, 1)
      },
    },
    executor: { slotsInUse: () => 0, projectsInUse: () => [] },
    commands: { scope: () => ({}) } as never, stateDir: 'C:/tmp', lifetime: new AbortController().signal,
    syncRepo: async () => 'C:/tmp/repo', now: () => clock }
  const scheduler = new ProjectScheduler(host)
  /** 执行排队的回写副作用；真实实现由 Effects 在工作线程外调用同一个处理器。 */
  const flush = async () => {
    for (const effect of effects.splice(0)) {
      if (effect.kind === 'writeback') await scheduler.writeBackNow(effect.payload as never)
    }
  }
  // `reload` 模拟插件热加载：模块重新求值后，同一状态库上出现新的调度器实例。
  return { scheduler, reload: () => new ProjectScheduler(host), driver, entries, tickets, effects, flush, advance: (ms: number) => { clock += ms }, settings }
}

/** 项目记录：两个项目共用同一套默认策略，只有名称不同。 */
const project = (id: string, repo = `repo-${id}`, source = `source-${id}`) => ({
  id, name: id, enabled: true, codeRepo: repo, taskSource: source,
  execution: {}, schedule: { intervalMinutes: 5, runOnStart: false },
  retry: { maxRetries: 2, retryBackoffSeconds: 10 },
  taskPolicy: { doneStatus: 'done', failedStatus: 'failed', pendingStatuses: ['todo'] },
})

it('按全局入队顺序出队，并跳过已有任务在跑的项目', async () => {
  const h = setup({ a: project('a'), b: project('b') })
  h.driver.tasks = [task('a1', 'A 一'), task('a2', 'A 二')]
  await h.scheduler.poll('a')
  h.driver.tasks = [task('b1', 'B 一')]
  await h.scheduler.poll('b')
  expect(h.entries.size).toBe(3)
  h.scheduler.pump()
  const states = [...h.entries.values()].sort((left, right) => left.seq - right.seq).map(entry => [entry.task, entry.state])
  // a1 先出队；a2 因 a 项目已有任务被跳过，b1 越过它出队。
  expect(states).toEqual([['a1', 'running'], ['a2', 'queued'], ['b1', 'running']])
})

it('热加载后新调度器接管同一状态：排队项保留、不重复建单，运行中的任务按终态结算', async () => {
  const h = setup({ a: project('a') }, 1)
  h.driver.tasks = [task('a1', 'A 一'), task('a2', 'A 二')]
  await h.scheduler.poll('a')
  h.scheduler.pump()
  const [running, queued] = [...h.entries.values()].sort((left, right) => left.seq - right.seq)
  expect([running!.state, queued!.state]).toEqual(['running', 'queued'])
  const ticketCount = h.tickets.size

  // 模拟插件热加载：模块重新求值后，同一状态库上出现新的调度器实例。
  const reloaded = h.reload()
  await reloaded.scan()

  // 状态来自状态库而不是内存：排队项与运行中的条目都还在，也没有被重复入队或重复建单。
  expect(h.entries.size).toBe(2)
  expect(h.entries.get(queued!.id)).toMatchObject({ state: 'queued', present: true })
  expect(h.entries.get(running!.id)).toMatchObject({ state: 'running' })
  expect(h.tickets.size).toBe(ticketCount)

  // 运行中的工单结束后，新实例按终态结算，并把排队项继续派出去。
  h.tickets.get(running!.ticketId!)!.ended = { outcome: 'completed', by: 'executor', at: '' }
  reloaded.observe(running!.ticketId!)
  expect(h.entries.get(running!.id)).toMatchObject({ state: 'succeeded' })
  reloaded.pump()
  expect(h.entries.get(queued!.id)).toMatchObject({ state: 'running' })
})

it('任务从来源消失时取消队列条目，重新出现时只再入队一次', async () => {
  const h = setup({ a: project('a') })
  h.driver.tasks = [task('a1', 'A 一')]
  await h.scheduler.poll('a')
  expect([...h.entries.values()][0]).toMatchObject({ state: 'queued', present: true })
  h.driver.tasks = []
  await h.scheduler.poll('a')
  expect([...h.entries.values()][0]).toMatchObject({ state: 'cancelled', present: false, reason: expect.stringContaining('disappeared') })
  h.driver.tasks = [task('a1', 'A 一')]
  await h.scheduler.poll('a')
  await h.scheduler.poll('a')
  const states = [...h.entries.values()].map(entry => entry.state).sort()
  expect(states).toEqual(['cancelled', 'queued'])
})

it('失败按项目退避重排，超过重试次数后最终失败并回写失败状态', async () => {
  const h = setup({ a: project('a') })
  h.driver.tasks = [task('a1', 'A 一')]
  await h.scheduler.poll('a')
  h.scheduler.pump()
  const first = [...h.entries.values()][0]!
  expect(first.state).toBe('running')
  h.tickets.get(first.ticketId!)!.ended = { outcome: 'dropped', by: 'executor', at: '' }
  h.scheduler.observe(first.ticketId!)
  const retried = h.entries.get(first.id)!
  expect(retried).toMatchObject({ state: 'queued', attempt: 1, ticketId: undefined })
  expect(retried.dueAt).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'))
  // 退避未到期时不重新建单。
  h.scheduler.pump()
  expect(h.entries.get(first.id)!.state).toBe('queued')
  for (let round = 0; round < 2; round++) {
    h.advance(10_000)
    h.scheduler.pump()
    const running = h.entries.get(first.id)!
    expect(running.state).toBe('running')
    h.tickets.get(running.ticketId!)!.ended = { outcome: 'dropped', by: 'executor', at: '' }
    h.scheduler.observe(running.ticketId!)
  }
  const failed = h.entries.get(first.id)!
  expect(failed).toMatchObject({ state: 'failed', attempt: 3, reason: expect.stringContaining('dropped') })
  expect(failed.tickets).toHaveLength(3)
  // 每次重试都是新的触发器与工单，而不是复用已经结束的工单。
  expect(new Set(failed.tickets).size).toBe(3)
  await h.flush()
  expect(h.driver.written.at(-1)).toMatchObject({ taskId: 'a1', status: 'failed' })
})

it('成功结束后回写完成状态，并保留队列记录', async () => {
  const h = setup({ a: project('a') })
  h.driver.tasks = [task('a1', 'A 一')]
  await h.scheduler.poll('a')
  h.scheduler.pump()
  const entry = [...h.entries.values()][0]!
  h.tickets.get(entry.ticketId!)!.ended = { outcome: 'completed', by: 'executor', at: '' }
  h.scheduler.observe(entry.ticketId!)
  // 回写进入持久化副作用队列（带尝试次数的键），而不是发起即忘。
  expect(h.effects.at(-1)).toMatchObject({ kind: 'writeback', payload: { project: 'a', task: 'a1', status: 'done' } })
  await h.flush()
  expect(h.entries.get(entry.id)).toMatchObject({ state: 'succeeded', ticketId: entry.ticketId })
  expect(h.driver.written.at(-1)).toMatchObject({ taskId: 'a1', status: 'done' })
  // 已经成功的任务即使仍在来源中，也不会重复入队。
  await h.scheduler.poll('a')
  expect([...h.entries.values()]).toHaveLength(1)
})

it('重启后从持久化队列恢复：启动中没有工单的条目重新排队', async () => {
  const h = setup({ a: project('a') })
  h.driver.tasks = [task('a1', 'A 一')]
  await h.scheduler.poll('a')
  const entry = [...h.entries.values()][0]!
  // 模拟上次进程在建单前中断：条目停在 starting，且没有工单。
  h.entries.set(entry.id, { ...entry, state: 'starting', ticketId: undefined })
  await h.scheduler.scan()
  expect(h.entries.get(entry.id)).toMatchObject({ state: 'queued', attempt: 1, reason: expect.stringContaining('never created') })
})

it('任务内工作项删除或改写只影响对应条目', async () => {
  const h = setup({ a: project('a') })
  h.driver.tasks = [{ id: 'a1', title: 'A 一', description: '- [ ] 一\n- [ ] 二', status: 'todo' }]
  await h.scheduler.poll('a')
  const [first, second] = [...h.entries.values()].sort((left, right) => left.item - right.item)
  expect(first).toMatchObject({ state: 'queued', itemKey: expect.any(String), contentHash: expect.any(String) })
  expect(second).toMatchObject({ state: 'queued', itemKey: expect.any(String) })
  // 删除第二项：只取消它，第一项保持排队。
  h.driver.tasks = [{ id: 'a1', title: 'A 一', description: '- [ ] 一', status: 'todo' }]
  await h.scheduler.poll('a')
  expect(h.entries.get(first!.id)).toMatchObject({ state: 'queued', present: true })
  expect(h.entries.get(second!.id)).toMatchObject({ state: 'cancelled', present: false })
  // 改写第一项：旧版本取消，新版本入队，而不是把旧内容当成同一项。
  h.driver.tasks = [{ id: 'a1', title: 'A 一', description: '- [ ] 一（改）', status: 'todo' }]
  await h.scheduler.poll('a')
  expect(h.entries.get(first!.id)).toMatchObject({ state: 'cancelled', present: false })
  expect([...h.entries.values()].filter(entry => entry.state === 'queued')).toHaveLength(1)
  expect([...h.entries.values()].filter(entry => entry.state === 'queued')[0]!.itemKey).not.toBe(first!.itemKey)
})

it('已完成任务的内容发生变化时会重新入队', async () => {
  const h = setup({ a: project('a') })
  h.driver.tasks = [task('a1', 'A 一')]
  await h.scheduler.poll('a')
  h.scheduler.pump()
  const entry = [...h.entries.values()][0]!
  h.tickets.get(entry.ticketId!)!.ended = { outcome: 'completed', by: 'executor', at: '' }
  h.scheduler.observe(entry.ticketId!)
  await h.flush()
  expect(h.entries.get(entry.id)!.state).toBe('succeeded')
  h.driver.tasks = [{ id: 'a1', title: 'A 一', description: '改成新的说明', status: 'todo' }]
  await h.scheduler.poll('a')
  const queued = [...h.entries.values()].filter(item => item.state === 'queued')
  expect(queued).toHaveLength(1)
  expect(queued[0]!.text).toContain('新的说明')
})

it('停用的项目不再领取排队项，删除项目后队列记录被清理', async () => {
  const h = setup({ a: project('a') })
  h.driver.tasks = [task('a1', 'A 一')]
  await h.scheduler.poll('a')
  h.settings.projects.a!.enabled = false
  h.scheduler.pump()
  expect([...h.entries.values()][0]!.state).toBe('queued')
  h.scheduler.forget('a')
  expect(h.entries.size).toBe(0)
})

it('runOnStart 决定启动时是否立即轮询', async () => {
  const h = setup({
    a: { ...project('a'), schedule: { intervalMinutes: 5, runOnStart: false } },
    b: { ...project('b'), schedule: { intervalMinutes: 5, runOnStart: true } },
  })
  h.driver.tasks = [task('a1', '共享')]
  h.scheduler.start()
  await new Promise(resolve => setTimeout(resolve, 10))
  h.scheduler.stop()
  const projects = [...h.entries.values()].map(entry => entry.project)
  expect(projects).toEqual(['b'])
  // 间隔到期后，未在启动时轮询的项目仍会按周期轮询。
  h.advance(5 * 60_000)
  await (h.scheduler as unknown as { tick(startup?: boolean): Promise<void> }).tick()
  expect([...h.entries.values()].map(entry => entry.project).sort()).toEqual(['a', 'b'])
})

it('项目有任务在执行时推迟轮询，并在快照中留下原因', async () => {
  const h = setup({ a: project('a') })
  h.driver.tasks = [task('a1', 'A 一')]
  await h.scheduler.poll('a')
  h.scheduler.pump()
  expect([...h.entries.values()][0]!.state).toBe('running')
  // 执行中新增的任务不会被拉取：本轮轮询被推迟，而不是并发读取来源。
  h.driver.tasks = [task('a1', 'A 一'), task('a2', 'A 二')]
  const before = h.driver.calls
  await h.scheduler.poll('a')
  expect(h.driver.calls).toBe(before)
  expect([...h.entries.values()]).toHaveLength(1)
  expect(h.scheduler.snapshot().projects[0]).toMatchObject({
    id: 'a', deferred: { reason: expect.stringContaining('deferred'), at: expect.any(String) } })
  // 项目空闲后恢复轮询，推迟原因随之清除。
  const running = [...h.entries.values()][0]!
  h.tickets.get(running.ticketId!)!.ended = { outcome: 'completed', by: 'executor', at: '' }
  h.scheduler.observe(running.ticketId!)
  await h.scheduler.poll('a')
  expect(h.driver.calls).toBe(before + 1)
  expect([...h.entries.values()]).toHaveLength(2)
  expect(h.scheduler.snapshot().projects[0]!.deferred).toBeUndefined()
})

it('项目有任务在跑时推迟写回，空闲后补写', async () => {
  const h = setup({ a: project('a') }, 1)
  h.driver.tasks = [task('a1', 'A 一'), task('a2', 'A 二')]
  await h.scheduler.poll('a')
  h.scheduler.pump()
  const first = [...h.entries.values()].find(entry => entry.state === 'running')!
  h.tickets.get(first.ticketId!)!.ended = { outcome: 'completed', by: 'executor', at: '' }
  h.scheduler.observe(first.ticketId!)
  // 下一项立刻占用项目：此刻的写回（需要同步工作副本）必须推迟而不是并发拉取。
  h.scheduler.pump()
  const pending = h.effects.at(-1)!
  await expect(h.scheduler.writeBackNow(pending.payload as never)).rejects.toThrow(/deferred/)
  expect(h.driver.written).toHaveLength(0)
  // 项目空闲后同一条副作用可以正常补写。
  const second = [...h.entries.values()].find(entry => entry.state === 'running')!
  h.tickets.get(second.ticketId!)!.ended = { outcome: 'completed', by: 'executor', at: '' }
  h.scheduler.observe(second.ticketId!)
  await h.flush()
  expect(h.driver.written.map(item => item.taskId).sort()).toEqual(['a1', 'a2'])
})

it('手动扫描与定时检查互斥，同一项目只轮询一次', async () => {
  const h = setup({ a: project('a') })
  h.driver.tasks = [task('a1', 'A 一')]
  const scan = h.scheduler.scan()
  const tick = (h.scheduler as unknown as { tick(startup?: boolean): Promise<void> }).tick()
  await Promise.all([scan, tick])
  expect(h.driver.calls).toBe(1)
  expect([...h.entries.values()]).toHaveLength(1)
})

it('队列快照暴露下次轮询时间与最近错误', async () => {
  const h = setup({ a: project('a') })
  h.driver.tasks = [task('a1', 'A 一')]
  await h.scheduler.poll('a')
  expect(h.scheduler.snapshot().projects).toEqual([{ id: 'a', name: 'a', enabled: true, nextPollAt: expect.any(String) }])
  ;(h.settings.taskSources['source-a'] as { enabled: boolean }).enabled = false
  await h.scheduler.poll('a')
  expect(h.scheduler.snapshot().projects[0]).toMatchObject({ id: 'a', lastError: expect.stringContaining('disabled') })
})

it('手动重试、取消与清空排队项', async () => {
  const h = setup({ a: project('a') }, 0)
  h.driver.tasks = [task('a1', 'A 一'), task('a2', 'A 二')]
  await h.scheduler.poll('a')
  const [first, second] = [...h.entries.values()].sort((left, right) => left.seq - right.seq)
  // 排队中的条目不能重复重试。
  expect(h.scheduler.retryEntry(first!.id)).toEqual({ retried: false })
  // 取消排队项后保留记录与原因。
  expect(h.scheduler.cancelEntry(first!.id)).toEqual({ cancelled: true })
  expect(h.entries.get(first!.id)).toMatchObject({ state: 'cancelled', reason: expect.stringContaining('panel') })
  // 已取消的条目可以手动重试，尝试次数重置并重新排队。
  expect(h.scheduler.retryEntry(first!.id)).toEqual({ retried: true })
  expect(h.entries.get(first!.id)).toMatchObject({ state: 'queued', attempt: 0, reason: undefined })
  // 清空只影响排队项，并返回实际取消数量。
  expect(h.scheduler.clearQueue('a')).toEqual({ cancelled: 2 })
  expect([...h.entries.values()].every(entry => entry.state === 'cancelled')).toBe(true)
  expect(h.entries.get(second!.id)).toMatchObject({ state: 'cancelled', reason: expect.stringContaining('Cleared') })
})

it('手动重试会取消旧尝试待执行的写回', async () => {
  const h = setup({ a: project('a') }, 0)
  h.driver.tasks = [task('a1', 'A 一')]
  await h.scheduler.poll('a')
  const entry = [...h.entries.values()][0]!
  // 模拟已成功但写回尚未执行：旧尝试的写回副作用还在队列里。
  h.entries.set(entry.id, { ...entry, state: 'succeeded' })
  h.effects.push({ kind: 'writeback', key: key('writeback', entry.id, 'done', '0'), payload: {} })
  expect(h.scheduler.retryEntry(entry.id)).toEqual({ retried: true })
  expect(h.effects).toHaveLength(0)
  expect(h.entries.get(entry.id)).toMatchObject({ state: 'queued', attempt: 0 })
})

it('取消运行中的条目会同时停止工单', async () => {
  const h = setup({ a: project('a') }, 1)
  h.driver.tasks = [task('a1', 'A 一'), task('a2', 'A 二')]
  await h.scheduler.poll('a')
  h.scheduler.pump()
  const running = [...h.entries.values()].find(entry => entry.state === 'running')!
  expect(h.scheduler.cancelEntry(running.id)).toEqual({ cancelled: true })
  expect(h.entries.get(running.id)).toMatchObject({ state: 'cancelled', reason: expect.stringContaining('panel') })
  expect(h.tickets.get(running.ticketId!)!.ended).toMatchObject({ outcome: 'stopped', by: 'human' })
  // 已结束的条目不再被重复取消。
  expect(h.scheduler.cancelEntry(running.id)).toEqual({ cancelled: false })
  // 清空排队项不会影响已经结束的条目。
  const queuedBefore = [...h.entries.values()].filter(entry => entry.state === 'queued').length
  expect(h.scheduler.clearQueue()).toEqual({ cancelled: queuedBefore })
})

it('队列在数据库层保证活动条目唯一，并清理过期终态', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-queue-unique-'))
  const path = join(directory, 'state.db')
  const base = { project: 'a', task: 't1', item: 0, itemKey: 'k', title: '一', text: '一', taskTitle: '一', attempt: 0,
    enqueuedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', dueAt: 0, tickets: [], present: true }
  try {
    const store = new Store(path)
    try {
      store.queue.save({ ...base, id: 'q1', state: 'queued', seq: 1 })
      expect(() => store.queue.save({ ...base, id: 'q2', state: 'starting', seq: 2 })).toThrow()
      store.queue.save({ ...base, id: 'q1', state: 'succeeded', seq: 1, endedAt: '2025-01-01T00:00:00.000Z' })
      store.queue.save({ ...base, id: 'q3', state: 'failed', seq: 2, endedAt: '2026-01-01T00:00:00.000Z' })
      expect(store.queue.prune('a', '2025-06-01T00:00:00.000Z')).toBe(1)
      expect(store.queue.list().map(entry => entry.id)).toEqual(['q3'])
      // 实体读取做运行时校验：损坏或字段缺失的记录会明确失败，而不是被当作合法对象。
      store.db.prepare('INSERT INTO ticket VALUES (?,?)').run('t1', '{"id":1}')
      expect(() => store.tickets.get('t1')).toThrow(/invalid: missing id/)
      store.db.prepare('INSERT INTO trigger VALUES (?,?,?)').run('t2', '{', '2026-01-01T00:00:00.000Z')
      expect(() => store.triggers.get('t2')).toThrow(/corrupt/)
      store.db.prepare('INSERT INTO queue VALUES (?,?,?)').run('bad', '{"id":"bad"}', 99)
      expect(() => store.queue.list()).toThrow()
    } finally {
      store.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('队列写入 SQLite，重新打开后顺序与状态不变', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-queue-'))
  const path = join(directory, 'state.db')
  try {
    const first = new Store(path)
    first.queue.save({ id: 'q1', project: 'a', task: 't1', item: 0, title: '一', text: '一', taskTitle: '一', state: 'queued', attempt: 0,
      seq: 1, enqueuedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', dueAt: 0, tickets: [], present: true })
    first.queue.save({ id: 'q2', project: 'b', task: 't2', item: 0, title: '二', text: '二', taskTitle: '二', state: 'running', attempt: 1,
      seq: 2, enqueuedAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z', dueAt: 0, ticketId: 'ticket-1', tickets: ['ticket-1'], present: true })
    first.close()
    const second = new Store(path)
    expect(second.queue.list().map(entry => [entry.id, entry.state, entry.seq])).toEqual([['q1', 'queued', 1], ['q2', 'running', 2]])
    expect(second.queue.active().map(entry => entry.id)).toEqual(['q1', 'q2'])
    expect(second.queue.maxSeq()).toBe(2)
    second.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
