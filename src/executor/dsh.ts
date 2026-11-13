/** DSH 执行器：为每个工单管理一个持久的工作单元会话和工作区目录。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { runningAssignment, type AssessmentOutcome, type Assignment, type EngineForExecutor, type Executor,
  type Ticket, type Trigger } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import { Later, type Effects } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import type { Variable } from '../app/execution-environment.ts'
import type { Sessions } from '../app/sessions.ts'
import { resultRelay } from '../app/notices.ts'
import { triggerMessage, workerSessionId } from './format.ts'
import type { HealthEntry } from '../infra/health.ts'
import { until } from './background.ts'
// 启动、投递、生命周期与空闲收尾的实现拆分在同目录的四个模块中；本类保留门面、
// 执行器级状态（槽位与事件订阅注销）以及按工单聚合的 WorkerState 登记。
import { ticketExecution, launchQueued } from './launch.ts'
import { TRANSIENT_TRIES, transient } from './idle.ts'
import { deliverQueued } from './delivery.ts'
import { install as installWorkers, resume as resumeWorkers, shutdown as shutdownWorkers, stop as lifecycleStop } from './lifecycle.ts'
// 运行时与行为快照测试仍从本门面导入这两个符号；`WorkerSlots` 是执行器级的并发基础设施，保留在此。
export { ticketExecution } from './launch.ts'
export { transient } from './idle.ts'

const now = (): string => new Date().toISOString()
/** `DshExecutor` 使用的宿主依赖。 */
export interface ExecutorHost {
  /** DSH Cordis 上下文：agent 及其事件，以及用于运行准备命令的子进程服务。 */
  readonly context: Context
  /** 执行器向引擎报告任务分配和输入的进展。 */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** 绑定到代码仓库记录的 git 入口；用于把项目仓库检出到工单目录。 */
  readonly commands: Pick<Commands, 'scope'>
  /** 持久的效果队列，启动和输入投递经由它运行。 */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** `worker` 健康条目，报告后台工作单元事件处理是否失败。 */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** 工作单元会话的会话管理器，以及把工作单元报告转发到主会话的通道。 */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'relay' | 'holds'>
  closing(): boolean
  /** 处理是否已暂停；暂停会搁置启动和输入投递。 */
  paused(): boolean
  /** 为 `ticket` 准备执行环境变量，传给其工作区准备命令。 */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** 消息 `trigger` 所回复的存储触发器（当其回复了某条消息时）。 */
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** 在 Store 中查找工单的来源触发器。 */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * 依据配置的并发上限跟踪活动中的和正在启动的工作单元会话：工单在其工作单元的回合运行时、
 * 在回合结束后其 shell 作业或子智能体仍运行时，以及在启动或唤醒该工作单元时占用一个槽位。
 * DshExecutor 在等待启动或唤醒工作之前同步预留槽位，以确保两次启动不会抢走最后一个槽位。
 * 全局上限是唯一硬上限；同一项目同时只允许一个任务，人工跟进也不能绕过。
 */
export class WorkerSlots {
  /** 当前持有启动槽位的工单，映射到该启动是启动、唤醒，还是因人的消息而唤醒。 */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - 返回其工作单元持有槽位的工单 ID（参见 `DshExecutor.running`）。
   * @param max - 返回配置的并发工作单元槽位上限。
   * @param projectOf - 返回工单所属项目；未提供时不做按项目限制。
   */
  constructor(private readonly running: () => string[], private readonly max: () => number,
    private readonly projectOf?: (ticketId: string) => string | undefined) {}
  /** `project` 当前占用的槽位（运行中与启动预留），排除正在为其预留的 `except` 本身。 */
  private projectUsed(project: string, except: string): number {
    return [...new Set([...this.running(), ...this.starting.keys()])].filter(id => id !== except && this.projectOf?.(id) === project).length
  }
  /** 当前在运行的工作单元和启动预留中已使用的槽位数量。 */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** 已有运行中或启动中任务的项目，按项目记录 ID 去重。 */
  projectsInUse(): string[] {
    return [...new Set([...this.running(), ...this.starting.keys()].map(id => this.projectOf?.(id)))]
      .filter((project): project is string => !!project)
  }
  /** 可并发运行的启动数量：未被运行中的工作单元或唤醒预留占用的槽位。 */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * 为 `ticketId` 预留启动槽位；若 `ticketId` 已持有启动槽位则幂等。
   * 全局上限与项目串行同时生效，人工跟进没有例外。
   * 在工作单元回合开始运行或启动/唤醒尝试结束时调用 `free(ticketId)`。
   * @throws 当没有空闲槽位，或该工单所属项目已有运行中/启动中的任务时抛出 Later。
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max()) throw new Later('No worker slot is free')
    const project = this.projectOf?.(ticketId)
    if (project && this.projectUsed(project, ticketId) >= 1) throw new Later(`The project ${project} already has a running task`)
    this.starting.set(ticketId, by)
  }
  /** 在工作单元会话开始运行或启动/唤醒尝试结束后，释放 `ticketId` 的启动槽位。 */
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/** 工单所属项目：优先执行时记录的项目名；旧工单退回执行目录的最后一段。 */
export function projectOfTicket(ticket: Ticket | undefined): string | undefined {
  if (!ticket) return undefined
  if (ticket.execution?.project) return ticket.execution.project
  const directory = ticket.execution?.directory
  return directory ? directory.split(/[\\/]+/).filter(Boolean).pop() : undefined
}

/**
 * 单个工作单元（按工单 ID 聚合）的易变状态；首次写入时创建，随执行器存续。
 * 启动/回合重试计数按任务分配维度保鲜：`assignmentId` 变化即清零，等价于旧实现按
 * `assignment.id`（启动加 `launch:` 前缀）作键的全新计数。
 */
export interface WorkerState {
  /** 本工单当前任务分配的启动重试计数。 */
  launchRetries: { assignmentId: string; tries: number }
  /** 本工单当前任务分配的回合重试计数。 */
  turnRetries: { assignmentId: string; tries: number }
  /** 正在等待瞬时失败退避计时器以恢复其工作单元回合的任务分配 ID。 */
  resuming?: string
  /**
   * 对进入空闲的工作单元后台工作的查看，该查看会占用其槽位；在工作单元重新运行
   * 或任务分配结束时结束。
   */
  settling?: AbortController
  /** 正在进行的后台工作停止操作；该工单的启动或投递会等待它。 */
  stopping?: Promise<void>
  /** 工作单元交接时留给人的作业及其结束的收集。 */
  left?: { jobs: Set<string>; collect: AbortController }
  /** 人直接输入工作单元会话的消息最近一次启动回合的时间。 */
  personalAt?: string
  /** 通过瞬态失败后继续的工作单元的计时器，`dispose` 会清除它们。 */
  readonly timers: Set<ReturnType<typeof setTimeout>>
}
/**
 * 拆分模块与门面之间的共享上下文：宿主、槽位、按工单聚合的状态，以及门面保留的
 * 报告、健康与来源触发器职责。模块只看到此接口，不反向依赖具体类。
 */
export interface WorkerContext {
  readonly host: ExecutorHost
  readonly slots: WorkerSlots
  /** 按工单聚合的易变状态；`state` 在首次写入时创建条目。 */
  readonly workers: Map<string, WorkerState>
  /** 取 `ticketId` 的状态，不存在时创建；仅写入路径使用。 */
  state(ticketId: string): WorkerState
  /** 工单的工作单元是否持有槽位：回合正在运行，或其后台工作仍在被查看。 */
  running(ticket: Ticket): boolean
  /** 运行后台工作单元事件处理，并在失败或恢复时更新 `worker` 健康条目。 */
  background(work: Promise<void>): Promise<void>
  /** 在一个事务中记录工单上的 `failed` 报告并把失败转发到主会话。 */
  failed(ticketId: string, summary: string): void
  /** 等待正在运行的工单后台工作停止，除非宿主先停止。 */
  stopped(ticketId: string): Promise<void>
  /** 格式化 `ticket` 上用于工作单元的触发器，包括工作单元尚未见过的被回复消息预览。 */
  triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined>
  /** 检查启动的瞬时重试次数并推进或清零；返回是否继续重试。 */
  retriesLaunch(ticketId: string, assignmentId: string, error: unknown): boolean
  /** 清零 `ticketId` 指定维度的重试计数；计数已属于其他任务分配时不动它。 */
  clearRetries(ticketId: string, kind: 'launch' | 'turn', assignmentId: string): void
  /** 检查回合的瞬时重试次数并推进或清零；返回是否继续重试。 */
  retriesTurn(ticketId: string, assignmentId: string, error: unknown): boolean
  /** 在 `ms` 毫秒后运行 `then`，除非先调用了 `dispose()`；计时器记在该工单的状态上。 */
  after(ticketId: string, ms: number, then: () => void): void
  /** 为任务分配排队一个 `launch` 效果；启动按队列顺序在工作单元槽位释放时开始。 */
  start(ticket: Ticket, assignment: Assignment): void
  /** 记录工单后台工作的一次停止操作；该工单的启动或投递会在其运行期间等待它。 */
  track(ticketId: string, stop: Promise<void>): void
  /** 在 Store 中查找工单的来源触发器。 */
  sourceTrigger(ticket: Ticket): Trigger | undefined
}
/**
 * 在每工单持久的 DSH 工作单元会话和隔离的工作区目录中执行工单任务分配。
 * 通过 Effects 排队启动和输入投递，用 WorkerSlots 管理并发，监听 Cordis 上下文上的 `agent/status`、
 * `agent/inbox/claimed`、`session/event` 和 `agent/error` 事件，并把状态变迁报告回引擎。
 * 启动、投递、停止/恢复与空闲收尾分别实现在 `launch.ts`、`delivery.ts`、`lifecycle.ts` 与 `idle.ts`。
 * Runtime、Engine、工作单元工具和管理路由使用此类来准备、启动、投递到、停止和恢复工单任务分配。
 */
export class DshExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  /** 按工单聚合的工作单元易变状态；替代此前七个按工单或按任务分配作键的零散集合。 */
  private readonly workers = new Map<string, WorkerState>()
  /** 传给拆分模块的共享上下文；在构造器中绑定门面职责。 */
  private readonly context: WorkerContext
  /** 注册 `launch` 和 `delivery` 效果处理器；处理暂停时两者都被搁置（并发上限为 0）。 */
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers, ticketId => projectOfTicket(host.store.tickets.get(ticketId)))
    this.context = {
      host, slots: this.slots, workers: this.workers,
      state: ticketId => this.state(ticketId),
      running: ticket => this.running(ticket),
      background: work => this.background(work),
      failed: (ticketId, summary) => this.failed(ticketId, summary),
      stopped: ticketId => this.stopped(ticketId),
      triggerCard: (ticket, triggerId, note) => this.triggerCard(ticket, triggerId, note),
      retriesLaunch: (ticketId, assignmentId, error) => this.retry(ticketId, 'launch', assignmentId, error),
      clearRetries: (ticketId, kind, assignmentId) => this.clearRetries(ticketId, kind, assignmentId),
      retriesTurn: (ticketId, assignmentId, error) => this.retry(ticketId, 'turn', assignmentId, error),
      after: (ticketId, ms, then) => this.after(ticketId, ms, then),
      start: (ticket, assignment) => this.start(ticket, assignment),
      track: (ticketId, stop) => this.track(ticketId, stop),
      sourceTrigger: ticket => sourceTrigger(this.host, ticket),
    }
    // 每次启动都预留一个工作单元槽位，使启动在槽位空闲时并发运行。
    host.effects.handle('launch', payload => launchQueued(this.context, payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // 失败的输入投递记录在工单本身上，而不通过 `delivery` 效果的健康条目报告（`quiet: true`）。
    host.effects.handle('delivery', payload => deliverQueued(this.context, payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** 取 `ticketId` 的工作单元状态，不存在时创建。 */
  private state(ticketId: string): WorkerState {
    let state = this.workers.get(ticketId)
    if (!state) {
      state = { launchRetries: { assignmentId: '', tries: 0 }, turnRetries: { assignmentId: '', tries: 0 }, timers: new Set() }
      this.workers.set(ticketId, state)
    }
    return state
  }
  /**
   * 检查 `error` 是否是该任务分配在 `kind` 维度仍有重试次数的瞬时失败，并更新该工单的重试计数：
   * 重试时递增尝试计数并返回 `true`；非瞬时或次数用尽时清零并返回 `false`。
   * 计数按任务分配保鲜：`assignmentId` 变化即从零开始，等价于旧实现按分配 ID 作键。
   */
  private retry(ticketId: string, kind: 'launch' | 'turn', assignmentId: string, error: unknown): boolean {
    const state = this.state(ticketId)
    const counter = kind === 'launch' ? state.launchRetries : state.turnRetries
    if (counter.assignmentId !== assignmentId) { counter.assignmentId = assignmentId; counter.tries = 0 }
    if (!transient(error) || counter.tries >= TRANSIENT_TRIES) { counter.tries = 0; return false }
    counter.tries += 1
    return true
  }
  /** 清零 `ticketId` 当前任务分配的重试计数；计数已属于其他任务分配时不动它。 */
  private clearRetries(ticketId: string, kind: 'launch' | 'turn', assignmentId: string): void {
    const state = this.workers.get(ticketId)
    const counter = kind === 'launch' ? state?.launchRetries : state?.turnRetries
    if (state && counter && counter.assignmentId === assignmentId) counter.tries = 0
  }
  /** 安排 `then` 在 `ms` 毫秒后运行；计时器记在该工单的状态上，`dispose` 逐一清除。 */
  private after(ticketId: string, ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.state(ticketId).timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.state(ticketId).timers.add(timer)
  }
  /** 填充新接受工单的 `execution` 属性（工单短名、项目名、项目下的工单子目录和任务分配文本）。 */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir,
      sourceTrigger(this.host, ticket)) }
  }
  /** 为已接受或已恢复的任务分配排队一个 `launch` 效果；启动按队列顺序在工作单元槽位释放时开始。 */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** 排队一个 `delivery` 效果，把待处理的输入注入到 `ticket` 正在运行的工作单元会话中。 */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** 格式化 `ticket` 上用于工作单元的触发器，包括工作单元尚未见过的被回复消息预览。 */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * 在结束的事务提交之后（因此回滚会让工作单元继续工作，同一事务排队的启动则在其后开始）：结束对其后台工作的查看，
   * 取消其回合（除非其最后一句话是无后续输入投递的 `ready` 或 `dropped` 报告），并停止其 shell 作业和子智能体，
   * 包括它留给人的作业。
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    lifecycleStop(this.context, ticket, assignment, reason)
  }
  /** 工单后台工作的一次停止；该工单的启动或投递会在其运行期间等待它。 */
  private track(ticketId: string, stop: Promise<void>): void {
    const previous = this.workers.get(ticketId)?.stopping
    const entry: Promise<void> = Promise.all([previous, stop.catch(() => {})]).then(() => {})
      .finally(() => { const state = this.workers.get(ticketId); if (state?.stopping === entry) state.stopping = undefined })
    this.state(ticketId).stopping = entry
    void this.background(stop)
  }
  /** 等待正在运行的工单后台工作停止，除非宿主先停止。 */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.workers.get(ticketId)?.stopping
    if (stopping) await until(stopping, this.host.lifetime)
  }
  /** 宿主停止时，在限定时间内停止每个工作单元的后台工作并取消运行中的回合。 */
  async shutdown(): Promise<void> { await shutdownWorkers(this.context) }
  /** 其工作单元持有槽位的未结束工单数量：回合正在运行，或回合结束后 shell 作业或子智能体仍在运行。 */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** 已占用的任务槽位（运行中与启动预留），项目调度据此控制出队。 */
  slotsInUse(): number { return this.slots.used() }
  /** 已有运行中或启动中任务的项目记录 ID，项目调度据此保证同项目串行。 */
  projectsInUse(): string[] { return this.slots.projectsInUse() }
  /** 工单的工作单元是否持有槽位：回合正在运行，或回合结束后其 shell 作业或子智能体仍在运行。 */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.status === 'running' || !!this.workers.get(ticket.id)?.settling
  }
  /** 在一个事务中记录工单上的 `failed` 报告并把失败转发到主会话。 */
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  /** 订阅工作单元会话的宿主 `agent/status`、`agent/inbox/claimed`、`session/event` 和 `agent/error` 事件。启动时调用一次。 */
  install(): void { this.disposers.push(...installWorkers(this.context, this.host.context)) }
  /** 取消订阅宿主 agent 事件，并清除所有待处理的瞬时重试计时器。 */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const state of this.workers.values()) for (const timer of state.timers) clearTimeout(timer)
    for (const state of this.workers.values()) state.timers.clear()
  }
  /** 宿主重启后，对未结束工单中的运行中和待处理任务分配进行对账。 */
  resume(): void { resumeWorkers(this.context) }
  /** 运行后台工作单元事件处理，并在失败或恢复时更新 `worker` 健康条目。 */
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
}
