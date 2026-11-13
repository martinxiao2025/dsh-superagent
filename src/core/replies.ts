/** 引擎发往渠道的消息，每条都由允许它的规则决定。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { ChannelRef, Ticket, Trigger } from './model.ts'
import type { ReplyStatus } from './ports.ts'
import { EnginePart, type EngineOptions, type Requeues } from './part.ts'

/**
 * 发往某个渠道的消息，按用途区分：执行器对其正在处理的人的请求的确认、工作单元报告之后对人的问题的回答、
 * 处于 `ready`、`completed`、`merged` 或 `dropped` 的工单的结果，或工单当前向人提出的 `question`（`attention`）。
 * 省略 `ticketId` 时，使用 `triggerId` 到达的工单。
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
/** 已排队的消息：其 id、是否已发出，以及先前的请求是否已排入过它。 */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Replies 通过 Outbox 端口把引擎的消息写入渠道：确认、对人的问题的回答、工单的结果，以及其向人提出的问题，
 * 每条都只在其规则允许时发出，并使用确定性 id，避免重复发出（幂等）。Engine 把 `reply` 路由到这里；
 * Tickets 向它索取接受时携带的确认，Assignments 请它撤回被报告替换的提问。
 */
export class Replies extends EnginePart {
  constructor(options: EngineOptions, private readonly requeues: Requeues) { super(options) }
  /**
   * 为用途指定的渠道排队一条消息：确认或回答发到该人的消息所在处，attention 发到引发提问的消息所在处
   * （或工单起始会话），结果发到工单启动时所在的会话（`result` 仅对处于 `ready`、`completed`、`merged`
   * 或 `dropped` 的工单允许）。每条消息至多排队一次（幂等）。确认即使已在队列中，
   * 也会记录该工单的工作单元已承接该消息。
   * @throws 当工单或触发器未知，或该用途的规则拒绝它时抛出 UserError，例如工单尚未 ready、完成、合并或放弃时发送结果。
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  /**
   * 把接受时携带的确认排队到启动该工单的消息所在处，前提是它有渠道且由人写下。
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (trigger.channel && trigger.human) this.options.outbox.send({ id: key('ack', trigger.id), channel: trigger.channel, text, kind: 'acknowledgement', ticketId })
  }
  /** 从发件箱撤回工单向人提出的问题，除非它已经发出。 */
  withdrawAttention(attentionId: string): void { this.options.outbox.withdraw(key('attention-reply', attentionId)) }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // 仅作上下文的线程是只读的，不能接收确认。
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const id = key('ack', trigger.id)
    const existing = this.options.outbox.status(id)
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // 保留自动的或最先排队的确认。
    if (!existing) this.options.outbox.send({ id, channel: trigger.channel, text: request.text, kind: 'acknowledgement', ticketId: ticket.id })
    this.requeues.takeUp(ticket.id, trigger.id)
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // attention 回复必须与工单当前未解决的问题文本一致。
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const id = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const existing = this.options.outbox.status(id)
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined
    const channel = request.purpose === 'answer' ? trigger!.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : undefined)
    if (!channel) throw new UserError('noChannel')
    this.options.outbox.send({ id, channel, text: request.text, kind: 'reply', ...ticket ? { ticketId: ticket.id } : {} })
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    return { id, status: this.options.outbox.status(id) ?? 'pending', reused: existing !== undefined }
  }
  /** 工单启动时所在的会话：其来源触发器的渠道，否则其第一个渠道。 */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
