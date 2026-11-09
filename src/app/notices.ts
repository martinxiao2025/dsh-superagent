/** 格式化通过副作用队列投递给主会话的后台通知和引导转发。 */
import { randomUUID } from 'node:crypto'
import { followupOwners, key, liveTicket, type DomainEvent, type Ticket, type WorkerReport } from '../core/index.ts'
import { triggerMessage } from '../executor/dsh.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { repliedTo } from './links.ts'
import type { Store } from './store.ts'
import { ticketCard } from './cards.ts'

/**
 * 主会话的后台通知元组：`[name, value, summary]`，其中 `name` 是 `Effects` 中的合并键
 * （同名的新通知会覆盖尚未发送的等待通知，而不是永久去重未来的通知）。
 */
export type Notice = readonly [name: string, value: Record<string, unknown>, summary: string]
/** 为已保存的提示词配置修订构建通知，在 `'prompts'` 下合并。 */
export const promptsNotice = (revision: number): Notice =>
  ['prompts', { prompt_config_saved: revision, effect: 'next-request', read: `prompts/${revision}` }, `Prompt configuration saved (revision ${revision})`]
/**
 * 为已保存的设置块构建通知，包含发生变化的点分隔路径（按 `settings:<block>` 逐块合并）；
 * 对于未记录块的旧版保存，则为整个设置构建通知。
 */
export const settingsNotice = (block?: string, changed: string[] = []): Notice => block
  ? [`settings:${block}`, { settings_saved: block, changed, read: `settings/${block}` }, `Settings saved: ${block}`]
  : ['settings', { settings_saved: true, read: 'settings' }, 'Settings saved']
/** 返回最多 20 个两个值不同的点分隔路径（例如 `eval.mode` 或 `policy.rules.1.enabled`）。 */
export function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [path]
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const at = (value: object, name: string) => (value as Record<string, unknown>)[name]
  return keys.flatMap(name => changedPaths(at(before, name), at(after, name), path ? `${path}.${name}` : name)).slice(0, 20)
}
/** 当转发已携带或不需要摘要时，从工单卡片中去除最新报告预览。 */
function brief(ticket: Ticket) {
  const { preview: _preview, ...card } = ticketCard(ticket)
  return card
}
/** 创建带唯一 `name` 键的一次性回执通知，使同一事件的多次发生各自投递而不会合并。 */
export const receiptNotice = (value: Record<string, unknown>, summary: string): Notice => [key('receipt', randomUUID()), value, summary]
/** 构建通知，说明某人于 `at` 移除了线程的订阅；之后对同一线程的移除会替换尚未发送的等待通知。 */
export const subscriptionNotice = (thread: string, at?: string): Notice => [`subscription:${thread}`,
  { subscription_changes: [{ thread, removed: true }], ...at ? { at } : {} }, `Removed the subscriptions on thread ${thread}`]

/**
 * 将非请求的领域事件转换为主会话通知（`ticket.ended`、`trigger.requeued`，或由人或执行器触发的
 * `thread.unsubscribed`）；对于无需通知的事件返回 `undefined`。
 */
export function eventNotice(event: DomainEvent, ticket: (id: string) => Ticket | undefined = () => undefined): Notice | undefined {
  const { at } = event
  if (event.type === 'ticket.ended') {
    const { ticketId, by, outcome, reason = outcome } = event.data
    const ended = ticket(ticketId)
    return receiptNotice(ended ? { ticket_ended: brief(ended) } : { ticket_ended: ticketId, by, outcome, reason, at }, `Ticket ${ticketId} ended (${reason})`)
  }
  if (event.type === 'trigger.requeued') {
    const id = event.data.triggerId
    return receiptNotice({ trigger_requeued: id, read: `trigger/${id}`, at }, `Trigger ${id} queued for a fresh assessment`)
  }
  if (event.type === 'thread.unsubscribed' && event.data.by === 'person') return subscriptionNotice(event.data.threadKey, at)
  if (event.type === 'thread.unsubscribed') {
    const { ticketId, threadKey: thread, reason } = event.data
    const note = 'Its Executor found this thread unrelated after reading it; attach later triggers there to this ticket only when they '
      + 'point at it explicitly.'
    return receiptNotice({ thread_unrelated: { ticket_id: ticketId, thread, reason }, at, note },
      `Ticket ${ticketId} no longer follows thread ${thread}: ${reason}`)
  }
  return undefined
}

/** 当工单的执行器仅为上下文而订阅相关线程时，构建后台通知。 */
export const threadFollowedNotice = (ticketId: string, thread: string, reason: string): Notice =>
  receiptNotice({ thread_followed: { ticket_id: ticketId, thread, reason },
    note: 'For context only: its messages reach this ticket and grant nothing.' },
    `Ticket ${ticketId} follows thread ${thread} for context: ${reason}`)

/** 主会话的引导转发载荷：`id` 是保证投递幂等的请求 ID，`text` 是消息正文。 */
export interface Relay { id: string; text: string }
/** 后续消息对主会话的要求：除了人要求停止之外无需动作，因为它由工单的执行器决定。 */
const FOLLOWUP_NOTE = 'Its ticket\'s worker has it and decides; act only if the person asks to stop the work '
  + '(orchestrator_route kind stop with this trigger_id).'
/**
 * 为到达至少一个活跃工单（包括因后续消息而复活的已结束工单）的人类后续触发器构建引导转发，
 * 其中触发器按执行器读取的方式呈现，并包含所回复的消息及其到达的未结束工单；
 * 当没有工单的执行器决定它（见 `followupOwners`）或它未到达任何活跃工单时返回 `undefined`。
 */
export function followupNotice(store: Store, sources: SourceRegistry, triggerId: string): Relay | undefined {
  const trigger = store.triggers.get(triggerId)
  const disposition = store.triggers.disposition(triggerId)
  if (!trigger || !followupOwners(trigger, store).length) return undefined
  const tickets = disposition!.fanout.flatMap(id => {
    const ticket = store.tickets.get(id)
    const context = disposition!.context?.includes(id) ? { context: true } : {}
    return ticket && liveTicket(ticket) ? [{ ticket_id: id, title: ticket.title, state: ticketCard(ticket).state, ...context }] : []
  })
  if (!tickets.length) return undefined
  return followupRelay(triggerMessage(trigger, {}, undefined, repliedTo({ store, sources }, trigger)), tickets)
}
/**
 * 主会话收到的、某人发给工单的消息：消息按执行器读取的方式呈现，并附带其所到达工单及其状态。
 * 由这些执行器决定，主会话只能停止相关工作。
 */
export function followupRelay(message: { trigger_id: string },
  tickets: readonly { ticket_id: string; title: string; state: string; context?: boolean }[]): Relay {
  return { id: `followup:${message.trigger_id}`, text: JSON.stringify({ kind: 'follow_up', ...message, delivered_to: tickets,
    note: FOLLOWUP_NOTE }) }
}
/** 为主会话格式化执行器报告转发（超过 600 字符的摘要截断并放在 `ticket/<id>/result` 之后）；`replyTo` 指明它回答的人类问题触发器。 */
export function resultRelay(ticket: Ticket, state: string, text: string, replyTo?: string): Relay {
  const id = key('worker-result', ticket.id, ticket.updatedAt, text)
  const summary = text.length > 600 ? { summary: text.slice(0, 600), chars: text.length } : { summary: text }
  const report = { kind: 'worker_report', ticket: brief(ticket), trigger_id: ticket.origin.triggerId, state, ...replyTo ? { answer_to: replyTo } : {},
    ...summary, read: `ticket/${ticket.id}/result` }
  return { id: `report:${id}`, text: JSON.stringify(report) }
}
/**
 * 将记录在 `ticket` 上的执行器报告转换为主会话转发：面向人的问题产生 `worker_attention` 转发，
 * 而结果、阻塞、结束或对问题的回答产生 `worker_report` 转发，常规且不带 `answers` 的 `progress` 报告则保留在内部。
 * @returns 引导 `Relay`；当报告不转发到主会话时返回 `undefined`。
 */
export function reportRelay(ticket: Ticket, report: Pick<WorkerReport, 'state' | 'summary' | 'question' | 'answers'>): Relay | undefined {
  const asked = report.question ? ticket.attention : undefined
  if (asked) {
    return { id: `attention:${ticket.id}:${asked.id}`,
      text: JSON.stringify({ kind: 'worker_attention', ticket: brief(ticket), state: report.state, read: `ticket/${ticket.id}/result` }) }
  }
  if (report.state === 'progress' && !report.answers) return undefined
  return resultRelay(ticket, report.state, report.summary, report.answers)
}
