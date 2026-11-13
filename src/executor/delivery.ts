/**
 * 工作单元投递：把工单上待处理的输入逐条注入正在运行的工作单元会话，并在每次投递前重读工单状态，
 * 以便工单结束或另一个任务分配接管时立即停止投递。
 * 从 `dsh.ts` 门面拆出；共享状态经由 `WorkerContext` 传入，本模块不持有任何可变状态。
 */
import { liveTicket, runningAssignment, type Assignment, type Ticket, type TicketInput } from '../core/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Later } from '../app/effects.ts'
import { capped, inputMessage, inputResource, workerSessionId } from './format.ts'
import type { WorkerContext } from './dsh.ts'

/** 工单消息中内联任务分配文本的字符上限；更长的文本通过其资源读取。 */
const ASSIGNMENT_CHARS = 1500
/** 当输入来自人时为 true（非上下文的真人触发器，或状态请求之类的直接文本输入）。 */
export const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'

/**
 * 逐个把排队的输入投递给正在运行的任务分配，并在每次投递前重新读取工单状态。
 * 唤醒空闲工作单元同样要预留一个普通槽位，人的消息与自动启动共用槽位并受项目串行限制。
 */
export async function deliverQueued(w: WorkerContext, ticketId: string): Promise<void> {
  // 工作单元后台工作的停止以取消收尾，这会丢弃在此期间投递的内容。
  await w.stopped(ticketId)
  const first = w.host.store.tickets.get(ticketId)
  const target = first && liveTicket(first) ? runningAssignment(first) : undefined
  if (!first || !target || !first.undelivered.length) return
  let woken = false
  try {
    for (;;) {
      const ticket = w.host.store.tickets.get(ticketId)
      const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
      const inputId = ticket?.undelivered[0]
      if (!ticket || !assignment || inputId === undefined) return
      // 唤醒空闲工作单元同样要预留一个普通槽位。
      const sessionId = workerSessionId(ticketId)
      if (!woken && !w.running(ticket)) {
        // 人的消息与自动启动共用槽位，也同样受项目串行限制。
        const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
        w.slots.reserve(ticketId, person ? 'person' : 'wake')
        woken = true
      }
      const input = ticket.inputs.find(item => item.id === inputId)
      try {
        // 若工作单元会话被外部删除，则重新创建它。
        if (!w.host.context.agents.get(sessionId as SessionId)) {
          await w.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', ticket.title, 'worker')
        }
        if (input) await deliverInput(w, ticket, assignment, input)
      } catch (error) {
        if (w.host.closing() || error instanceof Later) throw error
        const current = w.host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
        w.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
        throw error
      }
      w.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
    }
  } finally { if (woken) w.slots.free(ticketId) }
}

/** 把一条输入注入工作单元会话；交付前后都重新校验工单与任务分配仍然有效。 */
async function deliverInput(w: WorkerContext, ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
  // 在交付给会话之前重新检查，因为工单可能在等待 `sourceLink` 期间已结束。
  const live = () => {
    const current = w.host.store.tickets.get(ticket.id)
    if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
    // 期间开始的工作单元后台工作停止会以取消收尾，这会丢弃本轮输入。
    if (w.workers.get(ticket.id)?.stopping) throw new Later('The worker\'s background work is stopping')
  }
  live()
  const trigger = input.kind === 'trigger' ? await w.triggerCard(ticket, input.triggerId, input.note) : undefined
  const message = inputMessage(input, trigger)
  if (message === undefined) return
  const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
  await w.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', live)
}
