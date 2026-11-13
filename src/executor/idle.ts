/**
 * 工作单元空闲与瞬时失败重试：空闲收尾判定、交接给人的作业收集，以及瞬时网络/提供方错误的退避重试。
 * 从 `dsh.ts` 门面拆出；共享状态经由 `WorkerContext` 传入，本模块不持有任何可变状态。
 */
import { latestReport, liveTicket, runningAssignment, waitsForPerson, type Assignment, type Ticket } from '../core/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resultRelay } from '../app/notices.ts'
import { Later } from '../app/effects.ts'
import { collectJob, killJobs, runningJobs, stopSubagents, untilQuiet } from './background.ts'
import { workerSessionId } from './format.ts'
import type { WorkerContext } from './dsh.ts'

/** 启动或工作单元回合的最大瞬时重试次数，以及恢复回合前的初始退避时长。 */
export const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** 工作单元回合结束后其后台工作还能继续运行多久，超过后就停止并报告工作单元等待中。 */
export const BACKGROUND_LIMIT_MS = 30 * 60_000
/** 通过瞬态失败后继续的工作单元在两次查看之间等待工作单元槽位或等待处理恢复的时长。 */
export const SLOT_WAIT_MS = 5000

/** 瞬时失败的分类表：HTTP 状态优先（408、429 与全部 5xx），其余按网络层与限流文案兜底。 */
const TRANSIENT_STATUS = new Set([408, 429])
const TRANSIENT_MIN_STATUS = 500
const TRANSIENT_TEXT = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b']
const PASSING = new RegExp(TRANSIENT_TEXT.join('|'), 'i')

/**
 * 当错误表示瞬时的网络或模型提供方失败时为 true：HTTP 408、429 或 5xx 状态，
 * 或被拒绝、重置、超时、无法解析主机的连接。
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return TRANSIENT_STATUS.has(status) || status >= TRANSIENT_MIN_STATUS
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}

/** 在瞬时提供方或网络错误之后，以指数退避安排一次工作单元回合重试。 */
export function resumeAfter(w: WorkerContext, ticketId: string, assignmentId: string, error: unknown): void {
  const state = w.state(ticketId)
  const tries = state.turnRetries.tries
  const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
  state.resuming = assignmentId
  const go = (): void => {
    if (w.host.closing()) return
    const ticket = w.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) {
      if (w.workers.get(ticketId)?.resuming === assignmentId) w.workers.get(ticketId)!.resuming = undefined
      return
    }
    // 在处理暂停或没有空闲唤醒槽位时等待。
    if (w.host.paused()) { w.after(ticketId, SLOT_WAIT_MS, go); return }
    const sessionId = workerSessionId(ticketId)
    const waking = !w.running(ticket)
    try { if (waking) w.slots.reserve(ticketId, 'wake') } catch (failure) {
      if (!(failure instanceof Later)) throw failure
      w.after(ticketId, SLOT_WAIT_MS, go); return
    }
    const sent = w.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, 'queue')
    void w.background(sent.finally(() => {
      if (waking) w.slots.free(ticketId)
      const state = w.workers.get(ticketId)
      if (state?.resuming === assignmentId) state.resuming = undefined
    })
      .catch(failure => { w.failed(ticketId, String(failure)) }))
  }
  w.after(ticketId, TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
}

/**
 * 交接给人的工作单元会释放其槽位：其子智能体停止，其 shell 作业（例如为这个人运行的服务）留给人直到任务分配结束。
 * 它们不占槽位，也不受任何时限约束；它们的结束会被收集，因此不会在槽位之外唤醒工作单元，
 * 而工作单元会在下一个回合读取每一个的结束。
 */
export function handOff(w: WorkerContext, ticketId: string, agent: Agent): void {
  w.track(ticketId, stopSubagents(w.host.context, agent, true))
  const state = w.state(ticketId)
  const left = state.left ?? { jobs: new Set<string>(), collect: new AbortController() }
  state.left = left
  for (const job of runningJobs(w.host.context, agent.id, left.jobs)) {
    left.jobs.add(job.id)
    void w.background(collectJob(w.host.context, agent.id, job, left.collect.signal).then(async ended => {
      if (!ended) return
      const note = `Your background job ${ended.name} ended: ${ended.status}.`
      await w.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' })
    }))
  }
}

/** 工作单元回合结束后的收尾：交接判定、后台工作的静默等待与超时终止，以及等待中报告的组装。 */
export async function workerIdle(w: WorkerContext, ticket: Ticket, idle: Assignment, agent: Agent): Promise<void> {
  const state = w.workers.get(ticket.id)
  await agent.whenIdle()
  // 因瞬时原因失败的回合会在退避后继续，这不算回合结束。
  if (state?.resuming === idle.id || agent.status !== 'idle') return
  // 正常结束的回合会重新开始统计瞬时失败次数。
  if (state && state.turnRetries.assignmentId === idle.id) state.turnRetries.tries = 0
  // 在进入空闲的任务分配仍在运行该工单期间的工单。
  const live = () => {
    const stored = w.host.store.tickets.get(ticket.id)
    return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
  }
  // 最后一句话是结果、给人的问题，或 blocked/failed 报告的工作单元已交接给人；
  // 在其结果或问题之后投递的输入属于新工作。
  const handedOff = (stored: Ticket) => {
    const assignment = runningAssignment(stored), report = assignment?.report
    const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
    return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
  }
  const before = live()
  if (!before || w.host.closing()) return
  // 人在会话中启动的回合属于这个人的工作，它会像任何回合一样在后台继续。
  const report = runningAssignment(before)?.report, person = state?.personalAt
  // 工作单元读取了在已结束回合之前到达的内容：它交接时所在的回合，或后台工作已结束的回合。
  if (handedOff(before) && !(report && person && person > report.at)) {
    w.host.engine.turnEnded(ticket.id, idle.id)
    handOff(w, ticket.id, agent)
    return
  }
  // 其回合要在后台再无任何运行时才结束，期间会占用其槽位：至多从本次空闲起算到时限，
  // 以及直到工作单元重新运行或任务分配结束。
  state?.settling?.abort()
  const look = new AbortController(), limit = new AbortController()
  w.state(ticket.id).settling = look
  const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
  timer.unref?.()
  let quiet: boolean
  const left = w.workers.get(ticket.id)?.left?.jobs
  try { quiet = await untilQuiet(w.host.context, agent, AbortSignal.any([w.host.lifetime, look.signal, limit.signal]), left) }
  finally {
    clearTimeout(timer)
    const observed = w.workers.get(ticket.id)
    if (observed?.settling === look) observed.settling = undefined
  }
  const current = live()
  if (w.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || w.workers.get(ticket.id)?.resuming === idle.id) return
  if (quiet) w.host.engine.turnEnded(ticket.id, idle.id)
  let stopped = ''
  if (!quiet) {
    // 超过时限仍在运行的 shell 作业会被终止，并在其下一个回合被告知；其子智能体则会继续运行，
    // 因为停止它们会唤醒工作单元。
    const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 60_000
    const jobs = runningJobs(w.host.context, sessionId, left).map(job => job.name)
    if (jobs.length) {
      void w.background(killJobs(w.host.context, sessionId, 'The job ran past its limit', left))
      const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(', ')}.`
      void w.background(w.host.sessions.prompt(sessionId, `killed:${jobs.join(',')}`, note, { inject: 'Background jobs killed' }))
    }
    stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(', ')}.`
      : `Subagents still ran ${minutes} minutes after the worker's turn ended.`
  }
  // 工作单元可能在其回合结束时已提交报告；被人的消息解除的 blocked 或 failed 报告是过时的。
  if (handedOff(current)) return
  const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
  const text = last?.type === 'assistant/message'
    ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
  const said = [text, stopped].filter(Boolean).join('\n\n')
  w.host.store.atomic(() => {
    const before = latestReport(current)?.summary ?? ''
    const updated = w.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
    // orchestrator_report 之后的静默收尾既不是新状态，也不是空交接。
    if (said) w.host.sessions.relay(updated.id, resultRelay(updated, 'waiting', said).text)
    else if (!before.trim()) {
      w.host.sessions.relay(updated.id, resultRelay(updated, 'waiting',
        'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.').text)
    }
  })
}
