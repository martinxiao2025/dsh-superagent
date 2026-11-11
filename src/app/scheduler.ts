/**
 * 项目调度：按项目轮询任务来源，把待办工作项持久化进队列，按全局 FIFO 与项目轮转出队建单，
 * 并把工单终态、失败退避与任务消失写回队列。队列本身是唯一的事实来源，重启后从队列继续。
 */
import type { Engine, ScheduledTicket } from '../core/index.ts'
import { key } from '../core/ids.ts'
import { ticketStage, type Ticket } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import type { Commands } from '../infra/commands.ts'
import { syncRepoWorkCopy } from '../code-repos/work.ts'
import { splitTask, type RawTask } from '../task-sources/tasks.ts'
import { taskSources, type TaskSourceRegistry } from '../task-sources/index.ts'
import type { Store } from './store.ts'
import { queueActive, queueId, queueInFlight, type QueueEntry, type QueueSnapshot } from '../queue/model.ts'

/** 调度器需要的宿主能力；测试可以替换任务来源注册表与代码仓库同步。 */
export interface SchedulerHost {
  readonly store: Store
  readonly settings: () => Settings
  readonly engine: Pick<Engine, 'schedule' | 'stopTicket'>
  /** 执行器当前的槽位占用与项目占用。 */
  readonly executor: { slotsInUse(): number; projectsInUse(): string[] }
  readonly commands: Commands
  readonly stateDir: string
  readonly lifetime: AbortSignal
  /** 任务来源驱动注册表；默认使用内置注册表。 */
  readonly registry?: TaskSourceRegistry
  /** 同步代码仓库并返回工作副本目录；默认走 `syncRepoWorkCopy`。 */
  readonly syncRepo?: (repo: string) => Promise<string>
  /** 队列变化后的通知，供上层刷新。 */
  readonly onChange?: () => void
  readonly now?: () => number
}

/** 检查轮询与创建工单之间的最短间隔。 */
const TICK_MS = 15_000

/** 项目调度器：轮询任务来源、维护持久化队列、在容量允许时建单并跟踪工单终态。 */
export class ProjectScheduler {
  private timer: NodeJS.Timeout | undefined
  private readonly nextPoll = new Map<string, number>()
  private readonly errors = new Map<string, string>()
  private readonly registry: TaskSourceRegistry
  private readonly syncRepo: (repo: string) => Promise<string>
  private running = false

  constructor(private readonly host: SchedulerHost) {
    this.registry = host.registry ?? taskSources
    this.syncRepo = host.syncRepo ?? (repo => this.defaultSync(repo))
  }

  /** 启动周期检查，并按 `runOnStart` 立即轮询一次。 */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    const now = this.now()
    for (const [id, project] of Object.entries(this.host.settings().projects)) {
      if (project.enabled && !project.schedule.runOnStart) this.nextPoll.set(id, now + project.schedule.intervalMinutes * 60_000)
    }
    void this.tick(true)
    this.host.lifetime.addEventListener('abort', () => this.stop(), { once: true })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 立即轮询所有启用的项目并检查队列；测试与手动触发共用。 */
  async scan(): Promise<void> {
    await this.recover()
    for (const [id, project] of Object.entries(this.host.settings().projects)) {
      if (project.enabled) await this.poll(id)
    }
    this.pump()
  }

  /** 轮询一个项目：读取任务来源，取消消失的任务，把新的工作项入队。 */
  async poll(projectId: string): Promise<void> {
    const settings = this.host.settings()
    const project = settings.projects[projectId]
    if (!project?.enabled) return
    this.nextPoll.set(projectId, this.now() + project.schedule.intervalMinutes * 60_000)
    const record = settings.taskSources[project.taskSource]
    const repo = settings.codeRepos[project.codeRepo]
    if (!record?.enabled) return this.fail(projectId, 'The task source is missing or disabled')
    if (!repo?.enabled) return this.fail(projectId, 'The code repository is missing or disabled')
    const driver = this.registry.kind(record.kind)
    if (!driver) return this.fail(projectId, `Unknown task source type: ${record.kind}`)
    const parsed = driver.schema.safeParse(record.config)
    if (!parsed.success) return this.fail(projectId, `Invalid task source configuration: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    const bound = driver.repo?.(parsed.data) ?? ''
    if (bound && bound !== project.codeRepo) return this.fail(projectId, `The task source reads ${bound}, but the project uses ${project.codeRepo}`)
    let tasks: RawTask[]
    try {
      tasks = await driver.list(parsed.data, { signal: this.host.lifetime, commands: this.boundCommands(parsed.data, project.codeRepo), syncRepo: this.syncRepo })
    } catch (error) {
      return this.fail(projectId, String(error instanceof Error ? error.message : error))
    }
    this.errors.delete(projectId)
    this.host.store.atomic(() => this.reconcile(projectId, project, tasks))
    this.changed()
  }

  /** 把队列中到期的工作项出队建单；全局容量与项目串行同时生效。 */
  pump(): void {
    const settings = this.host.settings()
    const busy = new Set([...this.host.executor.projectsInUse(), ...this.host.store.queue.active().filter(queueInFlight).map(entry => entry.project)])
    let used = this.host.executor.slotsInUse()
    const entries = this.host.store.queue.list()
    for (const entry of entries) {
      if (entry.state !== 'queued' || entry.dueAt > this.now()) continue
      if (used >= settings.executor.maxWorkers) break
      // 同项目同一时刻只跑一个任务：跳过时保留在原位，由后面的其他项目轮转。
      if (busy.has(entry.project)) continue
      if (!this.dispatch(entry)) continue
      busy.add(entry.project)
      used++
    }
  }

  /** 工单结束后把结果写回它对应的队列条目；重复调用幂等。 */
  observe(ticketId: string): void {
    const entry = this.host.store.queue.list().find(item => item.ticketId === ticketId && queueInFlight(item))
    if (!entry?.ticketId) return
    const ticket = this.host.store.tickets.get(ticketId)
    this.settle(entry, ticket)
  }

  /** 队列快照：P5 面板读取，按全局入队顺序排列。 */
  snapshot(): QueueSnapshot {
    const settings = this.host.settings()
    const entries = this.host.store.queue.list()
    return {
      at: new Date(this.now()).toISOString(),
      maxWorkers: settings.executor.maxWorkers,
      used: this.host.executor.slotsInUse(),
      items: entries.map(entry => ({ id: entry.id, project: entry.project, projectName: settings.projects[entry.project]?.name ?? entry.project,
        task: entry.task, item: entry.item, title: entry.title, state: entry.state, attempt: entry.attempt, dueAt: entry.dueAt,
        ...(entry.ticketId ? { ticketId: entry.ticketId } : {}), ...(entry.reason ? { reason: entry.reason } : {}),
        enqueuedAt: entry.enqueuedAt, updatedAt: entry.updatedAt })),
    }
  }

  private async tick(startup = false): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.recover()
      const projects = this.host.settings().projects
      const now = this.now()
      for (const [id, project] of Object.entries(projects)) {
        if (!project.enabled) continue
        const due = this.nextPoll.get(id)
        if (startup ? !project.schedule.runOnStart && due === undefined : due !== undefined && due > now) continue
        await this.poll(id)
      }
      for (const entry of this.host.store.queue.active().filter(queueInFlight)) this.settle(entry, this.ticketOf(entry))
      this.pump()
    } catch (error) {
      // 单次检查失败不终止周期任务；具体项目的错误已记录在 `errors` 中。
      if (!this.host.lifetime.aborted) this.errors.set('', String(error instanceof Error ? error.message : error))
    } finally {
      this.running = false
    }
  }

  /** 启动恢复：没有工单的启动中条目视为上次中断，按失败重试；其余按工单实际状态结算。 */
  private async recover(): Promise<void> {
    const entries = this.host.store.queue.list().filter(queueInFlight)
    for (const entry of entries) {
      const ticket = this.ticketOf(entry)
      if (!ticket) {
        if (entry.ticketId) this.retry(entry, 'The ticket disappeared')
        else this.retry(entry, 'The ticket was never created')
        continue
      }
      this.settle(entry, ticket)
    }
  }

  private settle(entry: QueueEntry, ticket: Ticket | undefined): void {
    if (!ticket) return this.retry(entry, 'The ticket disappeared')
    if (ticket.ended) {
      const { outcome, by } = ticket.ended
      if (outcome === 'completed' || outcome === 'merged' || outcome === 'closed') return this.succeed(entry)
      if (outcome === 'stopped' && by === 'human') return this.finish(entry, 'cancelled', 'Stopped by a person')
      return this.retry(entry, `The ticket ended: ${outcome}`)
    }
    // 工作单元报告失败或阻塞后工单在等人；项目重试接管，不再依赖人工跟进。
    if (ticketStage(ticket).stage === 'person') {
      this.host.store.atomic(() => this.host.engine.stopTicket(ticket.id, 'The assignment did not finish; the project retries it'))
      return this.retry(entry, 'The assignment did not finish')
    }
  }

  /** 项目轮询结果合并进队列：消失的任务取消，新工作项入队，已完成的同项不重复。 */
  private reconcile(projectId: string, project: Settings['projects'][string], tasks: readonly RawTask[]): void {
    const pending = new Set(project.taskPolicy.pendingStatuses.map(status => status.toLowerCase()))
    const present = new Map<string, RawTask>()
    for (const task of tasks) if (pending.has(task.status.trim().toLowerCase())) present.set(task.id, task)
    const entries = this.host.store.queue.list().filter(entry => entry.project === projectId)
    const latest = new Map<string, QueueEntry>()
    for (const entry of entries) latest.set(`${entry.task}\u0000${entry.item}`, entry)
    // 先处理消失：活动条目取消并留痕，其他条目记为不在来源中，等重新出现时再入队。
    for (const entry of entries) {
      if (present.has(entry.task)) {
        if (!entry.present) this.save({ ...entry, present: true, updatedAt: this.stamp() })
        continue
      }
      const absent = entry.present ? { ...entry, present: false, updatedAt: this.stamp() } : entry
      if (entry.present) this.save(absent)
      if (queueActive(absent)) this.cancel(absent, 'The task disappeared from its source')
    }
    for (const task of present.values()) {
      const items = splitTask(task)
      items.forEach((item, index) => {
        const id = `${task.id}\u0000${index}`
        const previous = latest.get(id)
        if (previous && !this.enqueueable(previous)) return
        const appearance = entries.filter(entry => entry.task === task.id && entry.item === index).length
        const entry: QueueEntry = {
          id: queueId(projectId, task.id, index, appearance),
          project: projectId, task: task.id, item: index, title: item.title, text: item.text, taskTitle: task.title,
          state: 'queued', attempt: 0, seq: this.nextSeq(), enqueuedAt: this.stamp(), updatedAt: this.stamp(), dueAt: this.now(),
          tickets: [], present: true,
        }
        this.save(entry)
      })
    }
  }

  /** 上一条记录是否允许再入队：进行中的不重复；成功的不重跑；最终失败与取消仅在重新出现后允许。 */
  private enqueueable(entry: QueueEntry): boolean {
    if (queueActive(entry)) return false
    if (entry.state === 'succeeded') return false
    return !entry.present
  }

  /** 把变更写回队列；调用方已持有事务。 */
  private save(entry: QueueEntry): void {
    this.host.store.queue.save(entry)
    this.changed()
  }

  private dispatch(entry: QueueEntry): boolean {
    const settings = this.host.settings()
    const project = settings.projects[entry.project]
    if (!project?.enabled) return false
    const starting: QueueEntry = { ...entry, state: 'starting', startedAt: this.stamp(), updatedAt: this.stamp(), dueAt: this.now() }
    this.host.store.atomic(() => this.host.store.queue.save(starting))
    const triggerId = key('trigger', 'schedule', entry.project, entry.id)
    const input: ScheduledTicket = {
      trigger: {
        id: triggerId, source: project.codeRepo, threads: [{ source: project.codeRepo, id: `schedule/${entry.project}` }],
        actor: { source: project.codeRepo, id: entry.project }, human: false, at: new Date(this.now()).toISOString(),
        text: entry.title, meta: { project: entry.project, task: entry.task, item: String(entry.item) },
      },
      project: entry.project, projectName: project.name, task: entry.task, title: entry.title, scope: entry.text,
      reason: `Scheduled from ${project.name}`, name: this.worktreeName(entry),
    }
    try {
      const { ticketId } = this.host.engine.schedule(input)
      const running: QueueEntry = { ...starting, state: 'running', ticketId, tickets: [...entry.tickets, ticketId], updatedAt: this.stamp() }
      this.host.store.atomic(() => this.host.store.queue.save(running))
      this.changed()
      return true
    } catch (error) {
      this.retry(starting, `Could not create the ticket: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private succeed(entry: QueueEntry): void {
    this.writeBack(entry, 'done')
    this.finish(entry, 'succeeded', undefined)
  }

  /** 失败后按项目退避重排；达到 `maxRetries` 后进入最终失败并回写失败状态。 */
  private retry(entry: QueueEntry, reason: string): void {
    const project = this.host.settings().projects[entry.project]
    const attempt = entry.attempt + 1
    if (!project || attempt > project.retry.maxRetries) {
      this.writeBack(entry, 'failed')
      return this.finish({ ...entry, attempt }, 'failed', reason)
    }
    const due = this.now() + project.retry.retryBackoffSeconds * 1000
    this.save({ ...entry, state: 'queued', attempt, dueAt: due, updatedAt: this.stamp(), reason, ticketId: undefined, startedAt: undefined })
  }

  private cancel(entry: QueueEntry, reason: string): void {
    if (entry.state === 'running' && entry.ticketId) {
      try {
        this.host.store.atomic(() => this.host.engine.stopTicket(entry.ticketId!, reason))
      } catch { /* 工单已结束或不存在：队列仍按取消记录，避免重复派工。 */ }
    }
    this.finish(entry, 'cancelled', reason)
  }

  private finish(entry: QueueEntry, state: 'succeeded' | 'failed' | 'cancelled', reason: string | undefined): void {
    this.save({ ...entry, state, endedAt: this.stamp(), updatedAt: this.stamp(), ...(reason ? { reason } : {}) })
  }

  /** 成功后回写任务状态；失败只记录在队列条目上，不改变工单结果。 */
  private writeBack(entry: QueueEntry, kind: 'done' | 'failed'): void {
    const settings = this.host.settings()
    const project = settings.projects[entry.project]
    const record = project && settings.taskSources[project.taskSource]
    const driver = record && this.registry.kind(record.kind)
    if (!project || !record?.enabled || !driver?.writeback) return
    const parsed = driver.schema.safeParse(record.config)
    if (!parsed.success) return
    const status = kind === 'done' ? project.taskPolicy.doneStatus : project.taskPolicy.failedStatus
    const context = { signal: this.host.lifetime, syncRepo: this.syncRepo }
    void driver.writeback(parsed.data, { taskId: entry.task, taskTitle: entry.taskTitle }, status, context)
      .catch(error => {
        this.errors.set(entry.project, `Writeback failed: ${error instanceof Error ? error.message : String(error)}`)
        this.changed()
      })
  }

  private ticketOf(entry: QueueEntry): Ticket | undefined {
    return entry.ticketId ? this.host.store.tickets.get(entry.ticketId) : undefined
  }

  private nextSeq(): number {
    return this.host.store.queue.maxSeq() + 1
  }

  private worktreeName(entry: QueueEntry): string {
    const slug = entry.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
    return `task-${slug || entry.item}`
  }

  private boundCommands(config: Record<string, unknown>, repo: string): Commands {
    const source = typeof config.source === 'string' && config.source ? config.source : repo
    return this.host.commands.scope(source)
  }

  private async defaultSync(repo: string): Promise<string> {
    const result = await syncRepoWorkCopy({ commands: this.host.commands.scope(repo), stateDir: this.host.stateDir, repo, signal: this.host.lifetime })
    return result.directory
  }

  private fail(projectId: string, message: string): void {
    this.errors.set(projectId, message)
    this.changed()
  }

  private now(): number { return this.host.now ? this.host.now() : Date.now() }
  private stamp(): string { return new Date(this.now()).toISOString() }
  private changed(): void { this.host.onChange?.() }
}
