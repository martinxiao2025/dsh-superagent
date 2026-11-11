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
import type { FeishuWikiReader } from '../task-sources/feishu-api.ts'
import type { Store } from './store.ts'
import type { Effects } from './effects.ts'
import type { Health } from '../sources/host.ts'
import { queueActive, queueId, queueInFlight, queueItemKey, type QueueEntry, type QueueSnapshot } from '../queue/model.ts'

/** 写入外部清单的持久化副作用载荷；键由队列条目与尝试次数决定，重复投递幂等。 */
export interface WritebackPayload {
  project: string
  task: string
  taskTitle: string
  status: string
}

/** 调度器需要的宿主能力；测试可以替换任务来源注册表与代码仓库同步。 */
export interface SchedulerHost {
  readonly store: Store
  readonly settings: () => Settings
  readonly engine: Pick<Engine, 'schedule' | 'stopTicket'>
  /** 执行器当前的槽位占用与项目占用。 */
  readonly executor: { slotsInUse(): number; projectsInUse(): string[] }
  /** 持久化副作用队列：回写经由它重试与观测。 */
  readonly effects: Pick<Effects, 'enqueue' | 'cancel'>
  readonly commands: Commands
  readonly stateDir: string
  readonly lifetime: AbortSignal
  /** 任务来源驱动注册表；默认使用内置注册表。 */
  readonly registry?: TaskSourceRegistry
  /** 同步代码仓库并返回工作副本目录；默认走 `syncRepoWorkCopy`。 */
  readonly syncRepo?: (repo: string) => Promise<string>
  /** 按飞书凭据 ID 取知识库读取能力；飞书知识库任务来源使用。 */
  readonly feishuWiki?: FeishuWikiReader
  /** 队列变化后的通知，供上层刷新。 */
  readonly onChange?: () => void
  /** 调度健康条目；轮询、建单与工作区回收的结果写在这里，面板据 `category` 区分调度故障。 */
  readonly health?: { set(health: Health): void }
  /** 回收过期的执行工作区；实现必须跳过运行中或仍被未结束工单引用的目录。 */
  readonly collectWorkspaces?: () => Promise<void>
  readonly now?: () => number
}

/** 检查轮询与创建工单之间的最短间隔。 */
const TICK_MS = 15_000
/** 终态条目在队列中的保留时长；更早的记录在轮询时清理。 */
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000
/** 工作区回收的间隔；与保留期无关，保留期由实现按工单结束时间判断。 */
const GC_INTERVAL_MS = 60 * 60_000

/** 项目调度器：轮询任务来源、维护持久化队列、在容量允许时建单并跟踪工单终态。 */
export class ProjectScheduler {
  private timer: NodeJS.Timeout | undefined
  private readonly nextPoll = new Map<string, number>()
  private readonly errors = new Map<string, string>()
  private readonly registry: TaskSourceRegistry
  private readonly syncRepo: (repo: string) => Promise<string>
  private running = false
  private nextGc = 0
  private gcError = ''

  constructor(private readonly host: SchedulerHost) {
    this.registry = host.registry ?? taskSources
    this.syncRepo = host.syncRepo ?? (repo => this.defaultSync(repo))
  }

  /** 启动周期检查；`runOnStart` 的项目立即轮询一次，其余项目等首个间隔到期。 */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    const now = this.now()
    this.nextGc = now
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
    this.retire()
    this.pump()
    await this.reclaim()
    this.reportHealth()
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
      tasks = await driver.list(parsed.data, { signal: this.host.lifetime, commands: this.boundCommands(parsed.data, project.codeRepo),
        syncRepo: this.syncRepo, feishu: this.host.feishuWiki })
    } catch (error) {
      return this.fail(projectId, String(error instanceof Error ? error.message : error))
    }
    this.errors.delete(projectId)
    this.host.store.atomic(() => {
      this.reconcile(projectId, project, tasks)
      // 终态只保留有限窗口：活动条目才是队列事实来源，历史记录过期后清理。
      this.host.store.queue.prune(projectId, new Date(this.now() - TERMINAL_RETENTION_MS).toISOString())
    })
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
      // 停用或删除的项目不再领取排队项；条目保留供恢复后继续。
      if (!settings.projects[entry.project]?.enabled) continue
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
    const projects = Object.entries(settings.projects).map(([id, project]) => ({
      id, name: project.name, enabled: project.enabled,
      ...(this.nextPoll.has(id) ? { nextPollAt: new Date(this.nextPoll.get(id)!).toISOString() } : {}),
      ...(this.errors.get(id) ? { lastError: this.errors.get(id)! } : {}),
    }))
    const topError = this.errors.get('')
    return {
      at: new Date(this.now()).toISOString(),
      maxWorkers: settings.executor.maxWorkers,
      used: this.host.executor.slotsInUse(),
      ...(topError ? { error: topError } : {}),
      projects,
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
        // 启动时只轮询 `runOnStart` 的项目；之后按各自的下次轮询时间到期执行。
        if (startup ? !project.schedule.runOnStart : due !== undefined && due > now) continue
        await this.poll(id)
      }
      for (const entry of this.host.store.queue.active().filter(queueInFlight)) this.settle(entry, this.ticketOf(entry))
      this.retire()
      this.pump()
      await this.reclaim()
    } catch (error) {
      // 单次检查失败不终止周期任务；具体项目的错误已记录在 `errors` 中。
      if (!this.host.lifetime.aborted) this.errors.set('', String(error instanceof Error ? error.message : error))
    } finally {
      this.running = false
      this.reportHealth()
    }
  }

  /** 按固定间隔回收过期工作区；失败不阻塞调度，只记录在调度健康条目中。 */
  private async reclaim(): Promise<void> {
    if (!this.host.collectWorkspaces || this.now() < this.nextGc) return
    this.nextGc = this.now() + GC_INTERVAL_MS
    try {
      await this.host.collectWorkspaces()
      this.gcError = ''
    } catch (error) {
      this.gcError = String(error instanceof Error ? error.message : error)
    }
  }

  /** 把轮询错误、队列规模与工作区回收结果汇总到调度健康条目。 */
  private reportHealth(): void {
    // 停止过程中数据库可能已经关闭；健康上报不是关键路径，跳过即可。
    if (!this.host.health || this.host.lifetime.aborted) return
    try {
      const projects = Object.values(this.host.settings().projects).filter(project => project.enabled).length
      const items = this.host.store.queue.list()
      const queued = items.filter(entry => entry.state === 'queued').length
      const running = items.filter(queueInFlight).length
      const failures = [...this.errors.entries()].map(([id, message]) => `${id || 'scheduler'}: ${message}`)
      if (this.gcError) failures.push(`workspace reclaim: ${this.gcError}`)
      const summary = `${projects} project(s); ${queued} queued; ${running} running`
      this.host.health.set({ state: failures.length ? 'error' : 'ready', detail: failures.length ? `${summary}; ${failures.join('; ')}` : summary,
        at: new Date(this.now()).toISOString(), category: 'schedule' })
    } catch { /* 关闭或数据库不可读时保持上一条健康状态。 */ }
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

  /**
   * 项目轮询结果合并进队列：按「任务 + 工作项稳定键」核对，消失的工作项取消、
   * 内容变化的旧条目被取代、新工作项入队；已完成且内容未变的同项不重复。
   */
  private reconcile(projectId: string, project: Settings['projects'][string], tasks: readonly RawTask[]): void {
    const pending = new Set(project.taskPolicy.pendingStatuses.map(status => status.toLowerCase()))
    const present = new Map<string, RawTask>()
    for (const task of tasks) if (pending.has(task.status.trim().toLowerCase())) present.set(task.id, task)
    const entries = this.host.store.queue.list().filter(entry => entry.project === projectId)
    const latest = new Map<string, QueueEntry>()
    for (const entry of entries) latest.set(`${entry.task}\u0000${queueItemKey(entry)}`, entry)
    // 先处理整条任务消失：活动条目取消并留痕，其他条目记为不在来源中，等重新出现时再入队。
    for (const entry of entries) {
      if (present.has(entry.task)) continue
      const absent = entry.present ? { ...entry, present: false, updatedAt: this.stamp() } : entry
      if (entry.present) this.save(absent)
      if (queueActive(absent)) this.cancel(absent, 'The task disappeared from its source')
    }
    for (const task of present.values()) {
      const items = splitTask(task)
      const keys = new Set(items.map(item => item.itemKey))
      const owned = entries.filter(entry => entry.task === task.id)
      // 任务仍在，但某个工作项被删除、重排或改写：已排队的不再执行旧内容；执行中的先跑完再结算。
      for (const entry of owned) {
        if (keys.has(queueItemKey(entry))) continue
        const absent = entry.present ? { ...entry, present: false, updatedAt: this.stamp() } : entry
        if (entry.present) this.save(absent)
        if (absent.state === 'queued') this.cancel(absent, 'The work item changed or disappeared; its newer version is queued')
      }
      items.forEach((item, index) => {
        const previous = latest.get(`${task.id}\u0000${item.itemKey}`)
        if (previous) {
          const changed = previous.contentHash !== undefined && previous.contentHash !== item.contentHash
          if (queueInFlight(previous)) return
          if (previous.state === 'queued' && changed) this.cancel({ ...previous, present: false }, 'The work item changed; its newer version is queued')
          else if (queueActive(previous)) {
            if (!previous.present) this.save({ ...previous, present: true, updatedAt: this.stamp() })
            return
          } else if (previous.state === 'succeeded' && !changed) return
          else if (previous.present && !changed) return
        }
        const appearance = owned.filter(entry => queueItemKey(entry) === item.itemKey).length
        const entry: QueueEntry = {
          id: queueId(projectId, task.id, item.itemKey, appearance),
          project: projectId, task: task.id, item: index, itemKey: item.itemKey, contentHash: item.contentHash,
          title: item.title, text: item.text, taskTitle: task.title,
          state: 'queued', attempt: 0, seq: this.nextSeq(), enqueuedAt: this.stamp(), updatedAt: this.stamp(), dueAt: this.now(),
          tickets: [], present: true,
        }
        this.save(entry)
      })
    }
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
    // 每次尝试都必须是一个新的触发器与工单：复用已结束工单的触发器只会拿回旧工单，重试不会真正执行。
    const triggerId = key('trigger', 'schedule', entry.id, String(entry.attempt))
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
      this.writeBack({ ...entry, attempt }, 'failed')
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

  /** 停用的项目保留排队项但不派工（`pump` 跳过）；项目记录已不存在的条目取消，避免成为永久孤儿。 */
  private retire(): void {
    const projects = this.host.settings().projects
    for (const entry of this.host.store.queue.list()) {
      if (entry.state !== 'queued') continue
      if (projects[entry.project]) continue
      this.finish(entry, 'cancelled', 'The project was removed')
    }
  }

  /** 项目被删除后清理它的全部队列记录，并停止仍在执行的工单；由设置删除入口调用。 */
  forget(projectId: string): void {
    const entries = this.host.store.queue.list().filter(entry => entry.project === projectId)
    for (const entry of entries) {
      if (queueInFlight(entry) && entry.ticketId) {
        try { this.host.store.atomic(() => this.host.engine.stopTicket(entry.ticketId!, 'The project was removed')) }
        catch { /* 工单已结束或不存在：仍然清理队列记录。 */ }
      }
      this.host.effects.cancel('writeback', key('writeback', entry.id, 'done', String(entry.attempt)))
      this.host.effects.cancel('writeback', key('writeback', entry.id, 'failed', String(entry.attempt)))
    }
    this.host.store.atomic(() => this.host.store.queue.remove(projectId))
    this.changed()
  }

  /**
   * 手动重试一个已结束或退避中的队列条目：重置尝试次数并立刻重新排队。
   * 排队中或正在执行的条目不做处理，避免重复派工；返回是否真的发生了重试。
   */
  retryEntry(id: string): { retried: boolean } {
    const entry = this.host.store.queue.get(id)
    if (!entry || queueActive(entry)) return { retried: false }
    // 重试前取消旧尝试待执行的写回，避免过期结果覆盖新一轮的状态。
    this.host.effects.cancel('writeback', key('writeback', entry.id, 'done', String(entry.attempt)))
    this.host.effects.cancel('writeback', key('writeback', entry.id, 'failed', String(entry.attempt)))
    this.save({ ...entry, state: 'queued', attempt: 0, dueAt: this.now(), updatedAt: this.stamp(),
      reason: undefined, endedAt: undefined, startedAt: undefined, ticketId: undefined })
    this.pump()
    return { retried: true }
  }

  /**
   * 手动取消一个活动中的队列条目：运行中的工单先停止，再把条目标记为已取消。
   * 已结束的条目保持原状，返回是否发生了取消。
   */
  cancelEntry(id: string): { cancelled: boolean } {
    const entry = this.host.store.queue.get(id)
    if (!entry || !queueActive(entry)) return { cancelled: false }
    this.cancel(entry, 'Cancelled from the panel')
    return { cancelled: true }
  }

  /**
   * 清空排队项：只取消 `queued` 条目，运行中的任务不受影响；
   * 传入项目 ID 时只清理该项目的排队项，返回被取消的条目数。
   */
  clearQueue(project?: string): { cancelled: number } {
    const entries = this.host.store.queue.list().filter(entry => entry.state === 'queued' && (!project || entry.project === project))
    for (const entry of entries) this.finish(entry, 'cancelled', 'Cleared from the panel')
    return { cancelled: entries.length }
  }

  /** 成功后回写任务状态；失败只记录在队列条目上，不改变工单结果。 */
  private writeBack(entry: QueueEntry, kind: 'done' | 'failed'): void {
    const settings = this.host.settings()
    const project = settings.projects[entry.project]
    const record = project && settings.taskSources[project.taskSource]
    const driver = record && this.registry.kind(record.kind)
    if (!project || !record?.enabled || !driver?.writeback) return
    const status = kind === 'done' ? project.taskPolicy.doneStatus : project.taskPolicy.failedStatus
    // 持久化副作用：进程重启后仍会重试；键含尝试次数，重复投递不会改变结果。
    this.host.effects.enqueue('writeback', key('writeback', entry.id, kind, String(entry.attempt)),
      { project: entry.project, task: entry.task, taskTitle: entry.taskTitle, status })
  }

  /** 副作用处理器：把状态写回任务来源；失败抛出，由 `Effects` 退避重试并上报健康度。 */
  async writeBackNow(payload: WritebackPayload): Promise<void> {
    const settings = this.host.settings()
    const project = settings.projects[payload.project]
    const record = project && settings.taskSources[project.taskSource]
    const driver = record && this.registry.kind(record.kind)
    if (!project || !record?.enabled || !driver?.writeback) throw new Error(`The task source for ${payload.project} is unavailable`)
    const parsed = driver.schema.safeParse(record.config)
    if (!parsed.success) throw new Error(`Invalid task source configuration: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    await driver.writeback(parsed.data, { taskId: payload.task, taskTitle: payload.taskTitle }, payload.status,
      { signal: this.host.lifetime, syncRepo: this.syncRepo, commands: this.boundCommands(parsed.data, project.codeRepo) })
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
    if (result.empty) throw new Error(`代码仓库为空，没有分支或提交：${repo}`)
    return result.directory
  }

  private fail(projectId: string, message: string): void {
    this.errors.set(projectId, message)
    this.reportHealth()
    this.changed()
  }

  private now(): number { return this.host.now ? this.host.now() : Date.now() }
  private stamp(): string { return new Date(this.now()).toISOString() }
  private changed(): void { this.host.onChange?.() }
}
