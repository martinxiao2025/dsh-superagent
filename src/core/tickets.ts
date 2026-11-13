/** 工单：从接受到结束的生命周期，及其任务分配与放手的消息。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, readBefore, readUntil, settled } from './model.ts'
import type { Assignment, ChannelRef, Evaluation, Mandate, Ticket, TicketEndBy, TicketInput, TicketOutcome, Trigger } from './model.ts'
import type { AssessmentOutcome } from './ports.ts'
import { EnginePart, type EngineOptions, type Requeues } from './part.ts'
import type { Replies } from './replies.ts'
import { canRetry } from './stage.ts'
import type { Inputs } from './inputs.ts'

const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * 管理每个工单的生命周期：为接受决策创建工单及其授权、订阅和第一个任务分配，恢复、重试、重启和结束工单，
 * 结束时放手其工作单元无从承接的消息（见 `letGo`）。
 * 与 Replies 协调接受时携带的确认，与 Executor 协调启动、投递和停止任务分配，
 * 与 Inputs 协作订阅与输入，与 `Requeues` 协作放手消息的重新排队。
 * Intake、Evals 和 Assignments 把工单的变更委托到这里；线程关注与输入由 `Follows` 与 `Inputs` 管理。
 */
export class Tickets extends EnginePart {
  constructor(options: EngineOptions, private readonly replies: Replies, private readonly inputs: Inputs, private readonly requeues: Requeues) {
    super(options)
  }

  /**
   * 创建接受决策所决定的工单，受 `mandate` 约束，并带上评估中各触发器的渠道与线程、其第一个任务分配以及接受时携带的确认，
   * 然后排队启动它。其来源是赋予该评估强度的可准入触发器；对于 `primary` 存在之前记录的评估，则使用该评估的最后一个触发器。
   */
  create(id: string, decisionId: string, mandate: Mandate, evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, at: string): void {
    const { triggerIds } = evaluation
    // 对于 `primary` 存在之前记录的评估，回退到最后一个触发器。
    const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!)
    const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds }
    let ticket: Ticket = { id, title: outcome.title, decisionId, mandate, channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: at, updatedAt: at, origin }
    for (const triggerId of triggerIds) {
      const channel = this.repo.triggers.get(triggerId)?.channel
      if (channel && !ticket.channels.some(item => sameChannel(item, channel))) ticket.channels.push(channel)
    }
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    const assignment = this.newAssignment(ticket)
    this.repo.tickets.save(ticket)
    for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.inputs.subscribe(id, ref)
    if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement)
    this.defer(() => this.options.executor.start(this.require(id), assignment))
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
  }
  /**
   * 代表某人停止工单，并结束所有进行中的任务分配。
   * @throws 当工单未知时抛出 UserError。
   */
  stop(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'human', 'stopped', this.now(), reason)
    return this.require(ticketId)
  }
  /**
   * 结束可重试的未结束工单（`failed`、`blocked` 或输入投递失败）所停滞的任务分配，并启动一个新的。
   * @throws 当工单未知或不可重试时抛出 UserError。
   */
  retry(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    const latest = latestAssignment(ticket)
    if (!canRetry(ticket) || !latest) throw new UserError('notRetryable')
    this.endAssignment(ticket, latest, 'retried')
    this.inputs.requeueUntaken(ticket, latest)
    const assignment = this.newAssignment(ticket)
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.defer(() => this.options.executor.stop(ticket, latest, 'retried'))
    this.defer(() => this.options.executor.start(ticket, assignment))
    return ticket
  }
  /**
   * 当某个已结束工单的线程上有一条人的消息在等待它时，在授权不变的前提下恢复该工单：没有评估也没有决策，
   * 因为没有授权新的内容。其授权已不被当前策略持有的工单保持结束状态，不接收任何内容（见 `refuse`）。
   * 处理暂停期间该消息继续等待，暂停后的第一轮处理会按当时的策略恢复工单。每次都会重新读取工单，
   * 因此该操作是幂等的，且不会影响已恢复的工单。
   */
  wake(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || liveTicket(ticket) || ticket.ended?.by === 'human' || !ticket.undelivered.length) return
    const policy = this.policy()
    if (policy.paused) return
    if (!policy.revalidate(ticket.mandate)) { this.refuse(ticket); return }
    // 只有人的消息能恢复已结束的工单；机器人/CI 触发器与工单结束前的输入一起等待。
    const first = ticket.undelivered.map(id => ticket.inputs.find(input => input.id === id)).find(input => input?.kind === 'trigger' && input.human)
    if (first?.kind !== 'trigger') return
    const at = this.now()
    delete ticket.ended; ticket.updatedAt = at
    const assignment = this.newAssignment(ticket)
    // 把恢复标记放在最前面，使其先于等待中的消息投递。
    const resumed: TicketInput = { id: key('input', ticket.id, 'resumed', first.triggerId), kind: 'resumed', triggerId: first.triggerId, at }
    ticket.inputs.push(resumed); ticket.undelivered.unshift(resumed.id)
    this.repo.tickets.save(ticket)
    this.defer(() => this.options.executor.start(ticket, assignment))
    this.emit('ticket.resumed', { ticketId, triggerId: first.triggerId })
  }
  /** 用新的任务分配替换工单正在运行的任务分配，并使其先收到 `note`，然后排队启动。 */
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason)
    this.inputs.requeueUntaken(ticket, running)
    const assignment = this.newAssignment(ticket)
    const at = this.now()
    const input: TicketInput = { id: key('input', ticket.id, 'restart', assignment.id), kind: 'text', text: note, at }
    ticket.inputs.push(input); ticket.undelivered.push(input.id); ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.defer(() => this.options.executor.start(ticket, assignment))
  }
  /**
   * 以指定结果结束工单。`at` 记录导致结束的事实发生的时间，例如 PR 合并；`reason` 用文字说明原因，
   * 默认为结果本身。工单会放手（见 `letGo`）其工作单元从未收到的消息，以及它决定但工作单元在其最新报告或
   * 回合结束（含结束该工单的报告）之前未读取、且既未确认、未回答也未交还的人的消息（见 `readBefore`）：
   * 其中某条可能是在工作单元撰写结束报告期间或在其回合结束后到达的，而无论哪种情况它都无法再交还。
   */
  end(ticketId: string, by: TicketEndBy, outcome: TicketOutcome, at = this.now(), reason?: string): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    const stopping = ticket.assignments.filter(assignment => assignment.state !== 'ended')
    const why = reason && reason !== outcome ? { reason } : {}
    const until = readUntil(ticket)
    const waiting = this.inputs.triggersOf(ticket, ticket.undelivered)
    const left = this.inputs.untaken(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger'
      && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []))
    // 更早的结束时间（例如 PR 的合并）不会把工单的最后变更时间往回移。
    ticket.ended = { at, by, outcome, ...why }; ticket.undelivered = []; ticket.updatedAt = this.now()
    delete ticket.attention; delete ticket.delivery
    // 结束所停止的任务分配随之结束；工单的结束记录说明了原因。
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at }
    this.repo.tickets.save(ticket)
    this.letGo(ticketId, waiting, left)
    this.emit('ticket.ended', { ticketId, by, outcome, ...why })
    for (const assignment of stopping) this.defer(() => this.options.executor.stop(ticket, assignment, reason ?? outcome))
  }
  /**
   * 已结束或无法恢复的工单放手其工作单元从未收到的消息 `waiting`，以及它决定但可能尚未承接的人的消息 `left`：
   * 它不再算作到达过这些消息；`left` 中不再由其他工单决定的，会像到达任何工单的人的消息一样进入评估，
   * 除非有工单已承接它、某个决策已解决它，或它就是某次停止用来结束本工单的那条消息。
   */
  private letGo(ticketId: string, waiting: readonly Trigger[], left: readonly Trigger[]): void {
    for (const trigger of [...waiting, ...left]) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      if (disposition?.fanout.includes(ticketId)) {
        this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: disposition.fanout.filter(id => id !== ticketId) })
      }
    }
    for (const trigger of left) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      const decision = disposition?.decisionId ? this.repo.decisions.get(disposition.decisionId) : undefined
      // 停止本工单的主会话会亲自决定该消息的其余部分，除非有工单将其交还。
      const stopped = decision?.kind === 'stop' && decision.ticketId === ticketId && !disposition?.handbacks?.length
      const decided = !!decision && (settled(decision) || stopped)
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.requeues.queueForEval(trigger)
    }
  }
  /** 无法恢复的已结束工单不接收任何等待它的消息（见 `letGo`）。 */
  private refuse(ticket: Ticket): void {
    const waiting = this.inputs.triggersOf(ticket, ticket.undelivered), left = this.inputs.untaken(ticket, ticket.undelivered)
    ticket.undelivered = []
    this.repo.tickets.save(ticket)
    this.letGo(ticket.id, waiting, left)
  }
  /** 加入一个待处理的任务分配；此前向它前一个任务分配的投递失败不再与该工单有关。 */
  private newAssignment(ticket: Ticket): Assignment {
    const assignment: Assignment = { id: key('assignment', ticket.id, String(ticket.assignments.length)), state: 'pending', createdAt: this.now() }
    ticket.assignments.push(assignment)
    delete ticket.delivery
    return assignment
  }
  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
    assignment.state = 'ended'; assignment.endedAt = this.now(); assignment.endedReason = reason
    this.emit('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
}
