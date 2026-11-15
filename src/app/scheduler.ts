/**
 * 项目调度：按项目轮询任务来源，把待办工作项持久化进队列，按全局 FIFO 与项目轮转出队建单，
 * 并把工单终态、失败退避与任务消失写回队列。队列本身是唯一的事实来源，重启后从队列继续。
 * 本文件是门面：持有调度状态与共享助手，轮询合并、派工结算与结果回写分别由
 * `scheduler-reconcile`、`scheduler-dispatch`、`scheduler-writeback` 三个模块承担。
 */
import type { Engine } from '../core/index.ts'
import { key } from '../core/ids.ts'
import type { Settings } from '../policy.ts'
import type { Commands } from '../infra/commands.ts'
import type { GitAuth } from '../code-repos/port.ts'
import { projectRepoId, type Project } from '../projects/kind.ts'
import type { TaskSourceRegistry } from '../task-sources/index.ts'
import type { FeishuWikiReader } from '../task-sources/feishu-api.ts'
import type { FeishuImReader } from '../task-sources/feishu-im-api.ts'
import type { Store } from './store.ts'
import type { Effects } from './effects.ts'
import type { Health } from '../infra/health.ts'
import { queueActive, queueInFlight, type QueueEntry, type QueueSnapshot } from '../queue/model.ts'
import { SchedulerReconcile } from './scheduler-reconcile.ts'
import { SchedulerDispatch } from './scheduler-dispatch.ts'
import { SchedulerWriteback, type WritebackPayload } from './scheduler-writeback.ts'

export type { WritebackPayload }

/** 全局队列页：快照本体附分页元数据；字段只增不改名，既有消费者与测试桩按可选对待新增字段。 */
export interface QueuePage extends QueueSnapshot {
  /** 全部队列条目数（活动 + 终态）。 */
  total?: number
  /** 终态条目是否还有更早的一页。 */
  more?: boolean
}

/** 调度器需要的宿主能力；测试可以替换任务来源注册表与代码仓库同步。 */
export interface SchedulerHost {
  readonly store: Store
  readonly settings: () => Settings
  /** 项目记录（独立建表）：按 ID 取单个，或取全部的 `Record` 视图。 */
  readonly projects: () => Record<string, Project>
  readonly project: (id: string) => Project | undefined
  readonly engine: Pick<Engine, 'schedule' | 'stopTicket'>
  /** 执行器当前的槽位占用与项目占用。 */
  readonly executor: { slotsInUse(): number; projectsInUse(): string[] }
  /** 持久化副作用队列：回写经由它重试与观测。 */
  readonly effects: Pick<Effects, 'enqueue' | 'cancel'>
  readonly commands: Commands
  readonly stateDir: string
  readonly lifetime: AbortSignal
  /** 任务来源驱动注册表；由组合根显式传入（评审 P1-9：调度器不隐式依赖模块单例）。 */
  readonly registry: TaskSourceRegistry
  /** 同步项目代码仓库并返回工作副本目录；由组合根显式传入（轮询路径，分叉时无损失败）。 */
  readonly syncRepo: (projectId: string) => Promise<string>
  /**
   * 回写路径的仓库同步（评审 S1）：分叉时重置到远端并依赖副作用重试重放写入。
   * 缺省退回 `syncRepo`（未接入 push 的部署维持无损语义）。
   */
  readonly syncRepoForWrite?: (projectId: string) => Promise<string>
  /** 把回写产生的本地提交推送远端（评审 S1）；驱动声明 push 能力时在回写副作用内调用。 */
  readonly pushRepo?: (projectId: string) => Promise<void>
  /** 按 Git 凭据 ID 取一次同步材料；项目未选择凭据时返回 undefined。 */
  readonly gitAuth?: (credential: string) => GitAuth | undefined
  /** 按飞书凭据 ID 取知识库读取能力；飞书知识库任务来源使用。 */
  readonly feishuWiki?: FeishuWikiReader
  /** 按飞书凭据 ID 取群消息读取能力；飞书消息任务来源使用。 */
  readonly feishuIm?: FeishuImReader
  /** 队列变化后的通知，供上层刷新。 */
  readonly onChange?: () => void
  /** 调度健康条目；轮询、建单与工作区回收的结果写在这里，面板据 `category` 区分调度故障。 */
  readonly health?: { set(health: Health): void }
  /**
   * 告警出口：把需要人注意的调度故障注入主会话（同名通知合并，恢复时再次注入）。
   * 由 Runtime 用 Sessions.notify 实现；缺省为空操作（单测与不装配主会话的场景）。
   */
  readonly alert?: (name: string, message: string) => void
  /** 回收过期的执行工作区；实现必须跳过运行中或仍被未结束工单引用的目录。 */
  readonly collectWorkspaces?: () => Promise<void>
  /** 到期时间的抖动随机源；返回 [0,1)。测试可注入固定值。 */
  readonly jitter?: () => number
  readonly now?: () => number
}

/** 检查轮询与创建工单之间的最短间隔。 */
const TICK_MS = 15_000
/** 工作区回收的间隔；与保留期无关，保留期由实现按工单结束时间判断。 */
const GC_INTERVAL_MS = 60 * 60_000
/** 一轮检查内并行轮询的项目数上限；单项目内部仍串行，忙项目由 busy 检测推迟。副作用 `poll` 处理器的全局并发上限同值。 */
export const POLL_CONCURRENCY = 4
/** 到期时间的抖动幅度：±10%，避免启用的项目在同一秒集中打远端。 */
const POLL_JITTER = 0.1

/** 项目调度器：轮询任务来源、维护持久化队列、在容量允许时建单并跟踪工单终态。 */
export class ProjectScheduler {
  private timer: NodeJS.Timeout | undefined
  private readonly nextPoll = new Map<string, number>()
  private readonly errors = new Map<string, string>()
  /** 因项目忙而推迟轮询的原因与时间；下一次真正轮询时清除，供快照展示。 */
  private readonly deferred = new Map<string, { reason: string; at: string }>()
  private readonly registry: TaskSourceRegistry
  private readonly syncRepo: (projectId: string) => Promise<string>
  /** 手动扫描与定时检查共用的执行链；非空表示当前有一轮检查在跑。 */
  private cycle: Promise<void> | undefined
  private nextGc = 0
  private gcError = ''
  /** 轮询合并、派工结算与结果回写模块；各自只看得到门面提供给它的那一部分能力。 */
  private readonly reconcile: SchedulerReconcile
  private readonly dispatch: SchedulerDispatch
  private readonly writeback: SchedulerWriteback
  /** 到期时间的抖动随机源；测试可注入固定值，使时间断言确定。 */
  private readonly jitter: () => number
  /** 上一轮已告警的项目故障；故障消失后的下一轮会注入恢复通知。 */
  private readonly alerted = new Map<string, string>()
  /** 已告警的写回积压数量；积压清空后注入恢复通知。 */
  private writebackAlerted = 0

  constructor(private readonly host: SchedulerHost) {
    this.registry = host.registry
    this.syncRepo = host.syncRepo
    this.jitter = host.jitter ?? Math.random
    this.writeback = new SchedulerWriteback({ host, registry: this.registry, syncRepo: host.syncRepoForWrite ?? this.syncRepo,
      ...(host.pushRepo ? { pushRepo: projectId => host.pushRepo!(projectId) } : {}),
      busy: projectId => this.busy(projectId),
      polling: projectId => this.reconcile.polling(projectId),
      sourceConfig: (fields, config, feishuCredential) => this.sourceConfig(fields, config, feishuCredential) })
    this.reconcile = new SchedulerReconcile({ host, nextPoll: this.nextPoll, errors: this.errors, deferred: this.deferred,
      registry: this.registry, syncRepo: this.syncRepo, busy: projectId => this.busy(projectId),
      nextPollOf: intervalMs => this.nextPollOf(intervalMs),
      fail: (projectId, message) => this.fail(projectId, message), save: entry => this.save(entry),
      cancel: (entry, reason) => this.dispatch.cancel(entry, reason),
      sourceConfig: (fields, config, feishuCredential) => this.sourceConfig(fields, config, feishuCredential),
      changed: () => this.changed(), now: () => this.now(), stamp: () => this.stamp() })
    this.dispatch = new SchedulerDispatch({ host, save: entry => this.save(entry),
      writeBack: (entry, kind) => this.writeback.writeBack(entry, kind), changed: () => this.changed(),
      now: () => this.now(), stamp: () => this.stamp() })
  }

  /** 启动周期检查；`runOnStart` 的项目立即轮询一次，其余项目等首个间隔（含抖动）到期。 */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    this.nextGc = this.now()
    for (const [id, project] of Object.entries(this.host.projects())) {
      if (project.enabled && !project.schedule.runOnStart) this.nextPoll.set(id, this.nextPollOf(project.schedule.intervalMinutes * 60_000))
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
    return this.runExclusive(async () => {
      // 一轮检查只取一次设置并沿执行链传递，轮询循环内不再重复读取。
      const settings = this.host.settings()
      try {
        await this.dispatch.recover()
        await this.pollProjects(Object.entries(this.host.projects()).filter(([, project]) => project.enabled).map(([id]) => id), settings)
        this.dispatch.retire()
        this.dispatch.pump(settings)
        await this.reclaim()
      } catch (error) {
        // 与定时检查一致：一轮失败记在调度级错误上，不向调用方抛出。
        if (!this.host.lifetime.aborted) this.errors.set('', String(error instanceof Error ? error.message : error))
      } finally {
        this.reportHealth(settings)
        this.reportAlerts(settings)
      }
    })
  }

  /**
   * 手动扫描与定时检查共用同一条执行链：已有检查在跑时，后到的调用等待它结束，
   * 保证同一项目不会被两个循环并发轮询。
   */
  private runExclusive(body: () => Promise<void>): Promise<void> {
    if (this.cycle) return this.cycle
    this.cycle = body().finally(() => { this.cycle = undefined })
    return this.cycle
  }

  /** 轮询一个项目：读取任务来源，取消消失的任务，把新的工作项入队。 */
  async poll(projectId: string, settings?: Settings): Promise<void> {
    return this.reconcile.poll(projectId, settings)
  }

  /** 把队列中到期的工作项出队建单；全局容量与项目串行同时生效。 */
  pump(settings?: Settings): void {
    this.dispatch.pump(settings)
  }

  /** 工单结束后把结果写回它对应的队列条目；重复调用幂等。 */
  observe(ticketId: string): void {
    this.dispatch.observe(ticketId)
  }

  /** 副作用处理器：把状态写回任务来源；失败抛出，由 `Effects` 退避重试并上报健康度。 */
  async writeBackNow(payload: WritebackPayload): Promise<void> {
    return this.writeback.writeBackNow(payload)
  }

  /** `poll` 副作用处理器：轮询一个项目的任务来源（键去重保证单项目串行）；失败记录在该项目上，由下一次到期重试。 */
  async pollNow(projectId: string): Promise<void> {
    if (this.host.lifetime.aborted) return
    try { await this.reconcile.poll(projectId) } catch (error) {
      this.fail(projectId, String(error instanceof Error ? error.message : error))
    }
  }

  /** 队列快照：面板读取；活动条目全量附带，终态条目按最新在前分页，计数由 SQL 汇总。 */
  snapshot(offset = 0, limit = 200): QueuePage {
    const settings = this.host.settings()
    const active = this.host.store.queue.active()
    const total = this.host.store.queue.count()
    const projects = Object.entries(this.host.projects()).map(([id, project]) => ({
      id, name: project.name, enabled: project.enabled,
      ...(this.nextPoll.has(id) ? { nextPollAt: new Date(this.nextPoll.get(id)!).toISOString() } : {}),
      ...(this.errors.get(id) ? { lastError: this.errors.get(id)! } : {}),
      ...(this.deferred.get(id) ? { deferred: this.deferred.get(id)! } : {}),
    }))
    const topError = this.errors.get('')
    return {
      at: new Date(this.now()).toISOString(),
      maxWorkers: settings.executor.maxWorkers,
      used: this.host.executor.slotsInUse(),
      ...(topError ? { error: topError } : {}),
      projects,
      // 活动条目是队列事实来源，始终全量；终态历史只给最新的一页，面板按 `more` 继续加载。
      items: [...active.map(entry => this.toItem(entry, settings)),
        ...this.host.store.queue.terminal(offset, limit).map(entry => this.toItem(entry, settings))],
      total,
      more: total > active.length + Math.max(0, offset) + Math.max(0, limit),
    }
  }

  /** 项目详情视图的完整条目集：活动按序 + 终态最新在前；详情页是交互路径，不做分页。 */
  projectQueue(projectId: string): QueueSnapshot {
    const settings = this.host.settings()
    const project = this.host.project(projectId)
    const status = { id: projectId, name: project?.name ?? projectId, enabled: project?.enabled ?? false,
      ...(this.nextPoll.has(projectId) ? { nextPollAt: new Date(this.nextPoll.get(projectId)!).toISOString() } : {}),
      ...(this.errors.get(projectId) ? { lastError: this.errors.get(projectId)! } : {}),
      ...(this.deferred.get(projectId) ? { deferred: this.deferred.get(projectId)! } : {}) }
    const topError = this.errors.get('')
    return {
      at: new Date(this.now()).toISOString(),
      maxWorkers: settings.executor.maxWorkers,
      used: this.host.executor.slotsInUse(),
      ...(topError ? { error: topError } : {}),
      projects: [status],
      items: [...this.host.store.queue.activeIn(projectId), ...this.host.store.queue.terminalIn(projectId)]
        .map(entry => this.toItem(entry, settings)),
    }
  }

  /** 队列条目的面板形态；字段与既有快照逐字一致（新增不改名）。 */
  private toItem(entry: QueueEntry, settings: Settings) {
    return { id: entry.id, project: entry.project, projectName: this.host.project(entry.project)?.name ?? entry.project,
      task: entry.task, item: entry.item, title: entry.title, state: entry.state, attempt: entry.attempt, dueAt: entry.dueAt,
      ...(entry.ticketId ? { ticketId: entry.ticketId } : {}), ...(entry.reason ? { reason: entry.reason } : {}),
      enqueuedAt: entry.enqueuedAt, updatedAt: entry.updatedAt }
  }

  /**
   * 定时检查；与手动 `scan` 共用执行链，已有检查在跑时直接并入那一轮。
   * 轮询本身是持久化副作用（`poll`，键为项目 ID）：tick 只投递到期项目，慢项目（大仓库首次 clone）
   * 不再阻塞同批其他项目、建单与回写；全局并发由 Effects 处理器的 limit 决定（Runtime 注册）。
   */
  private async tick(startup = false): Promise<void> {
    return this.runExclusive(async () => {
      // 一轮检查只取一次设置并沿执行链传递（设置已按修订缓存，这里避免热路径的重复读取）。
      const settings = this.host.settings()
      try {
        await this.dispatch.recover()
        for (const [id, project] of Object.entries(this.host.projects())) {
          if (!project.enabled) continue
          const next = this.nextPoll.get(id)
          // 启动时只轮询 `runOnStart` 的项目；之后按各自的下次轮询时间到期执行。
          if (startup ? !project.schedule.runOnStart : next !== undefined && next > this.now()) continue
          // 推进下次轮询时间并投递轮询副作用；同项目已有等待行时合并（键去重），运行中的一轮自然完成。
          this.nextPoll.set(id, this.nextPollOf(project.schedule.intervalMinutes * 60_000))
          this.host.effects.enqueue('poll', id, {})
        }
        for (const entry of this.host.store.queue.active().filter(queueInFlight)) this.dispatch.settle(entry, this.dispatch.ticketOf(entry))
        this.dispatch.retire()
        this.dispatch.pump(settings)
        await this.reclaim()
      } catch (error) {
        // 单次检查失败不终止周期任务；具体项目的错误已记录在 `errors` 中。
        if (!this.host.lifetime.aborted) this.errors.set('', String(error instanceof Error ? error.message : error))
      } finally {
        this.reportHealth(settings)
        this.reportAlerts(settings)
      }
    })
  }

  /**
   * 一轮检查内并行轮询一批项目：全局并发上限 `POLL_CONCURRENCY`，慢项目（大仓库 clone）
   * 不再阻塞其他项目的轮询与建单。单项目串行由忙检测保证：项目有任务在跑时 poll 会推迟，
   * 且同一轮内每个项目只出现一次。手动 `scan` 保留同步语义，等待本轮全部轮询完成。
   */
  private async pollProjects(projectIds: readonly string[], settings: Settings): Promise<void> {
    let index = 0
    const workers = Array.from({ length: Math.min(POLL_CONCURRENCY, projectIds.length) }, async () => {
      for (;;) {
        const current = projectIds[index++]
        if (current === undefined) return
        if (this.host.lifetime.aborted) return
        // 单项目失败已在 reconcile 内记录，不中断同批其他项目的轮询。
        try { await this.reconcile.poll(current, settings) } catch (error) {
          this.fail(current, String(error instanceof Error ? error.message : error))
        }
      }
    })
    await Promise.all(workers)
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

  /** 把轮询错误、队列规模与工作区回收结果汇总到调度健康条目；`settings` 由调用链传入时不再重复读取。 */
  private reportHealth(settings?: Settings): void {
    // 停止过程中数据库可能已经关闭；健康上报不是关键路径，跳过即可。
    if (!this.host.health || this.host.lifetime.aborted) return
    try {
      const projects = Object.values(this.host.projects()).filter(project => project.enabled).length
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

  /**
   * 需要人注意的调度故障经 `host.alert` 注入主会话（同名通知合并，恢复后注入恢复通知）：
   * 逐项目的轮询失败（连续或最近一轮），与写回副作用积压（条目在退避中反复失败）。
   * 仅在故障出现或消失的轮次注入，不重复打扰；健康条目仍承载完整细节。
   */
  private reportAlerts(settings: Settings): void {
    if (!this.host.alert || this.host.lifetime.aborted) return
    try {
      for (const [projectId, message] of this.errors) {
        if (!projectId || this.alerted.has(projectId)) continue
        this.alerted.set(projectId, message)
        this.host.alert(`schedule:poll:${projectId}`, `The task source for project ${projectId} keeps failing: ${message}`)
      }
      for (const [projectId, message] of [...this.alerted]) {
        if (this.errors.has(projectId)) continue
        this.alerted.delete(projectId)
        this.host.alert(`schedule:poll:${projectId}`, `Project ${projectId} is polling again; the earlier failure was: ${message}`)
      }
      const backlog = this.host.store.effects.stats('writeback').waiting
      if (backlog >= 3 && backlog !== this.writebackAlerted) {
        this.writebackAlerted = backlog
        this.host.alert('schedule:writeback', `${backlog} task results are waiting to be written back to their task sources; they retry with backoff`)
      } else if (backlog === 0 && this.writebackAlerted > 0) {
        this.writebackAlerted = 0
        this.host.alert('schedule:writeback', 'The writeback backlog has cleared')
      }
    } catch { /* 数据库不可读时跳过本轮告警。 */ }
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
    // 内存侧的轮询计时、错误与推迟原因一并清理，避免快照继续展示已删除的项目。
    this.nextPoll.delete(projectId)
    this.errors.delete(projectId)
    this.deferred.delete(projectId)
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
    this.dispatch.pump()
    return { retried: true }
  }

  /**
   * 手动取消一个活动中的队列条目：运行中的工单先停止，再把条目标记为已取消。
   * 已结束的条目保持原状，返回是否发生了取消。
   */
  cancelEntry(id: string): { cancelled: boolean } {
    const entry = this.host.store.queue.get(id)
    if (!entry || !queueActive(entry)) return { cancelled: false }
    this.dispatch.cancel(entry, 'Cancelled from the panel')
    return { cancelled: true }
  }

  /**
   * 清空排队项：只取消 `queued` 条目，运行中的任务不受影响；
   * 传入项目 ID 时只清理该项目的排队项，返回被取消的条目数。
   */
  clearQueue(project?: string): { cancelled: number } {
    const entries = this.host.store.queue.list().filter(entry => entry.state === 'queued' && (!project || entry.project === project))
    for (const entry of entries) this.dispatch.finish(entry, 'cancelled', 'Cleared from the panel')
    return { cancelled: entries.length }
  }

  /** 把变更写回队列；调用方已持有事务。 */
  private save(entry: QueueEntry): void {
    this.host.store.queue.save(entry)
    this.changed()
  }

  /** 项目是否仍有任务在执行：执行器占用与队列中的在途条目任一成立即视为忙。 */
  private busy(projectId: string): boolean {
    if (this.host.executor.projectsInUse().includes(projectId)) return true
    return this.host.store.queue.active().some(entry => entry.project === projectId && queueInFlight(entry))
  }

  /** 把项目级飞书凭据注入驱动配置；驱动未声明该字段时不添加，避免严格 schema 拒绝。 */
  private sourceConfig(fields: readonly { key: string }[],
    config: Record<string, unknown>, feishuCredential: string): Record<string, unknown> {
    const injected: Record<string, unknown> = {}
    if (fields.some(field => field.key === 'feishuCredential')) injected.feishuCredential = feishuCredential
    return { ...config, ...injected }
  }


  private fail(projectId: string, message: string): void {
    this.errors.set(projectId, message)
    this.reportHealth()
    this.changed()
  }

  /** 下次轮询时间：间隔加 ±10% 抖动，避免所有项目在同一时刻集中打远端。 */
  nextPollOf(intervalMs: number): number {
    const spread = Math.round(intervalMs * POLL_JITTER)
    return this.now() + intervalMs + Math.round((this.jitter() * 2 - 1) * spread)
  }

  private now(): number { return this.host.now ? this.host.now() : Date.now() }
  private stamp(): string { return new Date(this.now()).toISOString() }
  private changed(): void { this.host.onChange?.() }
}
