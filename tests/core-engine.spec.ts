import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, followupOwners, key, runningAssignment, ticketOutcome, ticketStage,
  waitsForPerson } from '../src/core/index.ts'
import type { Assessor, Assignment, Candidate, EngineOptions, Executor, OutboundMessage, Outcome, Policy, Ticket, Trigger } from '../src/core/index.ts'

const member = { source: 'chat', id: 'alice' }
const guest = { source: 'chat', id: 'guest' }
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true, at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`, channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides }
}
interface Hooks {
  emit?: (event: { type: string; data: Record<string, unknown> }) => void
  prepareTicket?: EngineOptions['prepareTicket']
}
function harness(policyOverrides: Partial<Policy> = {}, { emit, prepareTicket }: Hooks = {}) {
  const repo = new MemoryRepositories()
  const outbox: OutboundMessage[] = []
  const withdrawn: string[] = []
  const requests: Candidate[] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const launches: [Ticket, Assignment][] = []
  const deliveries = new Set<string>()
  /** 执行器交给运行中任务的输入，形式为 [工单 id, 输入 id]。 */
  const delivered: [string, string][] = []
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }), deliver: vi.fn(ticket => { deliveries.add(ticket.id) }), stop: vi.fn(),
  }
  let version = 'v1', paused = false
  const policy: Policy = {
    get version() { return version }, get paused() { return paused }, evalTimeoutMs: 60_000,
    gate: (t, thread) => !t.human ? { admissible: false, reason: 'not human' } : t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'addressed' as const, addressed: 'mention' as const } } : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } } : { admissible: false, reason: 'not a member' },
    revalidate: () => version !== 'revoked',
    admitsInferred: rules => rules.length > 0,
    ...policyOverrides,
  }
  let clock = 0
  const scope: EngineOptions['scope'] = { scope: t => t.meta.blocked ? { listened: false, reason: 'chat not allowed' } : { listened: true, observed: false } }
  const queued: EngineOptions['outbox'] = {
    send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
    status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
    withdraw: id => { withdrawn.push(id) },
  }
  const engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox: queued,
    ...emit ? { emit } : {}, ...prepareTicket ? { prepareTicket } : {}, now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString() })
  /** 模拟执行器启动排队的任务（`launch` 为 false 时不启动）并投递待处理的工单输入。 */
  function settle({ launch = true } = {}) {
    for (;;) {
      const next = launch ? launches.shift() : undefined
      if (next) { engine.assignmentStarted(next[0].id, next[1].id); continue }
      const [ticketId] = deliveries
      if (ticketId === undefined) return
      deliveries.delete(ticketId)
      const ticket = repo.tickets.get(ticketId)!
      const assignment = runningAssignment(ticket)
      if (ticket.ended || !assignment) continue
      for (const inputId of ticket.undelivered) { delivered.push([ticketId, inputId]); engine.inputsDelivered(ticketId, assignment.id, [inputId]) }
    }
  }
  const pump = () => { engine.evaluateDue(); settle() }
  /** 模拟执行器会话把它尚未读取的已投递触发器输入纳入一步。 */
  const read = (ticketId: string) => engine.inputsRead(ticketId, repo.tickets.get(ticketId)!.inputs.flatMap(input =>
    input.kind === 'trigger' && input.readAt === null ? [input.id] : []))
  const decide = (candidate: Candidate, outcome: Outcome) => engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
  return { repo, engine, outbox, withdrawn, requests, assessor, executor, delivered, settle, pump, read, decide,
    setVersion: (value: string) => { version = value }, setPaused: (value: boolean) => { paused = value }, tick: (seconds: number) => { clock += seconds } }
}
function accepted(h: ReturnType<typeof harness>, id = '1', thread = 't1') {
  h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] })); h.pump()
  const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })
  h.settle()
  return decision
}

describe('intake', () => {
  it('stores a trigger once and records source filtering', () => {
    const h = harness()
    expect(h.engine.receive(trigger('1'))).toBe('stored')
    expect(h.engine.receive(trigger('1'))).toBe('duplicate')
    expect(h.engine.receive(trigger('2', { meta: { blocked: true } }))).toBe('filtered')
    expect(h.repo.triggers.disposition('2')?.filtered).toEqual({ code: 'chat not allowed' })
    expect(h.repo.threads.get('chat:t1')?.pending).toEqual(['1'])
  })
  it('records correlation for a trigger on several threads and evaluates only on the primary one', () => {
    const h = harness()
    h.engine.receive(trigger('1', { threads: [{ source: 'gh', id: 'pr-7' }, { source: 'gh', id: 'run-9' }] }))
    expect(h.repo.threads.get('gh:pr-7')).toMatchObject({ pending: ['1'], correlated: ['gh:run-9'] })
    expect(h.repo.threads.get('gh:run-9')).toMatchObject({ pending: [], correlated: ['gh:pr-7'] })
  })
})
describe('eval', () => {
  it('ignores at the gate without an assessor when nothing is admissible', async () => {
    const h = harness()
    h.engine.receive(trigger('1', { human: false })); h.pump()
    expect(h.assessor.request).not.toHaveBeenCalled()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'ignore', triggerIds: ['1'] })])
    expect(h.repo.triggers.disposition('1')?.decisionId).toBeDefined()
  })
  it('releases the assessor\'s state for every eval that ends, decided or not', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    expect(h.assessor.release).toHaveBeenCalledExactlyOnceWith(h.requests[0]!.evalId)
  })
  it('serializes evals per thread and debounces triggers that arrive meanwhile', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.engine.receive(trigger('2')); h.engine.receive(trigger('3')); h.pump()
    expect(h.requests).toHaveLength(1)
    expect(h.repo.threads.get('chat:t1')?.pending).toEqual(['2', '3'])
    h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' })
    h.pump()
    expect(h.requests[1]!.triggers.map(t => t.id)).toEqual(['2', '3'])
    expect(h.requests[1]!.strength).toBe('explicit')
  })
  it('accept creates a ticket with a mandate, subscribes the thread, queues the acknowledgement and starts an assignment', async () => {
    const h = harness()
    const decision = accepted(h)
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket).toMatchObject({ title: 'Fix', mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed' as const, addressed: 'mention' as const }, actor: member, scope: 'small' }, channels: [trigger('1').channel],
      origin: { triggerId: '1', triggerIds: ['1'] } })
    expect(ticket).not.toHaveProperty('ended')
    expect(ticket.assignments).toEqual([expect.objectContaining({ state: 'running', startedAt: expect.any(String) })])
    expect(h.repo.threads.get('chat:t1')?.subscriptions).toEqual([ticket.id])
    expect(h.outbox).toEqual([{ id: key('ack', '1'), channel: trigger('1').channel, text: 'ok', kind: 'acknowledgement', ticketId: ticket.id }])
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('refuses to decide an eval that a later eval replaced, and decides the later one', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const first = h.requests[0]!
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2'); h.pump()
    const second = h.requests[1]!
    expect(() => h.decide(first, { kind: 'ignore', reason: 'chatter' })).toThrow('has finished or a later eval replaced it')
    expect(h.decide(second, { kind: 'ignore', reason: 'chatter' })).toMatchObject({ kind: 'ignore', evalId: second.evalId })
  })
  it('records an accept with its ticket, subscriptions and acknowledgement together, or none of them', async () => {
    const h = harness({}, { prepareTicket: () => { throw new Error('No directory for the ticket') } })
    h.engine.receive(trigger('1')); h.pump()
    const evalId = h.requests[0]!.evalId
    expect(() => h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' })).toThrow('No directory')
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
    expect(h.repo.tickets.list()).toEqual([])
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ evaluating: { id: evalId }, subscriptions: [] })
    expect(h.outbox).toEqual([])
  })
  it('records unavailable when the policy version changed during assessment', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.setVersion('v2')
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'x', scope: 'x', reason: 'x' })
    expect(decision.kind).toBe('unavailable')
    expect(h.repo.tickets.list()).toEqual([])
  })
  it('starts every pending eval in one step, so a second pump starts none of them again', () => {
    const h = harness()
    for (const [id, thread] of [['1', 'A'], ['2', 'B']] as const) h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] }))
    expect(h.engine.evaluateDue()).toBeUndefined()
    h.engine.evaluateDue()
    expect(h.requests.map(candidate => candidate.thread.key)).toEqual(['chat:A', 'chat:B'])
  })
  it('counts an Eval\'s deadline from its delivery, queues its Triggers again twice when it expires, then records it unavailable', async () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    // 评估器会话尚未领取的候选不会过期。
    h.tick(600); h.pump()
    expect(h.engine.candidate('1')?.evalId).toBe(h.requests[0]!.evalId)
    const deliver = () => { h.engine.candidateDelivered(h.requests.at(-1)!.evalId) }
    deliver()
    h.tick(59); h.pump()
    expect(h.requests).toHaveLength(1)
    // 过期后它不记录任何内容，并把触发器重新排入一次新的评估，共两次。
    h.tick(2); h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
    expect(h.assessor.release).toHaveBeenCalledWith(h.requests[0]!.evalId)
    expect(h.requests.map(item => item.triggers.map(each => each.id))).toEqual([['1'], ['1']])
    deliver(); h.tick(61); h.pump()
    expect(h.requests).toHaveLength(3)
    // 第三次过期会记录为不可用。
    deliver(); h.tick(61); h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'unavailable', reason: [{ code: 'timeout' }] })])
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: [] })
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('expired')
  })
})
describe('subscription fan-out', () => {
  it('delivers a person\'s later message on a subscribed thread to the live ticket as context, and not to Eval', async () => {
    const h = harness()
    const decision = accepted(h)
    const requests = h.requests.length
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.inputs).toEqual([expect.objectContaining({ kind: 'trigger', triggerId: '2' })])
    expect(ticket.undelivered).toEqual([])
    expect(h.delivered).toEqual([[ticket.id, ticket.inputs[0]!.id]])
    expect(h.repo.triggers.disposition('2')).toEqual({ fanout: [ticket.id], at: expect.any(String) })
    // 没有评估，就没有决策和超时，线程的队列也可空出来接收新请求。
    expect([h.requests.length, h.repo.threads.get('chat:t1')!.pending, h.repo.decisions.byThread('chat:t1').length]).toEqual([requests, [],
      1])
    h.tick(600); h.engine.evaluateDue()
    expect(h.repo.decisions.byThread('chat:t1')).toHaveLength(1)
    // 那里机器人的消息仍会进入评估，只是门禁不会接纳它。
    h.engine.receive(trigger('3', { human: false })); h.pump()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', triggerIds: ['3'] })
  })
  it('keeps inputs undelivered until an assignment is running, and asks to launch one whose launch failed again', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' })
    h.settle({ launch: false })
    h.engine.receive(trigger('2')); h.engine.evaluateDue(); h.settle({ launch: false })
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.undelivered).toHaveLength(1)
    expect(h.executor.deliver).not.toHaveBeenCalled()
    expect(h.executor.start).toHaveBeenCalledTimes(2)
    h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id); h.settle()
    expect(h.delivered).toEqual([[ticket.id, ticket.undelivered[0]!]])
  })
  it('does not hand a bot\'s message to an ended ticket, and still assesses it', async () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    h.engine.receive(trigger('2', { human: false })); h.pump()
    // 执行器恢复时会重新读取其线程，因此机器人和 CI 既不会唤醒已结束的工单，也不会在其上排队。
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('resumes once however often it pumps, with the resume note ahead of the message, and drops what waited when the policy no longer holds the mandate', async () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    h.setVersion('v1')
    h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)!.ended).toBeDefined()
    h.engine.receive(trigger('3', { actor: guest })); h.pump(); h.pump()
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.inputs.filter(input => input.kind === 'resumed')).toHaveLength(1)
  })
  it('takes delivery reports only from the assignment that still runs the open ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const assignment = h.repo.tickets.get(ticketId)!.assignments[0]!.id
    h.engine.receive(trigger('2'))
    const input = key('input', ticketId, 'trigger', '2')
    h.engine.deliveryFailed(ticketId, assignment, 'Session busy')
    expect(h.repo.tickets.get(ticketId)!.delivery).toMatchObject({ error: 'Session busy' })
    h.engine.deliveryFailed(ticketId, 'another', 'other')
    h.engine.inputsDelivered(ticketId, 'another', [input])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [input], delivery: { error: 'Session busy' } })
    h.engine.inputsDelivered(ticketId, assignment, [input])
    expect(h.repo.tickets.get(ticketId)!.undelivered).toEqual([])
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
    h.engine.receive(trigger('3')); h.engine.stopTicket(ticketId)
    h.engine.deliveryFailed(ticketId, assignment, 'late')
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: expect.anything(), undelivered: [] })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
  })
  it('unsubscribing a thread stops fan-out until a new decision subscribes it', async () => {
    const h = harness()
    const decision = accepted(h)
    expect(h.engine.unsubscribe('chat:t1')).toBe(true)
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(decision.ticketId!)!.inputs).toEqual([])
  })
  it('lets an Executor drop a thread attached to its ticket, keeping the thread\'s other tickets, but not its own threads', async () => {
    const events: { type: string; data: Record<string, unknown> }[] = []
    const h = harness({}, { emit: event => events.push(event) })
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    // 第二张工单的后续消息只有在第二张工单的执行器交回后，才会转到第一张。
    h.engine.handback(second, '3', 'It is about the first fix')
    h.engine.attach(first, '3')
    expect(h.repo.threads.get('chat:t2')!.subscriptions).toEqual([second, first])
    h.engine.markUnrelated(first, 'chat:t2', 'about another fix')
    expect(h.repo.threads.get('chat:t2')!.subscriptions).toEqual([second])
    expect(events.filter(event => event.type === 'thread.unsubscribed').map(event => event.data))
      .toEqual([{ threadKey: 'chat:t2', ticketId: first, by: 'executor', reason: 'about another fix' }])
    expect(() => h.engine.markUnrelated(first, 'chat:t2', 'again')).toThrow(new UserError('notFollowing'))
    expect(() => h.engine.markUnrelated(first, 'chat:t1', 'its own')).toThrow(new UserError('sourceThread'))
    h.engine.bindThread(first, { source: 'gh', id: 'pr-9' }, true)
    expect(() => h.engine.markUnrelated(first, 'gh:pr-9', 'its PR')).toThrow(new UserError('followedThread'))
  })
})
describe('resume and stop', () => {
  async function ended(h: ReturnType<typeof harness>, by: 'executor' | 'human') {
    const decision = accepted(h)
    if (by === 'executor') h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' })
    else h.engine.stopTicket(decision.ticketId!)
    return decision.ticketId!
  }
  it('resumes an ended ticket on any person\'s message on its thread, under the same mandate and without a Decision', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    const decisions = h.repo.decisions.byThread('chat:t1').length
    // 消息到达时它便恢复，早于对该消息的任何评估。
    h.engine.receive(trigger('2', { actor: guest }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
    h.pump()
    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.mandate.policyVersion).toBe('v1')
    expect(ticket.inputs.map(input => input.kind)).toEqual(['trigger', 'resumed'])
    expect(h.executor.start).toHaveBeenCalledTimes(2)
    // 该消息仍作为后续消息进入评估，但不会在工单之外产生新的决策种类。
    expect(h.repo.decisions.byThread('chat:t1').filter(decision => decision.kind !== 'ignore')).toHaveLength(decisions)
  })
  it('resumes an ended ticket an earlier version left with a person\'s message waiting, on the next pass', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const stored = h.repo.tickets.get(ticketId)!
    const input = { id: 'waiting', kind: 'trigger' as const, triggerId: '2', at: stored.updatedAt, human: true as const }
    h.repo.tickets.save({ ...stored, inputs: [...stored.inputs, input], undelivered: ['waiting'] })
    h.pump()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ inputs: expect.arrayContaining([expect.objectContaining({ kind: 'resumed' })]) })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
  })
  it('resumes an ended ticket at once when a person attaches a message to it', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const subject = h.engine.attach(ticketId, '2')
    expect(subject).toMatchObject({ assignments: [expect.anything(), expect.objectContaining({ state: 'pending' })] })
    expect(subject).not.toHaveProperty('ended')
  })
  it('keeps a ticket a person stopped ended: the stop withdrew its mandate', async () => {
    const h = harness()
    const ticketId = await ended(h, 'human')
    expect(h.executor.stop).toHaveBeenCalledOnce()
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: expect.objectContaining({ by: 'human' }) })
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('keeps a ticket ended when its mandate no longer passes the current policy', async () => {
    const h = harness()
    const ticketId = await ended(h, 'executor')
    h.setVersion('revoked')
    h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
  })
  it('stops a live ticket only on an explicit instruction and ends it by the human', async () => {
    const h = harness()
    const decision = accepted(h)
    // 已到达工单的后续消息：主会话对其中一条采取行动时由门禁判断，访客的按推断处理。
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.engine.decide('2', { kind: 'stop', ticketId: decision.ticketId!, reason: 'x' })).toMatchObject({ kind: 'ignore',
      strength: 'inferred', reason: [{ code: 'stopNotExplicit' }] })
    h.engine.receive(trigger('3')); h.pump()
    expect(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'human said stop' }).kind).toBe('stop')
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.objectContaining({ by: 'human' }) })
    expect(h.executor.stop).toHaveBeenCalledOnce()
  })
})
describe('follow-ups', () => {
  it('takes a follow-up an older version queued out of the queue without a Decision, and keeps one sent to Eval again', () => {
    const h = harness()
    accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.receive(trigger('3', { actor: guest }))
    // 按旧版本留下的状态：两者都已排入评估；真人又把第二条送进了评估。
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, pending: ['2', '3'] })
    h.engine.reevaluate('3'); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3'])
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    expect(h.repo.decisions.byThread('chat:t1').flatMap(decision => decision.triggerIds)).toEqual(['1'])
  })
  it('decides a follow-up in a gate-only Eval beside the Eval its Thread has in progress, which goes on', () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    const evaluating = h.repo.threads.get('chat:t1')!.evaluating!
    h.engine.receive(trigger('3'))
    expect(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'stop it' })).toMatchObject({ kind: 'stop',
      triggerIds: ['3'] })
    expect(h.repo.threads.get('chat:t1')!.evaluating).toEqual(evaluating)
    expect(h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' })).toMatchObject({ kind: 'ignore', triggerIds: ['2'] })
  })
  it('leaves the Thread free for a later request that reaches no ticket', () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    h.engine.stopTicket(decision.ticketId!, 'not needed')
    // 工单处理期间该后续消息并未占用评估，因此下一个请求会立即被评估，而不是等到超时后，并与该后续消息一起评估；后者在执行器接手前已被停止操作放行。
    h.engine.receive(trigger('3')); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2', '3'])
  })
})
describe('hand-back', () => {
  it('queues a message that reached a ticket for a fresh Eval with the gate\'s strength, once per ticket, and keeps the subscription',
    () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2')); h.engine.receive(trigger('3', { actor: guest })); h.pump()
    expect(h.engine.handback(ticketId, '2', 'A new request')).toBe(true); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'explicit', triggers: [{ id: '2' }] })
    expect(h.repo.triggers.disposition('2')!.handbacks).toEqual([{ ticketId, reason: 'A new request', at: expect.any(String) }])
    h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' })
    expect(() => h.engine.handback(ticketId, '2', 'Again')).toThrow(new UserError('handedBack'))
    expect(h.engine.handback(ticketId, '3', 'A guest asks for more')).toBe(true); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'inferred', triggers: [{ id: '3' }] })
    expect(h.repo.threads.get('chat:t1')!.subscriptions).toContain(ticketId)
    // 只有到达工单的消息才能被交回。
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    expect(() => h.engine.handback(ticketId, '4', 'Not mine')).toThrow(new UserError('notReached'))
  })
  it('queues again no message the ticket did not decide: one a person sent to Eval, a bot\'s, or one on a Thread followed for context',
    () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
    h.engine.receive(trigger('2')); h.engine.reevaluate('2')
    h.engine.receive(trigger('3', { human: false })); h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'issue' }] })); h.pump()
    for (const candidate of h.requests.slice(-2)) h.decide(candidate, { kind: 'ignore', reason: 'chat' })
    // 两者都在没有工单的情况下进入了评估，其决策依然有效。
    for (const id of ['2', '3', '4']) expect(h.engine.handback(ticketId, id, 'Not this ticket')).toBe(false)
    expect([h.repo.threads.get('chat:t1')!.pending, h.repo.threads.get('chat:issue')!.pending]).toEqual([[], []])
    // 交回记录仍会被写入，因此主会话不会把该消息再附加回去。
    expect(h.repo.triggers.disposition('4')!.handbacks).toEqual([{ ticketId, reason: 'Not this ticket', at: expect.any(String) }])
    expect(() => h.engine.attach(ticketId, '4')).toThrow(new UserError('handedBackHere'))
  })
  it('leaves a message the main Session attached to a ticket to its worker, whose hand-back sends it to Eval', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'x' }] })); h.pump()
    h.engine.attach(ticketId, '2'); h.settle()
    // 被路由到工单后，它就不再同时算作新工作。
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Y', scope: 'small', reason: 'requested' }))
      .toThrow(new UserError('workerDecides', { tickets: ticketId }))
    expect(h.engine.handback(ticketId, '2', 'Asks for another change')).toBe(true)
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2'])
  })
})
describe('context threads and notes', () => {
  it('fans a Thread followed for context out to the live ticket, resumes no ended ticket from it, unless it was attached', async () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })).toBe(true)
    expect(h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })).toBe(false)
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'issue' }] })); h.settle()
    expect(h.repo.tickets.get(ticketId)!.inputs.map(input => input.kind === 'trigger' && input.triggerId)).toEqual(['2'])
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 'issue' }] }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    // 由主会话附加后，该线程就属于该工单，真人之后在其中的消息会恢复它。
    h.engine.attach(ticketId, '3'); h.settle()
    expect(h.repo.threads.get('chat:issue')).toMatchObject({ context: [] })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'issue' }] }))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
  it('counts a message on a Thread a ticket follows only for context as none of its follow-ups, and lifts no block with it', () => {
    const h = harness()
    const owner = accepted(h).ticketId!
    const follower = accepted(h, '2', 'other').ticketId!
    h.engine.followForContext(follower, { source: 'chat', id: 't1' })
    h.engine.receive(trigger('3', { actor: guest })); h.pump()
    expect(h.repo.triggers.disposition('3')).toMatchObject({ fanout: [owner, follower], context: [follower] })
    expect(h.repo.tickets.get(follower)!.inputs.at(-1)).toMatchObject({ triggerId: '3', context: true })
    // 已不再位于关注者自己的线程上：只到达该线程的消息会进入评估，连同被停止的工单主人放行的访客消息一起。
    h.engine.stopTicket(owner, 'done')
    h.engine.report(follower, { state: 'blocked', summary: 'needs a decision' })
    h.engine.receive(trigger('4')); h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3', '4'])
    expect(waitsForPerson(h.repo.tickets.get(follower)!)).toBe(true)
  })
  it('sends a message to Eval when the ticket it reached cannot resume and only a ticket following its Thread for context is left', () => {
    const h = harness()
    const owner = accepted(h).ticketId!
    const follower = accepted(h, '2', 'other').ticketId!
    h.engine.followForContext(follower, { source: 'chat', id: 't1' })
    h.engine.report(owner, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    h.engine.receive(trigger('3')); h.setVersion('v1'); h.pump()
    expect(h.repo.triggers.disposition('3')).toMatchObject({ fanout: [follower], context: [follower] })
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['3'])
  })
  it('gives an open ticket\'s worker a note as an Input of its own, held like automatic Input, and refuses one for an ended ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(h.engine.note(ticketId, 'The other ticket renamed the API').inputs.at(-1)).toMatchObject({ kind: 'note',
      text: 'The other ticket renamed the API' })
    // 报告受阻的执行器在等待真人：一条备注不会唤醒它。
    h.settle()
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    const note = h.engine.note(ticketId, 'Ticket B changed the schema').inputs.at(-1)!
    h.settle()
    expect(h.delivered.map(([, id]) => id)).not.toContain(note.id)
    expect(h.repo.tickets.get(ticketId)!.inputs).toContainEqual(note)
    h.engine.stopTicket(ticketId, 'done')
    expect(() => h.engine.note(ticketId, 'Too late')).toThrow(new UserError('ticketEnded'))
  })
})
describe('follow-up owners', () => {
  const accept = { kind: 'accept' as const, title: 'Y', scope: 'small', reason: 'requested' }
  const decides = (...tickets: string[]) => new UserError('workerDecides', { tickets: tickets.join(', ') })
  it('lets the main Session take a follow-up as new work once it stopped the ticket on it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // “停止这个，改做 Y”：停止结束了判定该消息的工单，因此该请求归主会话。
    h.engine.receive(trigger('2')); h.settle()
    expect(() => h.engine.decide('2', accept)).toThrow(decides(ticketId))
    expect(h.engine.decide('2', { kind: 'stop', ticketId, reason: 'asked to stop' }).kind).toBe('stop')
    // 与此同时，接单本身也是与停止决策并列的一项决策。
    expect(h.engine.decide('2', accept)).toMatchObject({ kind: 'accept', triggerIds: ['2'] })
    expect(h.repo.decisions.byThread('chat:t1').filter(item => item.triggerIds.includes('2')).map(item => item.kind)).toEqual(['stop',
      'accept'])
  })
  it('sends a follow-up its worker never received to Eval when the ticket ends, by a report or a stop', () => {
    for (const end of ['report', 'stop'] as const) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.receive(trigger('2'))
      expect(h.repo.tickets.get(ticketId)!.undelivered).toHaveLength(1)
      if (end === 'report') h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      else h.engine.stopTicket(ticketId, 'not needed')
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
      h.pump()
      expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2'])
    }
  })
  it('sends a follow-up its worker got since its last report to Eval when the ticket ends, unless it acknowledged it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    // 执行器确认了两条消息中的一条，而它的最终报告在它接手另一条之前就已发出。
    h.tick(1); h.engine.receive(trigger('2')); h.engine.receive(trigger('3')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
    // 该工单不再算作已到达它，因此其候选不会指名任何未给出原因的工单。
    expect([h.repo.triggers.disposition('2')!.fanout, h.repo.triggers.disposition('3')!.fanout]).toEqual([[ticketId], []])
  })
  it('keeps a ticket open after its pull request merged while its worker is on a person\'s message it took up after its last report',
    () => {
    for (const taken of [true, false]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
      h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
      // 真人又要求再改一处，执行器或已接手或尚未接手，而拉取请求在此期间合并了。
      h.tick(1); h.engine.receive(trigger('2')); h.settle()
      if (taken) h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
      h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
      // 执行器尚未接手的那条消息让合并来结束工单，并进入评估。
      expect([h.repo.tickets.get(ticketId)!.ended?.outcome, h.repo.threads.get('chat:t1')!.pending]).toEqual(taken ? [undefined, []]
        : ['merged', ['2']])
      // 执行器的就绪报告像拉取请求那样结束了它。
      if (taken) h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
      expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    }
  })
  it('gives a follow-up its ended ticket let go to that ticket again when the main Session attaches it there', () => {
    for (const resumed of [false, true]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      // 工单在执行器接手真人的消息之前就结束了，该消息进入评估；之后的消息可以恢复工单。
      h.engine.report(ticketId, { state: 'progress', summary: 'working' })
      h.tick(1); h.engine.receive(trigger('2')); h.settle()
      h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      if (resumed) { h.tick(1); h.engine.receive(trigger('3')) }
      h.pump()
      h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
      // 其执行器再次收到该消息，已结束的工单因而恢复。
      const copies = h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === '2')
      expect(h.delivered).toContainEqual([ticketId, copies[1]?.id])
      expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
      expect(followupOwners(trigger('2'), h.repo)).toEqual([ticketId])
    }
  })
  it('wakes an ended ticket for a message attached to it that its worker read only for context or before its last report', () => {
    for (const read of ['context', 'report'] as const) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      if (read === 'context') h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' })
      h.tick(1); h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: read === 'context' ? 'issue' : 't1' }] })); h.settle()
      // 执行器读完它后报告并丢弃工单；真人从面板发送一条不得不进入评估的后续消息。
      h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'read it' })
      h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      if (read === 'report') h.engine.reevaluate('2')
      h.pump()
      h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
      expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
      expect(followupOwners(h.repo.triggers.get('2')!, h.repo)).toEqual([ticketId])
    }
  })
  it('counts a question the final report answers as taken up, so it does not come back as a candidate beside its answer', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.report(ticketId, { state: 'ready', summary: 'It reads the config.', answers: '2' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    expect(h.repo.triggers.disposition('2')).toMatchObject({ fanout: [ticketId], acked: [ticketId] })
  })
  it('sends to Eval a message attached after its Eval was unavailable, once its ticket ends without taking it up', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'x' }] })); h.pump()
    h.decide(h.requests.at(-1)!, { kind: 'unavailable', reason: 'model down' })
    h.tick(1); h.engine.attach(ticketId, '2'); h.settle()
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2'])
  })
  it('counts an acknowledgement an earlier version queued without recording it on the message as taking the message up', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.outbox.push({ id: key('ack', '2'), channel: trigger('2').channel!, text: 'On it', kind: 'acknowledgement', ticketId })
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect([h.repo.threads.get('chat:t1')!.pending, h.repo.triggers.disposition('2')!.fanout]).toEqual([[], [ticketId]])
  })
  it('counts a message that resumed a ticket as taken up by the report that ends it again, unlike one that came later', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    // 真人的感谢恢复了工单，其执行器在其任务启动片刻后先把它纳入一步，同时执行器正在投递；此时它报告已无剩余工作，而一个请求随之到达。
    h.tick(1); h.engine.receive(trigger('2'))
    h.tick(1); h.engine.assignmentStarted(ticketId, h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id)
    h.tick(1); h.settle(); h.read(ticketId)
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('sends a follow-up its ticket let go to Eval after a stop on it was refused, but not the one a stop ended it on', () => {
    // 访客的停止被拒绝，执行器丢弃工单；成员发起的停止会结束它，而发起停止的主会话自行判定该消息的其余部分。
    for (const actor of [guest, member]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.receive(trigger('2', { actor }))
      h.engine.decide('2', { kind: 'stop', ticketId, reason: 'asked to stop' })
      if (actor === guest) h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(actor === guest ? ['2'] : [])
    }
  })
  it('sends the message a stop ended a ticket on to Eval once another ticket it reached ends without taking it up', () => {
    const h = harness()
    const stopped = accepted(h).ticketId!, other = accepted(h, '5', 't5').ticketId!
    h.engine.bindThread(other, { source: 'chat', id: 't1' }, false)
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.decide('2', { kind: 'stop', ticketId: stopped, reason: 'asked to stop' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    h.engine.report(other, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
  it('hands the follow-ups on a thread a worker found unrelated back to Eval, with its reason', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const elsewhere = { threads: [{ source: 'chat', id: 'x' }] }
    h.engine.receive(trigger('2', elsewhere)); h.pump()
    h.engine.attach(ticketId, '2'); h.settle()
    h.engine.receive(trigger('3', elsewhere)); h.settle()
    expect(() => h.engine.decide('3', accept)).toThrow(decides(ticketId))
    // 执行器发现附加的线程并不属于其工单，于是不在那里作答：主会话附加的消息随之后那条一起被交回，每个候选都说明原因。
    h.engine.markUnrelated(ticketId, 'chat:x', 'about something else')
    expect(h.repo.threads.get('chat:x')!.pending).toEqual(['2', '3'])
    expect(h.repo.triggers.disposition('3')!.handbacks).toEqual([{ ticketId, reason: 'about something else', at: expect.any(String) }])
    h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['2', '3'])
  })
  it('keeps a follow-up two tickets reached with the one that did not hand it back, and queues it once neither decides it', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.handback(first, '2', 'another change'); h.pump()
    const second = h.decide(h.requests.at(-1)!, accept).ticketId!
    h.settle()
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    expect(h.repo.triggers.disposition('3')!.fanout).toEqual([first, second])
    expect(h.engine.handback(first, '3', 'for the other ticket')).toBe(false)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual([])
    // 第二张工单的执行器还在判定它时，主会话既不能接单也不能忽略。
    expect(() => h.engine.decide('3', accept)).toThrow(decides(second))
    expect(() => h.engine.decide('3', { kind: 'ignore', reason: 'chat' })).toThrow(decides(second))
    expect(h.engine.handback(second, '3', 'neither ticket')).toBe(true)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('lets an Eval an earlier version started on a follow-up decide it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2')); h.settle()
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, evaluating: { id: 'e-legacy', threadKey: 'chat:t1', triggerIds: ['2'], strength: 'explicit',
      actor: member, basis: { via: 'addressed' as const, addressed: 'mention' as const }, policyVersion: 'v1', startedAt: '2026-09-23T00:00:00Z', deadline: '2026-09-24T00:00:00Z' } })
    expect(followupOwners(trigger('2'), h.repo)).toEqual([])
    expect(h.engine.decide('2', { kind: 'ignore', reason: 'chat', evalId: 'e-legacy' })).toMatchObject({ kind: 'ignore',
      triggerIds: ['2'] })
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
})
describe('interrupted assignments', () => {
  it('starts an Assignment interrupted mid-work again with a note, and hands one that waits what waits for it', () => {
    const h = harness()
    const interrupted = accepted(h).ticketId!
    const first = h.repo.tickets.get(interrupted)!.assignments[0]!
    const waiting = accepted(h, '2', 't2').ticketId!
    h.engine.report(waiting, { state: 'waiting', summary: 'done for now' })
    h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }))
    vi.mocked(h.executor.start).mockClear(); vi.mocked(h.executor.deliver).mockClear()
    // 执行器报告每个正在运行的任务；关于已不再运行任务的事实会被丢弃。
    for (const id of [interrupted, waiting]) h.engine.assignmentInterrupted(id, runningAssignment(h.repo.tickets.get(id)!)!.id)
    h.engine.assignmentInterrupted(interrupted, first.id)
    const ticket = h.repo.tickets.get(interrupted)!
    expect(ticket.assignments).toEqual([expect.objectContaining({ id: first.id, state: 'ended', endedReason: 'hostRestarted' }),
      expect.objectContaining({ state: 'pending' })])
    expect(ticket.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('The host restarted') })])
    expect(ticket.undelivered).toEqual([ticket.inputs[0]!.id])
    expect(h.executor.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: interrupted }), ticket.assignments[1])
    // 等待中的执行器保留其会话，并获得等待它的内容。
    expect(h.repo.tickets.get(waiting)!.assignments).toHaveLength(1)
    expect(h.executor.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: waiting }), expect.objectContaining({ state: 'running' }))
  })
  it('starts again a worker that reported but then got a person\'s message, which it was working on', () => {
    const h = harness()
    const other = accepted(h, '2', 't2').ticketId!
    h.engine.report(other, { state: 'waiting', summary: 'done for now' })
    h.tick(1); h.engine.receive(trigger('3', { actor: guest, threads: [{ source: 'chat', id: 't2' }] })); h.settle()
    const running = runningAssignment(h.repo.tickets.get(other)!)!
    expect(running.deliveredAt! > running.report!.at).toBe(true)
    h.engine.assignmentInterrupted(other, running.id)
    expect(h.repo.tickets.get(other)!.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
  })
})
describe('pause', () => {
  it('lets no Eval expire while processing is paused, and moves its deadline on by the pause\'s length', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    h.engine.candidateDelivered(h.requests[0]!.evalId)
    const deadline = Date.parse(h.repo.threads.get('chat:t1')!.evaluating!.deadline)
    h.tick(30); h.setPaused(true); h.pump()
    // 暂停超过截止时间时，评估继续等待。
    h.tick(300); h.pump()
    expect(h.engine.candidate('1')).toBeDefined()
    h.setPaused(false); h.pump()
    expect(Date.parse(h.repo.threads.get('chat:t1')!.evaluating!.deadline)).toBe(deadline + 300_000)
    h.tick(29); h.pump()
    expect(h.engine.candidate('1')).toBeDefined()
    // 过期后，它把触发器再次排入新的评估。
    h.tick(1); h.pump()
    expect(h.engine.candidate('1')?.evalId).not.toBe(h.requests[0]!.evalId)
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
})
describe('policy change', () => {
  it('tells only the live tickets a change bears on how it does, and restarts in-flight evals under the new version', async () => {
    const h = harness()
    const decision = accepted(h)
    const other = accepted(h, '3', 't3').ticketId!
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] })); h.pump()
    const effect = { rules: [{ id: 'copy', name: 'Copy', change: 'changed' as const, instruction: 'Fix typos only.' }] }
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2', new Map([[decision.ticketId!, effect]]))
    expect(h.repo.tickets.get(decision.ticketId!)!.inputs).toEqual([expect.objectContaining({ kind: 'policy-changed', from: 'v1', to: 'v2', effect })])
    expect(h.repo.tickets.get(other)!.inputs.filter(input => input.kind === 'policy-changed')).toEqual([])
    expect(h.repo.decisions.byThread('chat:t2')).toEqual([expect.objectContaining({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })])
    expect(h.repo.threads.get('chat:t2')?.pending).toEqual(['2'])
    h.pump()
    expect(h.requests.at(-1)).toMatchObject({ policyVersion: 'v2', triggers: [expect.objectContaining({ id: '2' })] })
    const told = h.repo.tickets.get(decision.ticketId!)!.inputs.find(input => input.kind === 'policy-changed')!
    expect(h.delivered).toEqual([[decision.ticketId, told.id]])
  })
  it('does not start evals while paused', async () => {
    const h = harness({ paused: true })
    h.engine.receive(trigger('1')); h.pump()
    expect(h.assessor.request).not.toHaveBeenCalled()
  })
})

describe('worker reports', () => {
  it('asks, keeps, replaces and clears the question for a person, and says which question a report replaced', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const asked = h.engine.report(ticketId, { state: 'progress', summary: 'need a call', question: 'Which color?', askedBy: '1' })
    expect(asked.attention).toMatchObject({ question: 'Which color?', triggerId: '1' })
    expect(h.engine.report(ticketId, { state: 'blocked', summary: 'still waiting' }).attention).toEqual(asked.attention)
    expect(h.withdrawn).toEqual([])
    const replaced = h.engine.report(ticketId, { state: 'progress', summary: 'other question', question: 'Which size?' })
    expect(replaced.attention).toMatchObject({ question: 'Which size?' })
    expect(replaced.attention).not.toHaveProperty('triggerId')
    // 若被替换的问题对应的消息尚未发出，则从发件箱撤回。
    expect(h.withdrawn).toEqual([key('attention-reply', asked.attention!.id)])
    const cleared = h.engine.report(ticketId, { state: 'progress', summary: 'answered', question: null })
    expect(cleared).not.toHaveProperty('attention')
    expect(h.withdrawn).toEqual([key('attention-reply', asked.attention!.id), key('attention-reply', replaced.attention!.id)])
  })
  it('ends the ticket on a final report: dropped drops it, ready completes it unless it follows a Source\'s Thread that is open', () => {
    const outcome = (state: 'ready' | 'dropped' | 'failed', follows: boolean, closed = false) => {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Merge it?' })
      if (follows) h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false)
      if (follows) h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true)
      // 两者都关闭后恢复的工作以就绪报告结束，并采用最新的关闭结果。
      if (closed) {
        h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'closed', '2026-09-22T00:00:00Z')
        h.engine.threadClosed({ source: 'gh', id: 'pr-10' }, 'merged', '2026-09-22T00:00:01Z')
      }
      h.engine.report(ticketId, { state, summary: 'done' })
      return h.repo.tickets.get(ticketId)!
    }
    expect(outcome('dropped', true)).toMatchObject({ ended: { by: 'executor', outcome: 'dropped' } })
    expect(outcome('dropped', true).ended).not.toHaveProperty('reason')
    expect(outcome('ready', false)).toMatchObject({ ended: { outcome: 'completed' } })
    expect(outcome('ready', false)).not.toHaveProperty('attention')
    expect(outcome('ready', true)).toMatchObject({ follows: [{ thread: 'gh:pr-9', own: false }, { thread: 'gh:pr-10', own: true }],
      assignments: [expect.objectContaining({ report: expect.objectContaining({ state: 'ready' }) })] })
    expect(outcome('ready', true)).not.toHaveProperty('ended')
    expect(outcome('ready', true)).not.toHaveProperty('attention')
    expect(outcome('ready', true, true)).toMatchObject({ ended: { outcome: 'merged' } })
    expect(outcome('failed', false)).toMatchObject({ attention: { question: 'Merge it?' } })
    expect(outcome('failed', false)).not.toHaveProperty('ended')
  })
  it('refuses a question with a result or an answer, and questions or answers that name no person\'s message of the ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { human: false, threads: [{ source: 'chat', id: 't1' }] }))
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    const report = (extra: object) => () => h.engine.report(ticketId, { state: 'progress', summary: 'x', ...extra })
    expect(report({ state: 'ready', question: 'Q?' })).toThrow(new UserError('questionWithResult'))
    expect(report({ question: 'Q?', answers: '1' })).toThrow(new UserError('questionWithResult'))
    expect(report({ askedBy: '1' })).toThrow(new UserError('askerWithoutQuestion'))
    expect(report({ question: 'Q?', askedBy: '2' })).toThrow(new UserError('notAsker'))
    expect(report({ answers: '4' })).toThrow(new UserError('notAnswerable'))
    expect(report({ answers: '1' })()).toMatchObject({ answers: ['1'] })
  })
  it('refuses a report on an ended ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'x' })).toThrow(new UserError('ticketEnded'))
  })
})
describe('outcomes', () => {
  it('records how a ticket ended', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.stopTicket(ticketId, 'Human asked to stop')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ by: 'human', outcome: 'stopped', reason: 'Human asked to stop' })
    expect(ticketOutcome(h.repo.tickets.get(ticketId)!)).toBe('stopped')
    expect(ticketOutcome({})).toBeUndefined()
  })
})
describe('attach', () => {
  it('sends the routing note for a message the worker has, ends an Eval that holds only that message, and refuses a ticket a person stopped or the Policy no longer holds', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    expect(h.delivered.map(([, input]) => input)).toEqual([key('input', ticketId, 'trigger', '2')])
    // 该后续消息未经评估就到达了工单，由执行器判断；真人再次送入评估后，就在那里判断。
    expect(h.engine.candidate('2')).toBeUndefined()
    expect(() => h.engine.attach(ticketId, '2')).toThrow(new UserError('workerDecides', { tickets: ticketId }))
    expect(h.engine.reevaluate('2')).toBe(true); h.pump()
    expect(h.engine.candidate('2')).toBeDefined()
    const attached = h.engine.attach(ticketId, '2', 'The guest asks for the same fix'); h.settle()
    expect(attached.inputs).toEqual([expect.objectContaining({ triggerId: '2' }), expect.objectContaining({ triggerId: '2', note: 'The guest asks for the same fix' })])
    expect(h.delivered.map(([, input]) => input)).toEqual(attached.inputs.map(input => input.id))
    expect(h.engine.candidate('2')).toBeUndefined()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', reason: [{ code: 'routed', values: { ticket: ticketId } }] })
    // 仍等待执行器的消息，其备注会随该消息一起发出，与真人立即送入评估的情况相同。
    h.engine.receive(trigger('5', { actor: guest })); h.engine.reevaluate('5')
    expect(h.engine.attach(ticketId, '5', 'Same fix again').inputs.at(-1)).toMatchObject({ triggerId: '5', note: 'Same fix again' })
    h.settle()
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.setVersion('revoked')
    expect(() => h.engine.attach(ticketId, '2')).toThrow(new UserError('mandateRevoked'))
    h.setVersion('v1')
    const stopped = accepted(h, '3', 't3').ticketId!
    h.engine.stopTicket(stopped)
    expect(() => h.engine.attach(stopped, '2')).toThrow(new UserError('ticketStopped'))
    expect(() => h.engine.attach('missing', '2')).toThrow(new UserError('unknownTicket'))
  })
  it('ends the batch Eval of a message attached to a ticket and assesses the rest again, leaving the message to that ticket', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!, other = accepted(h, '5', 't5').ticketId!
    const elsewhere = { threads: [{ source: 'chat', id: 'x' }] }
    h.engine.receive(trigger('2', elsewhere)); h.engine.receive(trigger('3', elsewhere)); h.pump()
    h.engine.attach(ticketId, '3'); h.pump()
    expect(h.repo.decisions.byThread('chat:x')).toEqual([expect.objectContaining({ kind: 'unavailable', triggerIds: ['2', '3'],
      reason: [{ code: 'routed', triggerId: '3', values: { ticket: ticketId } }] })])
    expect(h.engine.candidate('2')?.triggers.map(item => item.id)).toEqual(['2'])
    expect(followupOwners(h.repo.triggers.get('3')!, h.repo)).toEqual([ticketId])
    expect(() => h.engine.attach(other, '3')).toThrow(new UserError('workerDecides', { tickets: ticketId }))
  })
  it('names missing things apart from refusals and fills in the values', () => {
    expect([new UserError('unknownTicket').missing, new UserError('ticketEnded').missing]).toEqual([true, false])
    expect(new UserError('notAdmissible', { reason: 'not_a_member' })).toMatchObject({ code: 'notAdmissible', values: { reason: 'not_a_member' }, message: 'Trigger is not admissible: not_a_member' })
  })
})
describe('direct decisions', () => {
  it('decides an explicit request no Eval holds in a direct Eval, refuses a proactive accept without matched rules, and accepts a Trigger once', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    const decision = h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'routed' })
    expect(decision).toMatchObject({ kind: 'accept', triggerIds: ['1'], strength: 'explicit' })
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: [] })
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'routed' })).toEqual(decision)
    // 访客的后续消息未经评估就到达了该工单：由执行器判定，只有执行器交回的内容才可能成为新工作，且按门禁的权限以推断强度处理。
    h.engine.receive(trigger('2', { actor: guest })); h.pump()
    const ticketId = decision.ticketId!
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['r1'] }))
      .toThrow(new UserError('workerDecides', { tickets: ticketId }))
    h.engine.handback(ticketId, '2', 'A different fix')
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'proactive' })).toThrow(new UserError('notExplicit'))
    expect(h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule',
      rules: ['r1'] })).toMatchObject({ kind: 'accept', strength: 'inferred' })
    expect(() => h.engine.decide('missing', { kind: 'ignore', reason: 'x' })).toThrow(new UserError('unknownTrigger'))
  })
  it('accepts an inferred candidate only on rules the Policy admits, whoever names them', () => {
    const h = harness({ admitsInferred: rules => rules.includes('enabled') })
    accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    const candidate = h.requests.at(-1)!
    expect(() => h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['disabled'] })).toThrow(new UserError('notExplicit'))
    expect(h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['enabled'] })).toMatchObject({ kind: 'accept' })
  })
  it('ends the Eval of a replayed Trigger that started a ticket, and returns that ticket\'s Decision for it', () => {
    const h = harness()
    const decision = accepted(h)
    h.tick(1)
    expect(h.engine.reevaluate('1')).toBe(true)
    h.pump()
    expect(h.engine.candidate('1')).toBeUndefined()
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', triggerIds: ['1'],
      reason: [{ code: 'startedTicket', triggerId: '1', values: { ticket: decision.ticketId } }] })
    expect(h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'again' })).toEqual(decision)
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(() => h.engine.reevaluate('missing')).toThrow(new UserError('unknownTrigger'))
  })
  it('keeps a replayed Trigger that started a ticket out of the Eval of the Triggers queued with it', () => {
    const h = harness()
    const decision = accepted(h)
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.engine.reevaluate('1'); h.pump()
    // 成员重放的请求不会给访客的消息赋予任何权限。
    expect(h.engine.candidate('1')).toBeUndefined()
    expect(h.engine.candidate('2')).toMatchObject({ strength: 'inferred', triggers: [{ id: '2' }] })
    expect(() => h.engine.decide('2', { kind: 'accept', title: 'Other', scope: 'small', reason: 'routed' })).toThrow(new UserError('notExplicit'))
    expect(h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'again' })).toEqual(decision)
    expect(h.repo.tickets.list()).toHaveLength(1)
  })
  it('starts a ticket from a request accepted beside a replayed one, with its own origin and acknowledgement', () => {
    const h = harness()
    const first = accepted(h)
    h.tick(1); h.engine.receive(trigger('2')); h.engine.reevaluate('2'); h.engine.reevaluate('1'); h.pump()
    const second = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Other', scope: 'small', reason: 'routed', acknowledgement: 'On it' })
    expect(second.ticketId).not.toBe(first.ticketId)
    expect(h.repo.tickets.get(second.ticketId!)!.origin).toEqual({ triggerId: '2', triggerIds: ['2'] })
    expect(h.outbox.find(message => message.id === key('ack', '2'))).toMatchObject({ text: 'On it', kind: 'acknowledgement' })
    // 重放的请求仍以它启动的工单作为答复。
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'again' })).toEqual(first)
  })

})
describe('automatic input', () => {
  it('holds back automatic Input from a worker that reported blocked or failed until a person\'s message arrives', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const bot = (id: string) => trigger(id, { human: false })
    h.engine.receive(bot('2'))
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    // 待处理的以及后续的自动输入都留在工单上排队，不会唤醒执行器。
    h.engine.receive(bot('3')); h.settle()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], inputs: [expect.objectContaining({ triggerId: '2' }), expect.objectContaining({ triggerId: '3' })] })
    expect(h.delivered).toEqual([])
    h.tick(1)
    h.engine.receive(trigger('4', { actor: guest })); h.engine.receive(bot('5')); h.settle()
    expect(h.delivered.map(([, input]) => input)).toEqual([key('input', ticketId, 'trigger', '4'), key('input', ticketId, 'trigger', '5')])
  })
  it('stops waiting for a person on a person\'s message, a later report that is neither blocked nor failed, or a retry', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' })
    expect(waitsForPerson(ticket())).toBe(true)
    expect(ticketStage(ticket())).toEqual({ stage: 'person', action: 'blocked' })
    // 执行器已拿到真人的回复，因此过时的受阻报告不再持有工单。
    h.tick(1); h.engine.receive(trigger('2', { actor: guest })); h.settle()
    expect(waitsForPerson(ticket())).toBe(false)
    expect(ticketStage(ticket())).toEqual({ stage: 'working' })
    h.tick(1); h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    expect(waitsForPerson(ticket())).toBe(true)
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'found a way' })
    expect(waitsForPerson(ticket())).toBe(false)
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'needs access' })
    h.engine.retryTicket(ticketId)
    expect(waitsForPerson(ticket())).toBe(false)
  })
  it('launches a failed launch again for a person\'s message, but not for a Policy change', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const ticketId = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' }).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'The prepare command failed' })
    vi.mocked(h.executor.start).mockClear()
    h.setVersion('v2'); h.engine.policyChanged('v1', 'v2')
    expect(h.executor.start).not.toHaveBeenCalled()
    h.tick(1); h.engine.receive(trigger('2', { actor: guest }))
    expect(h.executor.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: ticketId }), expect.objectContaining({ state: 'pending' }))
  })
})
describe('replies', () => {
  it('acknowledges a person\'s message that reached an open ticket once, and refuses others', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // 接单的确认会保留；之后再有请求时复用它。
    expect(h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '1', text: 'On it' })).toEqual({ id: key('ack', '1'), status: 'pending', reused: true })
    expect(h.outbox.map(message => message.text)).toEqual(['ok'])
    h.engine.receive(trigger('2', { actor: guest }))
    expect(h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'Looking' })).toEqual({ id: key('ack', '2'), status: 'pending', reused: false })
    h.engine.receive(trigger('3', { human: false }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '3', text: 'x' })).toThrow(new UserError('ackNotPerson'))
    h.engine.receive(trigger('6', { threads: [{ source: 'chat', id: 'elsewhere' }] }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '6', text: 'x' })).toThrow(new UserError('notReached'))
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'x' })).toThrow(new UserError('ackEnded'))
  })
  it('sends an answer only after the worker reported it, a result only for a ready ticket, and attention only for its current question', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const asked = trigger('2', { actor: guest, channel: { source: 'chat', thread: 't1', address: { message: '2' } } })
    h.engine.receive(asked)
    expect(() => h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Yes' })).toThrow(new UserError('noAnswer'))
    h.engine.report(ticketId, { state: 'progress', summary: 'Yes', answers: '2' })
    expect(h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Yes' })).toMatchObject({ status: 'pending', reused: false })
    expect(h.outbox.at(-1)).toMatchObject({ channel: asked.channel, text: 'Yes', kind: 'reply' })
    expect(h.repo.tickets.get(ticketId)!.answers).toEqual([])
    expect(() => h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toThrow(new UserError('notReady'))
    h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Which color?', askedBy: '2' })
    expect(() => h.engine.reply({ purpose: 'attention', ticketId, question: 'Which size?', text: 'x' })).toThrow(new UserError('notAttention'))
    // 没有未解决的问题就无需提问，无论是否指名了问题。
    const quiet = accepted(h, '9', 't9').ticketId!
    expect(() => h.engine.reply({ purpose: 'attention', ticketId: quiet, text: 'Anything to send.' })).toThrow(new UserError('notAttention'))
    expect(() => h.engine.reply({ purpose: 'attention', ticketId: quiet, question: '', text: 'Anything to send.' })).toThrow(new UserError('notAttention'))
    const attention = h.repo.tickets.get(ticketId)!.attention!
    expect(h.engine.reply({ purpose: 'attention', ticketId, question: 'Which color?', text: 'Which color?' }).id).toBe(key('attention-reply', attention.id))
    // 问题会发到提出它的消息所在的位置。
    expect(h.outbox.at(-1)!.channel).toEqual(asked.channel)
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ status: 'pending' })
    expect(h.outbox.at(-1)!.channel).toEqual(trigger('1').channel)
  })
})
describe('ticket commands', () => {
  it('ends a ticket by the same rule on a close and on a ready report: once no PR it opened is open, as the latest of them ended', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    // 它从别人的 PR 开始，并开启了自己的 PR。
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-5' }, false)
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-7' }, true)
    h.engine.threadClosed({ source: 'gh', id: 'pr-7' }, 'merged', '2026-09-23T00:00:00Z')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // 真人的评论恢复它；其就绪报告又像它自己的 PR 那样结束它，尽管它起始于的那个 PR 仍处于打开状态。
    h.tick(10); h.engine.receive(trigger('2', { threads: [{ source: 'gh', id: 'pr-5' }] })); h.settle()
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
    h.engine.report(ticketId, { state: 'ready', summary: 'Answered' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // 它起始于的 PR 之后关闭不会带来变化。
    h.engine.threadClosed({ source: 'gh', id: 'pr-5' }, 'closed', '2026-09-23T00:00:30Z')
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
    // 未开启任何 PR 的工单，在其关注的 PR 关闭时结束，如同它已经发生的那样。
    const other = accepted(h, '3', 't3').ticketId!
    h.engine.bindThread(other, { source: 'gh', id: 'pr-8' }, false)
    h.engine.report(other, { state: 'ready', summary: 'Pushed to their branch' })
    expect(h.repo.tickets.get(other)).not.toHaveProperty('ended')
    h.engine.threadClosed({ source: 'gh', id: 'pr-8' }, 'closed', '2026-09-23T00:01:00Z')
    expect(h.repo.tickets.get(other)!.ended).toMatchObject({ outcome: 'closed' })
  })
  it('stops following a Thread whose Subscription a person removes', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-7' }, true)
    expect(h.engine.unsubscribe('gh:pr-7')).toBe(true)
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('follows')
    // 它的就绪报告会完成它，因为它现在不再关注任何线程。
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'completed' })
  })
  it('follows a Source\'s Threads, and ends once no Thread of its own is open, unless resumed work has not finished', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const close = (id: string, outcome: 'merged' | 'closed', at: string) => {
      const open = h.repo.tickets.open().map(ticket => ticket.id)
      h.engine.threadClosed({ source: 'gh', id }, outcome, at)
      return open.filter(item => h.repo.tickets.get(item)!.ended)
    }
    expect(h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false)).toMatchObject({ follows: [{ thread: 'gh:pr-9', own: false }] })
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true)
    expect(h.repo.threads.get('gh:pr-9')!.subscriptions).toEqual([ticketId])
    // 它起始于的线程在其自身线程仍打开时关闭：它会记录该关闭并继续工作。
    expect(close('pr-9', 'closed', '2026-09-23T00:00:00Z')).toEqual([])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ follows: [{ thread: 'gh:pr-9', closed: { outcome: 'closed' } }, { thread: 'gh:pr-10' }] })
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('ended')
    // 它自己的也关闭了：它按那次关闭的方式和时点结束，且只结束一次。
    expect(close('pr-10', 'merged', '2026-09-23T00:00:01Z')).toEqual([ticketId])
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-09-23T00:00:01.000Z' } })
    expect(close('pr-10', 'merged', '2026-09-23T00:00:01Z')).toEqual([])
    expect(() => h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-11' }, true)).toThrow(new UserError('ticketEnded'))
    // PR 已关闭但关闭尚未报告时重试的工单会继续工作，直到它报告就绪。
    const other = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(other, { source: 'gh', id: 'pr-12' }, true)
    h.engine.report(other, { state: 'failed', summary: 'tests fail' })
    h.tick(10); h.engine.retryTicket(other)
    expect(close('pr-12', 'closed', '2026-09-23T00:00:05Z')).toEqual([])
    expect(h.repo.tickets.get(other)!.ended).toBeUndefined()
    h.engine.report(other, { state: 'ready', summary: 'done' })
    expect(h.repo.tickets.get(other)).toMatchObject({ ended: { outcome: 'closed' } })
  })

  it('retries a ticket that reported failed with a new Assignment, and asks only a waiting worker for its status', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    expect(() => h.engine.retryTicket(ticketId)).toThrow(new UserError('notRetryable'))
    expect(h.engine.requestStatus(ticketId)).toBe(false)
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual([])
    h.engine.report(ticketId, { state: 'waiting', summary: 'idle' })
    expect(h.engine.requestStatus(ticketId)).toBe(true)
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('status-only') })])
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    const retried = h.engine.retryTicket(ticketId)
    expect(retried.assignments).toEqual([expect.objectContaining({ state: 'ended', endedReason: 'retried' }), expect.objectContaining({ state: 'pending' })])
    expect(h.executor.stop).toHaveBeenCalledOnce()
    expect(h.executor.start).toHaveBeenLastCalledWith(expect.objectContaining({ id: ticketId }), retried.assignments[1])
  })
})
describe('failed deliveries', () => {
  it('forgets a failed delivery once a new Assignment takes over or the ticket ends', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const failed = () => {
      h.engine.deliveryFailed(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id, 'Session busy')
      expect(h.repo.tickets.get(ticketId)!.delivery).toMatchObject({ error: 'Session busy' })
    }
    failed()
    h.engine.report(ticketId, { state: 'blocked', summary: 'needs access' })
    h.engine.retryTicket(ticketId); h.settle()
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
    failed()
    h.engine.stopTicket(ticketId)
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty('delivery')
  })
})
describe('problems', () => {
  it('dismisses the problem an unavailable Decision shows, and only such a Decision', () => {
    const h = harness()
    const decision = accepted(h)
    expect(() => h.engine.dismiss(decision.id)).toThrow(new UserError('unknownProblem'))
    h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] })); h.pump()
    const unavailable = h.decide(h.requests.at(-1)!, { kind: 'unavailable', reason: 'model down' })
    expect(h.engine.dismiss(unavailable.id)).toMatchObject({ kind: 'unavailable', dismissed: true })
    expect(h.repo.decisions.get(unavailable.id)).toMatchObject({ dismissed: true })
  })
})
describe('retry after a failed delivery', () => {
  it('starts a new Assignment for a ticket whose Input keeps failing to reach its worker, which takes the Input', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'tests fail' })
    // 真人的答复会发给失败的执行器，而投递它失败了。
    h.tick(5); h.engine.receive(trigger('2'))
    const answered = h.repo.tickets.get(ticketId)!
    expect(answered.undelivered).toHaveLength(1)
    h.engine.deliveryFailed(ticketId, runningAssignment(answered)!.id, 'Session gone')
    expect(ticketStage(h.repo.tickets.get(ticketId)!)).toEqual({ stage: 'person', action: 'delivery' })
    const retried = h.engine.retryTicket(ticketId)
    expect(retried.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
    expect(retried).not.toHaveProperty('delivery')
    expect(retried.undelivered).toHaveLength(1)
  })
})
describe('Evals across Policy versions, revoked Mandates and mixed batches', () => {
  it('queues an Eval\'s batch again when it is decided under an older Policy, such as after an upgrade changed the version', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const candidate = h.requests.at(-1)!
    // 升级会改变版本，但不会报告策略变更。
    h.setVersion('v2')
    expect(h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'r' })).toMatchObject({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })
    expect(h.repo.threads.get('chat:t1')).toMatchObject({ pending: ['1'] })
    h.pump()
    expect(h.requests.at(-1)).toMatchObject({ policyVersion: 'v2', triggers: [expect.objectContaining({ id: '1' })] })
  })
  it('queues a person\'s message for Eval when the only ticket it reached cannot resume under the Policy now, and says it reached none', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' }); h.settle()
    h.setVersion('revoked')
    h.tick(5); h.engine.receive(trigger('2'))
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], ended: expect.anything() })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
    expect(followupOwners(trigger('2'), h.repo)).toEqual([])
  })
  it('queues a person\'s message that waited out a pause for Eval when the ticket it reached cannot resume once the pause lifts', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' }); h.settle()
    h.setPaused(true)
    h.tick(5); h.engine.receive(trigger('2')); h.pump()
    expect(h.repo.tickets.get(ticketId)!.undelivered).toHaveLength(1)
    h.setVersion('revoked'); h.setPaused(false); h.engine.evaluateDue()
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], ended: expect.anything() })
    expect(h.repo.threads.get('chat:t1')!.pending.includes('2') || h.engine.candidate('2') !== undefined).toBe(true)
  })
  it('takes a new ticket\'s origin and acknowledgement from the admissible Trigger that gave its batch its strength', () => {
    const h = harness()
    h.engine.receive(trigger('1'))
    h.tick(1); h.engine.receive(trigger('2', { human: false, actor: { source: 'chat', id: 'ci-bot' }, channel: { source: 'chat', thread: 'chat:t1', address: { message: 'bot' } } }))
    h.pump()
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(['1', '2'])
    const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'r', acknowledgement: 'ok' })
    expect(h.repo.tickets.get(decision.ticketId!)!.origin).toEqual({ triggerId: '1', triggerIds: ['1', '2'] })
    expect(h.outbox).toEqual([expect.objectContaining({ id: key('ack', '1'), channel: trigger('1').channel })])
  })
})
describe('gaps', () => {
  it('takes a mixed batch\'s strength, actor and basis from its strongest admissible Trigger, the latest of equal strength', () => {
    // 访客的消息按推断强度被接纳，就像在工单关注的线程上一样。
    const gate: Policy['gate'] = t => t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'addressed' as const, addressed: 'mention' as const } }
      : { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
    for (const order of [['guest', 'alice'], ['alice', 'guest']]) {
      const h = harness({ gate })
      order.forEach((who, index) => { h.tick(1); h.engine.receive(trigger(String(10 + index), { actor: who === 'alice' ? member : guest })) })
      h.pump()
      const alice = String(10 + order.indexOf('alice'))
      expect(h.repo.threads.get('chat:t1')!.evaluating).toMatchObject({ strength: 'explicit', actor: member, basis: { via: 'addressed' as const, addressed: 'mention' as const }, primary: alice })
    }
    const named = harness({ gate: t => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed' as const, addressed: 'mention' as const, sender: t.actor.id } }) })
    named.engine.receive(trigger('1', { actor: { source: 'chat', id: 'bob' } }))
    named.tick(1); named.engine.receive(trigger('2', { actor: { source: 'chat', id: 'carol' } }))
    named.pump()
    expect(named.repo.threads.get('chat:t1')!.evaluating).toMatchObject({ actor: { id: 'carol' }, basis: { sender: 'carol' }, primary: '2' })
  })
  it('changes nothing and delivers nothing on a late start of an Assignment a retry replaced', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const first = h.repo.tickets.get(ticketId)!.assignments[0]!.id
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    h.engine.retryTicket(ticketId)
    const before = h.repo.tickets.get(ticketId)!
    const delivered = h.delivered.length
    h.engine.assignmentStarted(ticketId, first); h.settle({ launch: false })
    expect(h.repo.tickets.get(ticketId)!.assignments).toEqual(before.assignments)
    expect(h.delivered).toHaveLength(delivered)
  })
  it('records a stop that names an unknown or ended ticket as ignored', () => {
    const h = harness()
    const ended = accepted(h).ticketId!
    h.engine.report(ended, { state: 'ready', summary: 'Done' })
    for (const [id, ticketId] of [['2', 'missing'], ['3', ended]] as const) {
      h.tick(1); h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: `t${id}` }] })); h.pump()
      expect(h.decide(h.requests.at(-1)!, { kind: 'stop', ticketId, reason: 'stop it' })).toMatchObject({ kind: 'ignore', reason: [{ code: 'stopUnknown' }] })
    }
    expect(h.repo.tickets.get(ended)!.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  })
  it('refuses a direct decision on a Trigger the gate does not admit, and leaves the queue as it was', () => {
    const h = harness()
    h.engine.receive(trigger('1', { human: false }))
    const pending = h.repo.threads.get('chat:t1')!.pending
    expect(() => h.engine.decide('1', { kind: 'ignore', reason: 'noise' })).toThrow(new UserError('notAdmissible', { reason: 'not human' }))
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(pending)
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
  it('refuses to retry a ticket a person stopped after its failed report', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'failed', summary: 'broke' })
    h.engine.stopTicket(ticketId)
    expect(() => h.engine.retryTicket(ticketId)).toThrow(new UserError('notRetryable'))
  })
  it('answers a question once, sends a result only for finished work, and the same result once', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.report(ticketId, { state: 'progress', summary: 'It reads the config.', answers: '2' })
    expect(h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'It reads the config.' })).toMatchObject({ reused: false })
    expect(() => h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Something else.' })).toThrow(new UserError('noAnswer'))
    expect(() => h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toThrow(new UserError('notReady'))
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    const sent = h.outbox.length
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ reused: false })
    expect(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' })).toMatchObject({ reused: true })
    expect(h.outbox).toHaveLength(sent + 1)
    // PR 未合并即关闭、或被人停止的工单，没有结果可发送。
    const closed = accepted(h, '5', 't5').ticketId!
    h.engine.bindThread(closed, { source: 'gh', id: 'pr-1' }, true)
    h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'closed', '2026-09-23T00:01:00Z')
    expect(() => h.engine.reply({ purpose: 'result', ticketId: closed, text: 'x' })).toThrow(new UserError('notReady'))
    const stopped = accepted(h, '6', 't6').ticketId!
    h.engine.stopTicket(stopped)
    expect(() => h.engine.reply({ purpose: 'result', ticketId: stopped, text: 'x' })).toThrow(new UserError('notReady'))
  })
  it('keeps an Eval\'s deadline on a repeated delivery, refuses to queue a held Trigger again, and puts expired Triggers first', () => {
    const h = harness()
    h.engine.receive(trigger('1')); h.pump()
    const evalId = h.requests[0]!.evalId
    h.engine.candidateDelivered(evalId)
    const deadline = h.repo.threads.get('chat:t1')!.evaluating!.deadline
    h.tick(30); h.engine.candidateDelivered(evalId)
    expect(h.repo.threads.get('chat:t1')!.evaluating!.deadline).toBe(deadline)
    expect(h.engine.reevaluate('1')).toBe(false)
    // 此间到达的触发器排在过期触发器之后，新的评估按该顺序接收两者。
    h.tick(1); h.engine.receive(trigger('2', { actor: guest }))
    h.tick(30); h.engine.evaluateDue()
    expect(h.repo.threads.get('chat:t1')!.evaluating!.triggerIds).toEqual(['1', '2'])
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
  })
})
describe('final review', () => {
  it('ignores an Eval an earlier version left holding only a Trigger that started a ticket, instead of recording it unavailable', () => {
    const h = harness()
    const decision = accepted(h)
    // 旧版本可能在评估启动工单后仍让它持有触发器。
    const thread = h.repo.threads.get('chat:t1')!
    h.repo.threads.save({ ...thread, evaluating: { id: 'old-eval', threadKey: 'chat:t1', triggerIds: ['1'], primary: '1', strength: 'explicit', actor: member,
      basis: { via: 'addressed' as const, addressed: 'mention' as const }, policyVersion: 'v1', startedAt: '', deadline: '2999-01-01T00:00:00.000Z' } })
    expect(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'replayed' })).toEqual(decision)
    expect(h.repo.decisions.byThread('chat:t1').at(-1)).toMatchObject({ kind: 'ignore', reason: [{ code: 'startedTicket', triggerId: '1',
      values: { ticket: decision.ticketId } }] })
    expect(h.repo.decisions.byThread('chat:t1').some(item => item.kind === 'unavailable')).toBe(false)
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('evaluating')
  })
  it('clears the count of expired Evals when the gate ignores what a Thread queued', () => {
    const h = harness()
    h.engine.receive(trigger('1', { human: false }))
    h.repo.threads.save({ ...h.repo.threads.get('chat:t1')!, expired: 1 })
    h.pump()
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([expect.objectContaining({ kind: 'ignore' })])
    expect(h.repo.threads.get('chat:t1')).not.toHaveProperty('expired')
  })
})
describe('final review: Policy transitions', () => {
  it('tells a worker of each Policy change that bears on its ticket, also of one that repeats an earlier transition', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const effect = { requesterAllowed: false as const }
    for (const [from, to] of [['A', 'B'], ['B', 'A'], ['A', 'B']]) { h.tick(1); h.engine.policyChanged(from!, to!, new Map([[ticketId, effect]])) }
    expect(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'policy-changed')).toHaveLength(3)
  })
})
describe('final review: Threads followed for context', () => {
  it('lets a worker acknowledge or ask no one on a Thread it follows only for context', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.followForContext(ticketId, { source: 'chat', id: 'side' })
    h.tick(1); h.engine.receive(trigger('5', { threads: [{ source: 'chat', id: 'side' }], channel: { source: 'chat', thread: 'side', address: { message: '5' } } }))
    expect(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '5', text: 'On it' })).toThrow(new UserError('notReached'))
    expect(() => h.engine.report(ticketId, { state: 'progress', summary: 'A question', question: 'Which page?', askedBy: '5' })).toThrow(new UserError('notAsker'))
  })
})
describe('final review: close times', () => {
  it('records a Source\'s close time in the canonical form, and keeps the ticket\'s updatedAt moving forward', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-1' }, true)
    h.tick(30)
    const before = h.repo.tickets.get(ticketId)!.updatedAt
    // GitHub 只精确到整秒，且 PR 在工单最后一次改动之前就已合并。
    h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'merged', '2026-09-23T00:00:05Z')
    const ended = h.repo.tickets.get(ticketId)!
    expect(ended.ended).toMatchObject({ at: '2026-09-23T00:00:05.000Z', outcome: 'merged' })
    expect(ended.follows).toEqual([{ thread: 'gh:pr-1', own: true, closed: { at: '2026-09-23T00:00:05.000Z', outcome: 'merged' } }])
    expect(ended.updatedAt >= before).toBe(true)
  })
})
describe('model-surface review', () => {
  it('resumes an ended ticket only on a person\'s message, not on a bot\'s that is attached to it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'Done' })
    h.tick(1); h.engine.receive(trigger('2', { human: false, actor: { source: 'chat', id: 'ci' }, threads: [{ source: 'chat', id: 'ci' }] }))
    h.engine.attach(ticketId, '2')
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined()
    // 真人的消息连同等待的内容一起恢复它。
    h.tick(1); h.engine.receive(trigger('3'))
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
})
describe('follow-up review: turn ends', () => {
  const merge = (h: ReturnType<typeof harness>) => h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
  it('lets a merge send to Eval only the messages its worker had no turn to read after its ready report', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    // 真人向执行器致谢，执行器在一轮中读取后搁置；该轮之后又来了另一条消息。
    h.tick(1); h.engine.receive(trigger('2')); h.settle(); h.read(ticketId)
    h.tick(1); h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id)
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    merge(h)
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('keeps a ticket open at a merge while its worker works on a message it took up, also after a progress report', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    // 它在处理该消息的同时，在进度报告中回答了另一个问题。
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Answered the other question' })
    merge(h)
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })
  it('ends a ticket whose close it deferred as the close did when its worker then drops the work', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' })
    merge(h)
    h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing more to do' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'merged' })
  })
  it('sends a message another ticket handed back to Eval when a stop on it ends the ticket that kept it', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(second, { source: 'chat', id: 't1' }, false)
    h.engine.receive(trigger('3')); h.settle()
    expect(h.engine.handback(second, '3', 'It is about the first fix')).toBe(false)
    h.engine.decide('3', { kind: 'stop', ticketId: first, reason: 'asked to stop' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['3'])
  })
  it('gives a live ticket\'s worker again a message it had that a person sent to Eval and the main Session attached back', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.engine.reevaluate('2'); h.pump()
    h.engine.attach(ticketId, '2')
    expect(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === '2')).toHaveLength(2)
  })
})
describe('follow-up review: turn ends and deliveries', () => {
  it('lets a stop send to Eval a message that waited for delivery when a turn ended, and reached the worker after', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'progress', summary: 'working' })
    h.tick(1); h.engine.receive(trigger('2'))
    const ticket = () => h.repo.tickets.get(ticketId)!, assignmentId = runningAssignment(ticket())!.id
    const [inputId] = ticket().undelivered
    // 消息正在投递途中时该轮结束；它随后到达执行器，而真人在该轮中停止了工单。
    h.tick(1); h.engine.turnEnded(ticketId, assignmentId)
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [inputId!])
    h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
})
describe('follow-up review: delivery times', () => {
  it('lets a stop send to Eval a message that came before the worker\'s waiting report but reached the worker after it', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2'))
    const ticket = () => h.repo.tickets.get(ticketId)!, assignmentId = runningAssignment(ticket())!.id
    const [inputId] = ticket().undelivered
    // 消息在途中时，执行器上报的状态为等待；消息随后到达执行器，而真人在此期间停止了它。
    h.tick(1); h.engine.report(ticketId, { state: 'waiting', summary: 'Waiting for input' })
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [inputId!])
    h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
})
describe('routing review', () => {
  it('records two stops of one follow-up that reached two tickets, made in the same moment, as two Decisions', () => {
    const h = harness()
    const first = accepted(h).ticketId!
    const second = accepted(h, '2', 't2').ticketId!
    h.engine.bindThread(second, { source: 'chat', id: 't1' }, false)
    h.engine.receive(trigger('3')); h.settle()
    const stops = [first, second].map(ticketId => h.engine.decide('3', { kind: 'stop', ticketId, reason: 'asked to stop' }))
    expect(new Set(stops.map(stop => stop.id)).size).toBe(2)
    expect(stops.map(stop => h.repo.decisions.get(stop.id)?.ticketId)).toEqual([first, second])
    expect([first, second].map(id => h.repo.tickets.get(id)!.ended?.outcome)).toEqual(['stopped', 'stopped'])
  })
})

describe('what a worker read', () => {
  /** 一个已结束的工单，被真人的消息 `2` 恢复，其新任务已启动；它的输入等待投递。 */
  function resumed() {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.report(ticketId, { state: 'ready', summary: 'done' })
    h.tick(1); h.engine.receive(trigger('2'))
    const assignmentId = h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id
    h.tick(1); h.engine.assignmentStarted(ticketId, assignmentId)
    const [note, message] = h.repo.tickets.get(ticketId)!.undelivered as [string, string]
    return { h, ticketId, assignmentId, note, message, pending: () => h.repo.threads.get('chat:t1')!.pending }
  }
  it('sends to Eval a message that woke a ticket and reached its worker only after a progress report, at a dropped report', () => {
    const { h, ticketId, assignmentId, note, message, pending } = resumed()
    // 该消息的投递起初失败；执行器报告进度，重试在它写下已无剩余内容时把消息交了出去。
    h.engine.inputsDelivered(ticketId, assignmentId, [note])
    h.engine.deliveryFailed(ticketId, assignmentId, 'Session busy')
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Looking' })
    h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [message])
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
    expect(pending()).toEqual(['2'])
  })
  it('counts a message that woke a ticket as read by a later dropped report once its worker\'s Session took it into a step', () => {
    const { h, ticketId, assignmentId, note, message, pending } = resumed()
    // 会话在消息到达所开启的那一步中接收它，早于执行器记录投递。
    h.engine.inputsRead(ticketId, [message])
    h.engine.inputsDelivered(ticketId, assignmentId, [note, message])
    h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Looking' })
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
    expect(pending()).toEqual([])
  })
  it('sends to Eval at a merge a message that reached the worker after its last step, which no step took before its turn ended', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true)
    h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' })
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id)
    h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z')
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
  })
  it('counts a message a retry delivered after a failure and a turn end as read by a dropped report only once a step took it', () => {
    for (const taken of [false, true]) {
      const { h, ticketId, assignmentId, note, message, pending } = resumed()
      h.engine.inputsDelivered(ticketId, assignmentId, [note])
      h.engine.deliveryFailed(ticketId, assignmentId, 'Session busy')
      h.tick(1); h.engine.turnEnded(ticketId, assignmentId)
      h.tick(1); h.engine.inputsDelivered(ticketId, assignmentId, [message])
      if (taken) h.read(ticketId)
      h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' })
      expect(pending()).toEqual(taken ? [] : ['2'])
    }
  })
  it('counts a message a step took before a restart cut its turn off as read only once the restarted worker reports', () => {
    for (const reported of [false, true]) {
      const h = harness()
      const ticketId = accepted(h).ticketId!
      h.engine.report(ticketId, { state: 'progress', summary: 'working' })
      h.tick(1); h.engine.receive(trigger('2')); h.settle(); h.read(ticketId)
      // 任务在同一个会话中以恢复备注重新启动，该会话持有该消息。
      h.tick(1); h.engine.assignmentInterrupted(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id); h.settle()
      if (reported) { h.tick(1); h.engine.report(ticketId, { state: 'progress', summary: 'Recovered' }) }
      h.tick(1); h.engine.stopTicket(ticketId, 'not needed')
      expect(h.repo.threads.get('chat:t1')!.pending).toEqual(reported ? [] : ['2'])
    }
  })
})
describe('read claims review', () => {
  it('gives a retry\'s Assignment the messages the failed one had delivered but no step of its worker took', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputId = ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === '2')!.id
    expect(ticket().undelivered).toEqual([])
    h.tick(1); h.engine.report(ticketId, { state: 'failed', summary: 'The turn broke.' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputId])
  })
})
describe('read claims review: retries', () => {
  it('gives a retry only what the Assignment it replaces had delivered and no step took, not what an earlier end let go of', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputOf = (triggerId: string) => ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id
    // 后续消息到达执行器，而工单在任何步骤接手它之前就结束了，于是它被送入评估。
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' })
    expect(h.repo.threads.get('chat:t1')!.pending).toEqual(['2'])
    // 真人的消息恢复了工单；其执行器在任何步骤接手该消息之前报告受阻，真人随后重试。
    h.tick(1); h.engine.receive(trigger('3')); h.settle()
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'Which page?' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputOf('3')])
  })
})
describe('read claims review: restarts', () => {
  it('gives a restart\'s Assignment what the replaced one had delivered and no step took, and a retry of it gets it again', () => {
    const h = harness()
    const ticketId = accepted(h).ticketId!
    const ticket = () => h.repo.tickets.get(ticketId)!
    const inputOf = (triggerId: string) => ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id
    h.tick(1); h.engine.receive(trigger('2')); h.settle()
    // 宿主在步骤接手该消息之前的工作中途重启，取消可能已丢弃该消息：新任务会收到它。
    h.tick(1); h.engine.assignmentInterrupted(ticketId, runningAssignment(ticket())!.id)
    expect(ticket().undelivered[0]).toBe(inputOf('2'))
    h.settle()
    // 该任务在步骤接手它之前受阻，真人重试：重试的任务也会收到它。
    h.tick(1); h.engine.report(ticketId, { state: 'blocked', summary: 'Which page?' })
    h.tick(1); h.engine.retryTicket(ticketId)
    expect(ticket().undelivered).toEqual([inputOf('2')])
  })
})
describe('ignores from the card', () => {
  const said = (text: string) => ({ code: 'said', values: { text } })
  it('marks the ignore of an inferred candidate that no assessment judged, unlike an assessed one or an explicit candidate\'s', () => {
    const h = harness()
    accepted(h)
    // 被送入评估的访客消息是推断候选，主会话从卡片上忽略它。
    h.engine.receive(trigger('2', { actor: guest })); h.engine.reevaluate('2'); h.pump()
    expect(h.requests.at(-1)).toMatchObject({ strength: 'inferred' })
    expect(h.engine.decide('2', { kind: 'ignore', reason: 'Plain chat.' }).reason).toEqual([{ code: 'ignoredFromCard' }, said('Plain chat.')])
    // 评估的忽略会保留其规则判定，但不带标记。
    h.engine.receive(trigger('3', { actor: guest })); h.engine.reevaluate('3'); h.pump()
    expect(h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'Plain chat.', audit: { rule_assessments: [] } }))
      .toMatchObject({ reason: [said('Plain chat.')], audit: { rule_assessments: [] } })
    // 显式候选总是从卡片上路由。
    h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 't9' }] })); h.pump()
    expect(h.engine.decide('4', { kind: 'ignore', reason: 'Thanks.' }).reason).toEqual([said('Thanks.')])
    // 接受推断候选仍会采用评估中匹配到的规则。
    h.engine.receive(trigger('5', { actor: guest })); h.engine.reevaluate('5'); h.pump()
    expect(() => h.engine.decide('5', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'chat' })).toThrow(new UserError('notExplicit'))
  })
})
