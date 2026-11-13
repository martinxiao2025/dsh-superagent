/** 工单关注的线程：绑定、关闭结算、上下文关注与订阅的丢弃。 */
import { UserError } from './errors.ts'
import { before, latestAssignment, liveTicket, readBefore, readUntil, threadKey } from './model.ts'
import type { Follow, ThreadRef, Ticket, Trigger } from './model.ts'
import { EnginePart, type EngineOptions, type Requeues } from './part.ts'
import type { Tickets } from './tickets.ts'
import type { Inputs } from './inputs.ts'

/**
 * 工单与其关注线程之间的关系：来源或执行器绑定线程、线程关闭结算关注的工作、执行器为上下文而关注，
 * 以及人或执行器丢弃订阅。与 `Tickets` 协作结束已完成关注工作的工单，与 `Inputs` 协作订阅与读取承接状态，
 * 与 `Requeues` 协作把交还的人的消息送回评估。
 * Engine 把工单与线程关系的变更委托到这里。
 */
export class Follows extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly inputs: Inputs, private readonly requeues: Requeues) {
    super(options)
  }

  /**
   * 把未结束的工单订阅到 `thread`，并记录到 `ticket.follows` 中（由该工单打开时为 `own`）。
   * @throws 当工单未知或已结束时抛出 UserError。
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.inputs.subscribe(ticketId, thread)
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
      const resumed = before(at, latestAssignment(ticket)?.createdAt ?? '')
      this.tickets.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at)
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
   * 工单在 `at` 时刻的关闭发生时其工作是否尚未完成：其工作单元承接了某条由工单决定的人的消息，
   * 且自其会话把该消息纳入步骤以来除进度外没有报告或回合结束；或关闭后恢复的工作（其任务分配在关闭之后启动）
   * 没有 ready 报告，或在该报告之后有输入到达；仅策略变化不要求任何工作。
   */
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false)
    const taken = this.inputs.triggersOf(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []))
      .some(trigger => this.owners(trigger).includes(ticket.id) && this.inputs.takenUp(ticket, trigger))
    const latest = latestAssignment(ticket)
    if (taken || !before(at, latest?.createdAt ?? '')) return taken
    const report = latest?.report
    const later = ticket.inputs.some(input => input.kind !== 'policy-changed' && before(report?.at ?? '', input.at))
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later
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
    for (const trigger of this.inputs.triggersOf(ticket)) {
      if (trigger.threads.some(ref => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.requeues.handBack(ticketId, trigger, reason)
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
   * 把未结束的工单订阅到其执行器认为相关的线程，用于上下文：见 `Thread.context`。
   * @returns 当工单已关注该线程时返回 false。
   * @throws 当工单未知或已结束时抛出 UserError。
   */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    if (this.thread(ref).subscriptions.includes(ticketId)) return false
    this.inputs.subscribe(ticketId, ref)
    const thread = this.thread(ref)
    thread.context = [...thread.context ?? [], ticketId]
    this.repo.threads.save(thread)
    return true
  }
}
