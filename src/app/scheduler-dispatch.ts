/** 项目调度器的派工与结算模块：把到期工作项出队建单，按工单实际状态结算队列条目；由 ProjectScheduler 组合。 */
import type { Engine, ScheduledTicket } from '../core/index.ts'
import { key } from '../core/ids.ts'
import { ticketStage, type Ticket } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import { projectRepoId } from '../projects/kind.ts'
import type { SchedulerHost } from './scheduler.ts'
import { queueActive, queueInFlight, type QueueEntry } from '../queue/model.ts'

/** dispatch 模块所需的调度器内部状态与共享助手；由 ProjectScheduler 显式装配。 */
export interface DispatchContext {
  readonly host: SchedulerHost
  /** 把变更写回队列并通知上层；调用方已持有事务。 */
  save(entry: QueueEntry): void
  /** 回写任务结果；由 writeback 模块提供。 */
  writeBack(entry: QueueEntry, kind: 'done' | 'failed'): void
  /** 通知上层队列发生变化。 */
  changed(): void
  now(): number
  stamp(): string
}

/** 派工与结算：队列条目到工单的生命周期与反向的终态结算。 */
export class SchedulerDispatch {
  constructor(private readonly base: DispatchContext) {}

  /** 启动恢复：没有工单的启动中条目视为上次中断，按失败重试；其余按工单实际状态结算。 */
  async recover(): Promise<void> {
    const entries = this.base.host.store.queue.list().filter(queueInFlight)
    for (const entry of entries) {
      const ticket = this.ticketOf(entry)
      if (!ticket) {
        if (entry.ticketId) this.retry(entry, 'The ticket disappeared')
        else if (this.scheduledTrigger(entry)) {
          // 这次尝试的建单事务已提交（触发器已落库）但队列行没跟上：按原尝试重新排队，
          // 让 pump 以同一触发器幂等派工拿回既有工单，而不是按失败重试生成重复工单。
          this.base.save({ ...entry, state: 'queued', dueAt: this.base.now(), updatedAt: this.base.stamp(), startedAt: undefined })
        } else this.retry(entry, 'The ticket was never created')
        continue
      }
      this.settle(entry, ticket)
    }
  }

  /** 这次尝试的建单触发器是否已落库；触发器与工单同事务写入，落库即代表建单事务已提交。 */
  private scheduledTrigger(entry: QueueEntry): boolean {
    // 可选链兜底：测试中的假存储可能未实现触发器仓储面，此时视为未落库。
    return !!this.base.host.store.triggers?.get(this.triggerIdOf(entry))
  }

  /**
   * 本次尝试的建单触发器 ID：attempt 与工单历史代次共同参与。
   * attempt 是重试预算（自动重试递增）；但手动重试（面板 `retryEntry`）会把 attempt 归零，
   * 若触发器只由 attempt 决定，归零后会命中历史尝试已用过的触发器，`engine.schedule`
   * 幂等拿回**已结束**的旧工单——重试不会真正执行，还会把旧结果再次回写（评审 C1）。
   * `tickets.length` 在每次真实建单后递增且永不复位，作为生命周期代次保证手动重试也拿到新触发器。
   */
  private triggerIdOf(entry: QueueEntry): string {
    return key('trigger', 'schedule', entry.id, String(entry.attempt), String(entry.tickets.length))
  }

  settle(entry: QueueEntry, ticket: Ticket | undefined): void {
    // 动作数据由纯函数 `settleOutcome` 给出（终态映射的唯一出口）；这里只负责按序解释执行。
    for (const action of settleOutcome(entry, ticket)) {
      if (action.kind === 'succeed') this.succeed(entry)
      else if (action.kind === 'finish') this.finish(entry, action.state, action.reason)
      else if (action.kind === 'stop-then-retry') {
        this.base.host.store.atomic(() => this.base.host.engine.stopTicket(action.ticketId,
          'The assignment did not finish; the project retries it'))
        this.retry(entry, action.reason)
      } else this.retry(entry, action.reason)
    }
  }

  ticketOf(entry: QueueEntry): Ticket | undefined {
    return entry.ticketId ? this.base.host.store.tickets.get(entry.ticketId) : undefined
  }

  /** 把队列中到期的工作项出队建单；全局容量与项目串行同时生效；`settings` 由调用链传入以避免重复读取。 */
  pump(settings: Settings = this.base.host.settings()): void {
    const busy = new Set([...this.base.host.executor.projectsInUse(), ...this.base.host.store.queue.active().filter(queueInFlight).map(entry => entry.project)])
    let used = this.base.host.executor.slotsInUse()
    // 出队扫描下推到 SQL（queued 且到期，按 seq 排序），不再解析整表 JSON。
    for (const entry of this.base.host.store.queue.ready(this.base.now())) {
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
    const entry = this.base.host.store.queue.byTicket(ticketId)
    if (!entry?.ticketId) return
    const ticket = this.base.host.store.tickets.get(ticketId)
    this.settle(entry, ticket)
  }

  /** 停用的项目保留排队项但不派工（`pump` 跳过）；项目记录已不存在的条目取消，避免成为永久孤儿。 */
  retire(): void {
    const projects = this.base.host.settings().projects
    for (const entry of this.base.host.store.queue.queued()) {
      if (projects[entry.project]) continue
      this.finish(entry, 'cancelled', 'The project was removed')
    }
  }

  /** 取消一个队列条目：运行中的工单先停止，避免重复派工；由面板操作与合并模块使用。 */
  cancel(entry: QueueEntry, reason: string): void {
    if (entry.state === 'running' && entry.ticketId) {
      try {
        this.base.host.store.atomic(() => this.base.host.engine.stopTicket(entry.ticketId!, reason))
      } catch { /* 工单已结束或不存在：队列仍按取消记录，避免重复派工。 */ }
    }
    this.finish(entry, 'cancelled', reason)
  }

  /** 结束一个队列条目并留痕；由结算、面板取消与清空排队项使用。 */
  finish(entry: QueueEntry, state: 'succeeded' | 'failed' | 'cancelled', reason: string | undefined): void {
    this.base.save({ ...entry, state, endedAt: this.base.stamp(), updatedAt: this.base.stamp(), ...(reason ? { reason } : {}) })
  }

  private dispatch(entry: QueueEntry): boolean {
    const settings = this.base.host.settings()
    const project = settings.projects[entry.project]
    if (!project?.enabled) return false
    const starting: QueueEntry = { ...entry, state: 'starting', startedAt: this.base.stamp(), updatedAt: this.base.stamp(), dueAt: this.base.now() }
    // 每次尝试都必须是一个新的触发器与工单：复用已结束工单的触发器只会拿回旧工单，重试不会真正执行。
    // 手动重试会把 attempt 归零，因此触发器还要带上工单历史代次（见 triggerIdOf）。
    const triggerId = this.triggerIdOf(entry)
    const repoId = projectRepoId(entry.project)
    const input: ScheduledTicket = {
      trigger: {
        id: triggerId, source: repoId, threads: [{ source: repoId, id: `schedule/${entry.project}` }],
        actor: { source: repoId, id: entry.project }, human: false, at: new Date(this.base.now()).toISOString(),
        text: entry.title, meta: { project: entry.project, task: entry.task, item: String(entry.item) },
      },
      project: entry.project, projectName: project.name, task: entry.task, title: entry.title, scope: entry.text,
      reason: `Scheduled from ${project.name}`, name: this.worktreeName(entry),
    }
    try {
      // 标记启动 → 建单（引擎内部是嵌套保存点，可安全并入外层事务）→ 标记运行收进同一事务：
      // 中途失败或崩溃时整体回滚，队列回到派工前的状态，不留「已标启动却没建单」的中间窗口。
      this.base.host.store.atomic(() => {
        this.base.host.store.queue.save(starting)
        const { ticketId } = this.base.host.engine.schedule(input)
        const running: QueueEntry = { ...starting, state: 'running', ticketId, tickets: [...entry.tickets, ticketId], updatedAt: this.base.stamp() }
        this.base.host.store.queue.save(running)
      })
      this.base.changed()
      return true
    } catch (error) {
      this.retry(starting, `Could not create the ticket: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private succeed(entry: QueueEntry): void {
    this.base.writeBack(entry, 'done')
    this.finish(entry, 'succeeded', undefined)
  }

  /** 失败后按项目退避重排；达到 `maxRetries` 后进入最终失败并回写失败状态。 */
  private retry(entry: QueueEntry, reason: string): void {
    const project = this.base.host.settings().projects[entry.project]
    const attempt = entry.attempt + 1
    if (!project || attempt > project.retry.maxRetries) {
      this.base.writeBack({ ...entry, attempt }, 'failed')
      return this.finish({ ...entry, attempt }, 'failed', reason)
    }
    const due = this.base.now() + project.retry.retryBackoffSeconds * 1000
    this.base.save({ ...entry, state: 'queued', attempt, dueAt: due, updatedAt: this.base.stamp(), reason, ticketId: undefined, startedAt: undefined })
  }

  private worktreeName(entry: QueueEntry): string {
    const slug = entry.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
    return `task-${slug || entry.item}`
  }
}

/** settleOutcome 的一个结算动作；`stop` 先停工单（person 阶段的项目接管），其余按队列侧动作命名。 */
export type SettleAction =
  | { kind: 'retry'; reason: string }
  | { kind: 'succeed' }
  | { kind: 'finish'; state: 'cancelled'; reason: string }
  | { kind: 'stop-then-retry'; ticketId: string; reason: string }

/**
 * 工单终态 → 队列结算的唯一映射出口。
 * 输入只依赖队列条目与工单的当前事实，输出动作数据；recover、observe（工单结束回调）
 * 与 settle 的所有调用方共用这一份语义，改动终态语义时只有这里一个出口。
 * `forget` 的时序契约（先停工单再清队列、迟到 observe 找不到条目）不在此列，由调用方保证。
 */
export function settleOutcome(entry: QueueEntry, ticket: Ticket | undefined): readonly SettleAction[] {
  if (!ticket) return [{ kind: 'retry', reason: 'The ticket disappeared' }]
  if (ticket.ended) {
    const { outcome, by } = ticket.ended
    if (outcome === 'completed' || outcome === 'merged' || outcome === 'closed') return [{ kind: 'succeed' }]
    if (outcome === 'stopped' && by === 'human') return [{ kind: 'finish', state: 'cancelled', reason: 'Stopped by a person' }]
    return [{ kind: 'retry', reason: `The ticket ended: ${outcome}` }]
  }
  // person 阶段按动作白名单接管（评审 C2）：只有 blocked/failed（工作单元已停滞且在等人，
  // 项目按既有语义自动重试接管）才 stop-then-retry。answer（工作单元向人提问）、review（ready
  // 报告等待关注线程关闭）与 delivery（输入投递失败，执行器自身带退避重试）不再被下一个
  // tick 强停重建——那会销毁工单上等待人的问题或已完成的报告，并烧掉项目重试预算。
  const stage = ticketStage(ticket)
  if (stage.stage === 'person' && (stage.action === 'blocked' || stage.action === 'failed')) {
    return [{ kind: 'stop-then-retry', ticketId: ticket.id, reason: 'The assignment did not finish' }]
  }
  return []
}
