/** 工单：从接受到结束的生命周期，以及其订阅和输入。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, latestReport, liveTicket, readUntil, runningAssignment, settled, threadKey, waitsForPerson } from './model.ts'
import type { Assignment, ChannelRef, Evaluation, Follow, Mandate, PolicyEffect, ThreadRef, Ticket, TicketEndBy, TicketInput, TicketOutcome,
  Trigger, TriggerDisposition } from './model.ts'
import type { AssessmentOutcome } from './ports.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { canRetry } from './stage.ts'

const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b)
/** 输入是否为人所未写的消息，例如 CI、机器人或主会话的备注。 */
export const automatic = (input: TicketInput | undefined): boolean => input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)
/**
 * 工单的工作单元是否在 `until`（其最新报告或回合结束）之前读取了某个触发器输入：其会话此前已把该消息纳入步骤。
 * 在记录读取之前投递的输入，若在 `until` 之前已到达工作单元，则视为已读。
 */
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean => input.readAt === undefined
  ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until
const STATUS_REQUEST = 'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.'

/**
 * 管理每个工单的生命周期：为接受决策创建工单及其授权、订阅和第一个任务分配，绑定并附加线程、添加输入，
 * 恢复、重试、重启和结束工单，并丢弃订阅。
 * 与 Replies 协调接受时携带的确认，与 Executor 协调启动、投递和停止任务分配。
 * Intake、Evals、Assignments 和 Engine 把工单与订阅的变更委托到这里。
 */
export class Tickets extends EnginePart {
  constructor(options: EngineOptions, private readonly replies: Replies) { super(options) }

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
    for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref)
    if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement)
    this.options.executor.start(this.require(id), assignment)
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
  }
  /**
   * 把未结束的工单订阅到 `thread`，并记录到 `ticket.follows` 中（由该工单打开时为 `own`）。
   * @throws 当工单未知或已结束时抛出 UserError。
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.subscribe(ticketId, thread)
    const ticket = this.require(ticketId)
    const followed = threadKey(thread)
    const follow = ticket.follows?.find(item => item.thread === followed)
    // 重新绑定一个线程会重新打开此前已关闭的线程；`own` 一旦设置便保持为 true。
    if (follow) { follow.own ||= own; delete follow.closed } else ticket.follows = [...ticket.follows ?? [], { thread: followed, own }]
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * 记录未结束工单所关注的某个线程已关闭，并结束每个已完成其所关注线程的工单（见 `followsDone`），
   * 除非其工作尚未完成（见 `unfinished`）；这类工作在其报告 ready 后结束工单。
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    const closed = threadKey(thread)
    for (const ticket of this.repo.tickets.open()) {
      const follow = ticket.follows?.find(item => item.thread === closed && !item.closed)
      if (!follow) continue
      follow.closed = { at, outcome }
      this.repo.tickets.save(ticket)
      const done = this.followsDone(ticket)
      if (!done || this.unfinished(ticket, at)) continue
      // 关闭后恢复并已完成的工作现在结束。
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at)
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at)
    }
  }
  /**
   * 关注线程的工单如何算完成：其打开的（`own`）线程都不再处于打开状态，或当它没有打开任何线程时，其关注的所有线程都已关闭。
   * 它以这些线程中最晚的关闭方式结束；尚未完成时为 undefined。
   */
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? []
    const own = follows.filter(item => item.own)
    const counted = own.length ? own : follows
    if (!counted.length || counted.some(item => !item.closed)) return undefined
    return counted.map(item => item.closed!).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  }
  /**
   * 工单可以接收时要附加到它的触发器。
   * @throws 当触发器或工单未知、某工单的工作单元仍决定该触发器、人停止了该工单，或已结束工单的授权不再能通过重新校验时抛出 UserError。
   */
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // 到达某工单的后续消息，只有在决定它的工作单元交还之后才会去往别处。
    this.leftToWorkers(trigger)
    const current = this.require(ticketId)
    if (current.ended?.by === 'human') throw new UserError('ticketStopped')
    if (!liveTicket(current) && !this.policy().revalidate(current.mandate)) throw new UserError('mandateRevoked')
    return trigger
  }
  /**
   * 把工单订阅到所附加触发器的线程，并把该触发器连同其说明作为输入加入。工单的工作单元随后决定它，
   * 就像决定在自己的线程上到达工单的消息一样；若工作单元并不把它当作本工单的内容，则作为新输入接收，
   * 这会像任何附加消息一样唤醒已结束的工单。
   */
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    for (const ref of trigger.threads) this.subscribe(ticketId, ref)
    // 人把它送去评估并由此路由到这里的动作已经结束，工单仅为上下文读取它的状态也同样结束。
    const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const { context, requeued, ...disposition } = current
    const followed = context?.filter(id => id !== ticketId)
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: [...new Set([...disposition.fanout, ticketId])],
      ...followed?.length ? { context: followed } : {} })
    const ticket = this.require(ticketId)
    const id = key('input', ticketId, 'trigger', trigger.id)
    const existing = ticket.inputs.find(input => input.id === id)
    const at = this.now()
    const input = (inputId: string): TicketInput => ({ id: inputId, kind: 'trigger', triggerId: trigger.id, at, ...(note ? { note } : {}),
      ...trigger.human ? { human: true } : {} })
    if (existing?.kind !== 'trigger') this.addInput(ticket, input(id))
    else if (note && ticket.undelivered.includes(id)) { existing.note = note; ticket.updatedAt = at; this.repo.tickets.save(ticket) }
    // 人把它送去评估，或工单在工作单元承接前放手、仅为上下文读取，或在工作单元持有后结束，因此工作单元会再次收到它。
    else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) {
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)))
    }
    // 工作单元已经持有该消息，因此说明会再随它发送一次。
    else if (note) this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)))
  }
  /**
   * 向最新报告为 `waiting` 的运行中工作单元索取状态报告；其他工单不受影响。
   * @returns 是否已排队该状态请求输入。
   * @throws 当工单未知时抛出 UserError。
   */
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false
    this.addInput(ticket, { id: `status:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: STATUS_REQUEST, at: this.now() })
    return true
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
    this.requeueUntaken(ticket, latest)
    const assignment = this.newAssignment(ticket)
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.options.executor.stop(ticket, latest, 'retried')
    this.options.executor.start(ticket, assignment)
    return ticket
  }
  /**
   * 丢弃工单对其工作单元认为无关的线程的订阅，并把该线程上由工单决定的人的消息连同 `reason` 交还。
   * @throws 当工单未知，或 `thread` 是起始线程、已绑定的 `follows` 线程，或未被订阅时抛出 UserError。
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId)
    if (this.source(ticket)?.threads.some(ref => threadKey(ref) === thread)) throw new UserError('sourceThread')
    if (ticket.follows?.some(item => item.thread === thread)) throw new UserError('followedThread')
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError('notFollowing')
    this.dropSubscriptions(thread, 'executor', ticketId, reason)
    // 其工作单元发现该线程不属于本工单：于是把它所决定的该线程上的人的消息连同原因一起交还。
    for (const trigger of this.triggersOf(ticket)) {
      if (trigger.threads.some(ref => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason)
    }
  }
  /**
   * 按策略变化对每个未结束工单的影响逐一告知，按从旧到新的顺序，使其投递按接受顺序排队；其他工单不受影响。
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now()
    // 按从旧到新的顺序遍历工单，使投递按接受顺序排队。
    for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id)
      // 在输入键中包含 `at`，使相同策略版本之间反复切换时仍会记录为一条新输入。
      if (effect) this.addInput(ticket, { id: key('input', ticket.id, 'policy', from, to, at), kind: 'policy-changed', from, to, at, effect })
    }
  }
  /**
   * 丢弃某个线程的订阅（所有工单的，或仅 `ticketId` 的），并发出通知；没有丢弃时为 false。
   * 关注该线程的工单不再关注它，因此其关闭不再结束该工单。每个工单仍会决定它从该线程收到的消息。
   */
  dropSubscriptions(thread: string, by: 'person' | 'executor', ticketId?: string, reason?: string): boolean {
    const current = this.repo.threads.get(thread)
    const tickets = current?.subscriptions.filter(id => ticketId === undefined || id === ticketId) ?? []
    if (!current || !tickets.length) return false
    current.subscriptions = current.subscriptions.filter(id => !tickets.includes(id))
    this.repo.threads.save(current)
    for (const id of tickets) {
      const ticket = this.repo.tickets.get(id)
      if (!ticket?.follows?.some(item => item.thread === thread)) continue
      const { follows: before, ...rest } = ticket
      const follows = before.filter(item => item.thread !== thread)
      this.repo.tickets.save(follows.length ? { ...rest, follows } : rest)
    }
    for (const id of tickets) this.emit('thread.unsubscribed', { threadKey: current.key, ticketId: id, by, ...(reason ? { reason } : {}) })
    return true
  }
  /**
   * 幂等地加入一个输入，并请执行器投递它；若某个待处理任务分配的启动曾失败且当前没有在等人，
   * 则请执行器再次启动它：仅策略变化不会重新启动它。
   */
  addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some(existing => existing.id === input.id)) return
    ticket.inputs.push(input); ticket.updatedAt = this.now()
    // 工作单元在等人时暂扣自动输入。
    const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) this.options.executor.deliver(ticket, running)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.options.executor.start(ticket, latest)
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
    this.options.executor.start(ticket, assignment)
    this.emit('ticket.resumed', { ticketId, triggerId: first.triggerId })
  }
  /** 工单的触发器输入所对应的触发器，或其中输入 id 属于 `ids` 的那些。 */
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap(input => input.kind === 'trigger' && (!ids || ids.includes(input.id))
      ? this.repo.triggers.get(input.triggerId) ?? [] : [])
  }
  /**
   * 工单的工作单元是否已通过确认或回答承接了人的消息。在记录确认之前就被确认的消息，
   * 只能在发件箱中找到该确认对应的消息。
   */
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    return acked ? acked.includes(ticket.id) : this.options.outbox.status(key('ack', trigger.id)) !== undefined
  }
  /** 工单的输入 `ids` 中由它决定、且其工作单元尚未承接的人的消息。 */
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(trigger => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger))
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
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger)
    }
  }
  /** 无法恢复的已结束工单不接收任何等待它的消息（见 `letGo`）。 */
  private refuse(ticket: Ticket): void {
    const waiting = this.triggersOf(ticket, ticket.undelivered), left = this.untaken(ticket, ticket.undelivered)
    ticket.undelivered = []
    this.repo.tickets.save(ticket)
    this.letGo(ticket.id, waiting, left)
  }
  /** 用新的任务分配替换工单正在运行的任务分配，并使其先收到 `note`，然后排队启动。 */
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason)
    this.requeueUntaken(ticket, running)
    const assignment = this.newAssignment(ticket)
    const at = this.now()
    const input: TicketInput = { id: key('input', ticket.id, 'restart', assignment.id), kind: 'text', text: note, at }
    ticket.inputs.push(input); ticket.undelivered.push(input.id); ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
  }
  /**
   * 把已投递给 `replaced`、但没有被其工作单元任何步骤取走的触发器输入放回等待队列的最前面：
   * 取消可能丢弃了它们，或取走它们的步骤被中断，而新任务分配的启动会取出仍留在会话中的副本，
   * 因此只投递一次。更早的结束已放手先前任务分配遗留的内容。
   */
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(input => input.kind === 'trigger' && input.readAt === null && input.deliveredTo === replaced.id
      && !ticket.undelivered.includes(input.id))
    ticket.undelivered.unshift(...untaken.map(input => input.id))
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
    const waiting = this.triggersOf(ticket, ticket.undelivered)
    const left = this.untaken(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger'
      && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []))
    // 更早的结束时间（例如 PR 的合并）不会把工单的最后变更时间往回移。
    ticket.ended = { at, by, outcome, ...why }; ticket.undelivered = []; ticket.updatedAt = this.now()
    delete ticket.attention; delete ticket.delivery
    // 结束所停止的任务分配随之结束；工单的结束记录说明了原因。
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at }
    this.repo.tickets.save(ticket)
    this.letGo(ticketId, waiting, left)
    this.emit('ticket.ended', { ticketId, by, outcome, ...why })
    for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome)
  }
  /**
   * 工单在 `at` 时刻的关闭发生时其工作是否尚未完成：其工作单元承接了某条由工单决定的人的消息，
   * 且自其会话把该消息纳入步骤以来除进度外没有报告或回合结束；或关闭后恢复的工作（其任务分配在关闭之后启动）
   * 没有 ready 报告，或在该报告之后有输入到达；仅策略变化不要求任何工作。
   */
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false)
    const taken = this.triggersOf(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []))
      .some(trigger => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger))
    const latest = latestAssignment(ticket)
    if (taken || !(Date.parse(latest?.createdAt ?? '') > Date.parse(at))) return taken
    const report = latest?.report
    const later = ticket.inputs.some(input => input.kind !== 'policy-changed' && Date.parse(input.at) > Date.parse(report?.at ?? ''))
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later
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
  /**
   * 以备注输入的形式向未结束工单的执行器提供一条事实，例如另一个工单发现的内容；它不授予任何权限（见 `TicketInput`）。
   * @throws 当工单未知或已结束时抛出 UserError。
   */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at })
    return this.require(ticketId)
  }
  /**
   * 把未结束的工单订阅到其执行器认为相关的线程，用于上下文：见 `Thread.context`。
   * @returns 当工单已关注该线程时返回 false。
   * @throws 当工单未知或已结束时抛出 UserError。
   */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    if (this.thread(ref).subscriptions.includes(ticketId)) return false
    this.subscribe(ticketId, ref)
    const thread = this.thread(ref)
    thread.context = [...thread.context ?? [], ticketId]
    this.repo.threads.save(thread)
    return true
  }
  /** 把工单订阅到某个线程；此后该线程上的触发器会作为输入到达工单，若此前仅为上下文，则变成工单自己的线程。 */
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) { thread.subscriptions.push(ticketId); this.emit('thread.subscribed', { threadKey: thread.key, ticketId }) }
    if (thread.context?.includes(ticketId)) thread.context = thread.context.filter(id => id !== ticketId)
    this.repo.threads.save(thread)
  }
}
