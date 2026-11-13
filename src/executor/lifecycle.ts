/**
 * 工作单元生命周期：结束事务后的停止收尾、宿主停机、重启对账，以及宿主工作单元事件的订阅。
 * 从 `dsh.ts` 门面拆出；共享状态经由 `WorkerContext` 传入，本模块不持有任何可变状态。
 */
import { latestAssignment, liveTicket, runningAssignment, waitsForPerson, type Assignment, type Ticket } from '../core/index.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { cancelled, stopBackground, until } from './background.ts'
import { ticketOfSession, workerSessionId } from './format.ts'
import { resumeAfter, workerIdle } from './idle.ts'
import type { WorkerContext } from './dsh.ts'

const now = (): string => new Date().toISOString()
/** 宿主停止时等待各工作单元后台工作停止的时长。 */
export const SHUTDOWN_STOP_MS = 10_000

/** 当 `agent` 是工作单元会话时返回其对应的存储工单，否则返回 undefined。 */
function ticketOf(w: WorkerContext, agent: Agent): Ticket | undefined {
  const ticketId = ticketOfSession(agent.id)
  return ticketId === undefined ? undefined : w.host.store.tickets.get(ticketId)
}

/**
 * 在结束的事务提交之后（因此回滚会让工作单元继续工作，同一事务排队的启动则在其后开始）：结束对其后台工作的查看，
 * 取消其回合（除非其最后一句话是无后续输入投递的 `ready` 或 `dropped` 报告），并停止其 shell 作业和子智能体，
 * 包括它留给人的作业。
 */
export function stop(w: WorkerContext, ticket: Ticket, assignment: Assignment, reason: string): void {
  w.clearRetries(ticket.id, 'turn', assignment.id); w.clearRetries(ticket.id, 'launch', assignment.id)
  const report = assignment.report
  const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
  const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
  const sessionId = workerSessionId(ticket.id)
  w.host.store.afterCommit(() => {
    w.workers.get(ticket.id)?.settling?.abort()
    if (!ownTurn) w.host.context.agents.get(sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
    // 其 shell 作业和子智能体随之停止，自行结束回合的工作单元也是如此。
    stopWork(w, ticket.id, reason)
    const state = w.workers.get(ticket.id)
    state?.left?.collect.abort(); if (state) { state.left = undefined; state.personalAt = undefined }
  })
}

/** 停止工单的工作单元在后台运行的内容（参见 `stopBackground`）。 */
export function stopWork(w: WorkerContext, ticketId: string, reason: string, keepInbox = false): void {
  w.track(ticketId, stopBackground(w.host.context, workerSessionId(ticketId), reason, keepInbox))
}

/**
 * 宿主停止时，在限定时间内：停止每个已加载工作单元的后台工作并保留其收件箱；然后结束对被终止的、留给人的作业的收集，
 * 并取消期间启动的工作单元回合，保留其收件箱。
 */
export async function shutdown(w: WorkerContext): Promise<void> {
  const agents = w.host.store.tickets.list().map(ticket => w.host.context.agents.get(workerSessionId(ticket.id) as SessionId))
    .filter((agent): agent is Agent => agent !== undefined)
  const stop = async () => {
    await Promise.allSettled(agents.map(agent => stopBackground(w.host.context, agent.id, 'dsh-superagent stopped', true)))
    for (const state of w.workers.values()) state.left?.collect.abort()
    const running = agents.filter(agent => agent.status !== 'idle')
    for (const agent of running) agent.cancel({ kind: 'user' }, { keepInbox: true })
    await Promise.allSettled(running.map(agent => agent.whenIdle()))
  }
  await until(stop(), undefined, SHUTDOWN_STOP_MS)
}

/**
 * 宿主重启后，对未结束工单中的运行中和待处理任务分配进行对账：通知引擎有运行中的任务分配被中断，
 * 并重新排队待处理的启动（早期版本可能把它们放在效果队列之外），
 * 而失败的启动（`waitsForPerson`）会等待人的消息或重试。
 */
export function resume(w: WorkerContext): void {
  // 按接受顺序（从旧到新）启动待处理的工单。
  for (const ticket of w.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) {
      // 本进程内的重启保留了 DSH 的会话、作业和子智能体在运行：它们先停止。收件箱会保留
      // 已交接但尚未被取走的输入。
      w.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
      stopWork(w, ticket.id, 'dsh-superagent restarted', true)
      w.host.engine.assignmentInterrupted(ticket.id, running.id)
    }
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) w.start(ticket, latest)
  }
}

/** 订阅工作单元会话的宿主 `agent/status`、`agent/inbox/claimed`、`session/event` 和 `agent/error` 事件；返回注销函数。 */
export function install(w: WorkerContext, ctx: Context): (() => void)[] {
  const disposers: (() => void)[] = []
  disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    // 开始的回合会结束对其工作单元后台工作的查看；该回合自己的空闲会重新查看。
    if (status === 'running') { w.workers.get(ticketOfSession(agent.id) ?? '')?.settling?.abort(); return }
    // 由停止工作单元子智能体唤醒并取消的回合不是该工作单元的回合。
    if (status !== 'idle' || cancelled.delete(agent) || w.host.closing()) return
    const ticket = ticketOf(w, agent)
    const assignment = ticket && runningAssignment(ticket)
    if (ticket && assignment && liveTicket(ticket)) void w.background(workerIdle(w, ticket, assignment, agent))
  }))
  // 人直接输入工作单元会话的消息，工单不会记录它。
  disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const ticketId = ticketOfSession(agent.id)
    if (ticketId !== undefined && message.source.kind === 'user') w.state(ticketId).personalAt = now()
  }))
  // dsh-superagent 消息所携带的输入，工作单元会在会话把该消息收入历史后读取：
  // 在此之前认领它的步骤可能被取消或失败，从而丢弃它。
  disposers.push(ctx.on('session/event', (session, event) => {
    const ticketId = ticketOfSession(session.id)
    if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent' || w.host.closing()) return
    const message = event.data
    void w.background(Promise.resolve().then(() => {
      const read = w.host.store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'trigger' && !input.readAt
        && w.host.sessions.promptedId(input.id) === message.id).map(input => input.id) ?? []
      if (read.length) w.host.engine.inputsRead(ticketId, read)
    }))
  }))
  disposers.push(ctx.on('agent/error', ({ agent, error }) => {
    const ticket = ticketOf(w, agent)
    const assignment = ticket && runningAssignment(ticket)
    if (!ticket || !assignment || !liveTicket(ticket) || w.host.closing()) return
    if (w.retriesTurn(ticket.id, assignment.id, error)) { resumeAfter(w, ticket.id, assignment.id, error); return }
    void w.background(Promise.resolve().then(() => { w.failed(ticket.id, String(error)) }))
  }))
  return disposers
}
