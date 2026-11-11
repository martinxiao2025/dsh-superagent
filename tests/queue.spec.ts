/** 项目调度队列：轮询入队、全局 FIFO + 项目轮转、消失取消、失败退避与最终失败。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { ProjectScheduler } from '../src/app/scheduler.ts'
import { Store } from '../src/app/store.ts'
import { TaskSourceRegistry } from '../src/task-sources/index.ts'
import type { TaskSourceDriver } from '../src/task-sources/kind.ts'
import type { QueueEntry } from '../src/queue/model.ts'
import type { Settings } from '../src/policy.ts'
import type { RawTask } from '../src/task-sources/tasks.ts'

const task = (id: string, title: string, status = 'todo'): RawTask => ({ id, title, description: `${title} 的说明`, status })

/** 内存任务来源：测试直接改 `tasks` 模拟来源变化。 */
interface MemorySource extends TaskSourceDriver {
  tasks: RawTask[]
  written: { taskId: string; status: string }[]
}
const memory = (): MemorySource => {
  const driver = {
    kind: 'memory', title: { zh: '内存', en: 'Memory' }, description: { zh: '测试用', en: 'For tests' },
    schema: z.object({}), fields: [], fieldMap: { defaults: { id: 'id', title: 'title', description: 'description', status: 'status', priority: 'priority' }, required: [] },
    tasks: [] as RawTask[], written: [] as { taskId: string; status: string }[],
    async verify() { return [] },
    async list() { return driver.tasks },
    async writeback(_config: unknown, target: { taskId: string }, status: string) { driver.written.push({ taskId: target.taskId, status }) },
  }
  return driver as unknown as MemorySource
}

/** 一台内存宿主：真实调度器，队列、工单与执行器状态由测试控制。 */
function setup(projects: Record<string, unknown>, maxWorkers = 2) {
  const entries = new Map<string, QueueEntry>()
  const tickets = new Map<string, { id: string; ended?: { outcome: string; by: string; at: string } }>()
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
    },
    tickets: { get: (id: string) => tickets.get(id) },
    atomic: <T>(work: () => T): T => work(),
  } as unknown as Store
  const driver = memory()
  const scheduler = new ProjectScheduler({ store, settings: () => settings, registry: new TaskSourceRegistry([driver]),
    engine: {
      schedule: input => {
        const ticketId = `ticket-${++created}`
        tickets.set(ticketId, { id: ticketId })
        expect(input.projectName).toBeTruthy()
        return { ticketId, created: true }
      },
      stopTicket: (id, reason) => {
        const ticket = tickets.get(id)
        if (ticket) ticket.ended = { outcome: 'stopped', by: 'human', at: reason ?? '' }
        return ticket as never
      },
    },
    executor: { slotsInUse: () => 0, projectsInUse: () => [] },
    commands: { scope: () => ({}) } as never, stateDir: 'C:/tmp', lifetime: new AbortController().signal,
    syncRepo: async () => 'C:/tmp/repo', now: () => clock })
  return { scheduler, driver, entries, tickets, advance: (ms: number) => { clock += ms }, settings }
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
  await Promise.resolve()
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
  await Promise.resolve()
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
