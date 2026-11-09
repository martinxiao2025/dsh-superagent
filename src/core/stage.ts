/** 工单阶段分类与重试资格（docs/003）。 */
import { latestAssignment, waitsForPerson, type Ticket } from './model.ts'

/** 工单的总体执行阶段：等待人、正在工作或排队、回合之间空闲，或已结束。 */
export type TicketStage = { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' } | { stage: 'idle' } | { stage: 'ended' }

/** 对工单阶段进行分类；规则按顺序遵循 docs/003 中的表格，最先匹配的行生效。 */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  if (report === 'ready') return { stage: 'person', action: 'review' }
  // blocked 或 failed 报告之后的人的后续消息会把工单交回执行器。
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) return { stage: 'person', action: report }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' }
  return { stage: 'working' }
}

/** 当未结束的工单因 blocked/failed 报告停滞且没有更新的后续人类消息，或输入投递失败时为 true。 */
export function canRetry(ticket: Ticket): boolean {
  return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery)
}
