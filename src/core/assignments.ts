/** 执行器及其工作单元汇报的、关于运行工单的任务分配信息。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, runningAssignment } from './model.ts'
import type { ReportState, Ticket } from './model.ts'
import { automatic } from './inputs.ts'
import { EnginePart, type EngineOptions, type Requeues } from './part.ts'
import type { Follows } from './follows.ts'
import type { Replies } from './replies.ts'
import type { Tickets } from './tickets.ts'

/** 任务分配所汇报的内容：工作单元的报告，或执行器自身的报告（空闲回合后为 `waiting`，出错后为 `failed`）。 */
export interface WorkerReport {
  state: ReportState
  summary: string
  /** 向人提出的待回答问题：字符串表示提问，`null` 表示清除已有提问，`undefined` 表示保留当前提问。 */
  question?: string | null
  /** 提出该请求并引发此提问的人的消息；用于把提问路由到该消息所在的渠道。 */
  askedBy?: string
  /** 本报告所回答的人的问题，工作单元由此承接该问题；它授权主会话发送回答。 */
  answers?: string
}
const RECOVERY_NOTE = 'The host restarted during this ticket. Inspect the current worktree, git history and GitHub state before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.'

/**
 * Assignments 记录执行器及其工作单元关于运行工单的任务分配所汇报的内容：任务分配启动、输入送达或送达失败、
 * 其工作单元的会话把输入纳入某个步骤、其工作单元的一个回合结束、主机重启导致其中断，以及工作单元的报告及其对人的提问。
 * 它依赖 Tickets 重启或结束工单，依赖 Replies 撤回被报告替换的提问；Engine 把执行器的生命周期回调及其工作单元的报告路由到这里。
 */
export class Assignments extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly replies: Replies,
    private readonly follows: Follows, private readonly requeues: Requeues) { super(options) }

  /** 将未结束的任务分配标记为运行中，在未结束的工单上排队投递等待中的未投递输入，并发出 `assignment.started`。 */
  started(ticketId: string, assignmentId: string): void {
    const ticket = this.require(ticketId)
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment || assignment.state === 'ended') return
    assignment.state = 'running'; assignment.startedAt ??= this.now()
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    if (liveTicket(ticket) && ticket.undelivered.length) this.defer(() => this.options.executor.deliver(ticket, assignment))
    this.emit('assignment.started', { ticketId, assignmentId })
  }
  /**
   * 在工单当前运行的任务分配上把 `inputIds` 标记为已投递，并清除此前 `delivery` 的失败记录；若已不再运行则忽略。
   * 其工作单元会在会话把每个输入纳入步骤时读取它（见 `read`）。
   */
  delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.undelivered = ticket.undelivered.filter(id => !inputIds.includes(id)); ticket.updatedAt = this.now()
    runningAssignment(ticket)!.deliveredAt = ticket.updatedAt
    for (const input of ticket.inputs) {
      if (input.kind === 'trigger' && inputIds.includes(input.id)) { input.readAt ??= null; input.deliveredTo = assignmentId }
    }
    delete ticket.delivery
    this.repo.tickets.save(ticket)
  }
  /** 记录未结束工单的工作单元会话何时把 `inputIds` 纳入某个步骤，模型由此读取它们。 */
  read(ticketId: string, inputIds: string[]): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    for (const input of ticket.inputs) if (input.kind === 'trigger' && inputIds.includes(input.id)) input.readAt ||= this.now()
    this.repo.tickets.save(ticket)
  }
  turnEnded(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    runningAssignment(ticket)!.idleAt = this.now()
    this.repo.tickets.save(ticket)
  }
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.delivery = { error: error.slice(0, 300), at: this.now() }
    this.repo.tickets.save(ticket)
  }
  /**
   * 处理被主机重启中断的运行中任务分配：带恢复说明重启它；除非其最新报告为 `waiting`、`ready`、`blocked` 或 `failed`
   * 且该报告之后没有投递任何输入，此时保留其会话并冲刷所有等待中的未投递输入。
   */
  interrupted(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    const running = ticket && runningAssignment(ticket)
    if (!ticket || !running) return
    const report = running.report
    const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at
    const settled = !!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy
    if (!settled) this.tickets.restart(ticket, running, 'hostRestarted', RECOVERY_NOTE)
    else if (ticket.undelivered.length) this.defer(() => this.options.executor.deliver(ticket, running))
  }
  /**
   * 在未结束工单的当前任务分配上记录工作单元状态报告，更新 `attention`、`answers`、被暂扣的自动输入，
   * 并在 `dropped` 或 `ready` 且不再等待被关注的线程（`followsDone`）时结束工单。
   * @throws 当工单未知或已结束、任务分配已结束、提问与 ready 结果或回答同时出现，
   * 或提问/回答引用了非人类的或未到达的触发器时抛出 UserError。
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (report.question && (report.state === 'ready' || report.answers)) throw new UserError('questionWithResult')
    if (report.askedBy && !report.question) throw new UserError('askerWithoutQuestion')
    const person = (id: string, channel: boolean) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false)
    }
    if (report.askedBy && !person(report.askedBy, true)) throw new UserError('notAsker')
    if (report.answers && !person(report.answers, false)) throw new UserError('notAnswerable')
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) throw new UserError('unknownAssignment')
    if (assignment.state === 'ended') throw new UserError('assignmentEnded')
    const at = this.now()
    const previous = ticket.attention
    const ask = (question: string) => ({ id: key('attention', ticketId, question, at), question, ...(report.askedBy ? { triggerId: report.askedBy } : {}) })
    const asked = report.question && report.question !== previous?.question ? ask(report.question) : previous
    const attention = report.question === null || report.state === 'ready' ? undefined : asked
    if (attention) ticket.attention = attention
    else delete ticket.attention
    // 被替换或清除的 attention 提问会从发件箱中撤回针对上一个问题的待发送回答。
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id)
    assignment.report = { state: report.state, summary: report.summary, at }
    ticket.updatedAt = at
    if (report.answers && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers]
    if (report.answers) this.requeues.takeUp(ticketId, report.answers)
    if (report.state === 'blocked' || report.state === 'failed') ticket.undelivered = ticket.undelivered.filter(id => !automatic(ticket.inputs.find(input => input.id === id)))
    this.repo.tickets.save(ticket)
    // 关注线程的工单随这些线程一起结束：ready 报告只有在其 followsDone 成立时才以其结果结束工单。
    const ready = !ticket.follows?.length ? 'completed' : this.follows.followsDone(ticket)?.outcome
    // 工单延迟关闭后出现的 dropped 报告，按该关闭的结果结束工单，最终通知会说明。
    const outcome = report.state === 'dropped' ? this.follows.followsDone(ticket)?.outcome ?? 'dropped' : report.state === 'ready' ? ready : undefined
    if (outcome) this.tickets.end(ticketId, 'executor', outcome, at)
    return this.require(ticketId)
  }
  /** 工单处于未结束状态且由 `assignmentId` 运行时返回该工单。 */
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}
