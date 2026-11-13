/** 工单输入：订阅使后续消息成为输入，输入的加入、暂扣、附加与承接状态。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, runningAssignment, waitsForPerson } from './model.ts'
import type { Assignment, PolicyEffect, ThreadRef, Ticket, TicketInput, Trigger, TriggerDisposition } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'

/** 输入是否为人所未写的消息，例如 CI、机器人或主会话的备注。 */
export const automatic = (input: TicketInput | undefined): boolean => input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)
const STATUS_REQUEST = 'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.'

/**
 * 工单的输入面：把工单订阅到线程（此后该线程上的触发器作为输入到达），幂等地加入输入并暂扣等待人的自动输入，
 * 把触发器附加为输入，以及读取工作单元对人的消息的承接状态。
 * Intake、Engine 与策略变化把输入的变更委托到这里；工单生命周期经由它读取哪些消息尚未被承接。
 */
export class Inputs extends EnginePart {
  /** 把工单订阅到某个线程；此后该线程上的触发器会作为输入到达工单，若此前仅为上下文，则变成工单自己的线程。 */
  subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) { thread.subscriptions.push(ticketId); this.emit('thread.subscribed', { threadKey: thread.key, ticketId }) }
    if (thread.context?.includes(ticketId)) thread.context = thread.context.filter(id => id !== ticketId)
    this.repo.threads.save(thread)
  }
  /**
   * 幂等地加入一个输入，并请执行器投递它；若某个待处理任务分配的启动曾失败且当前没有在等人，
   * 则请执行器再次启动它：仅策略变化不会重新启动它。
   */
  addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some(existing => existing.id === input.id)) return
    ticket.inputs.push(input); ticket.updatedAt = this.now()
    // 工作单元在等人时暂扣自动输入。
    const held = this.hold(ticket, input)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) this.defer(() => this.options.executor.deliver(ticket, running))
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.defer(() => this.options.executor.start(ticket, latest))
  }
  /** 工作单元在等人时暂扣自动输入：它保持未投递状态，直到人的消息到达解除等待。 */
  private hold(ticket: Ticket, input: TicketInput): boolean {
    return liveTicket(ticket) && automatic(input) && waitsForPerson(ticket)
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
  /** 工单的触发器输入所对应的触发器，或其中输入 id 属于 `ids` 的那些。 */
  triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap(input => input.kind === 'trigger' && (!ids || ids.includes(input.id))
      ? this.repo.triggers.get(input.triggerId) ?? [] : [])
  }
  /**
   * 工单的工作单元是否已通过确认或回答承接了人的消息。在记录确认之前就被确认的消息，
   * 只能在发件箱中找到该确认对应的消息。
   */
  takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    return acked ? acked.includes(ticket.id) : this.options.outbox.status(key('ack', trigger.id)) !== undefined
  }
  /** 工单的输入 `ids` 中由它决定、且其工作单元尚未承接的人的消息。 */
  untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(trigger => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger))
  }
  /**
   * 把已投递给 `replaced`、但没有被其工作单元任何步骤取走的触发器输入放回等待队列的最前面：
   * 取消可能丢弃了它们，或取走它们的步骤被中断，而新任务分配的启动会取出仍留在会话中的副本，
   * 因此只投递一次。更早的结束已放手先前任务分配遗留的内容。
   */
  requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(input => input.kind === 'trigger' && input.readAt === null && input.deliveredTo === replaced.id
      && !ticket.undelivered.includes(input.id))
    ticket.undelivered.unshift(...untaken.map(input => input.id))
  }
}
