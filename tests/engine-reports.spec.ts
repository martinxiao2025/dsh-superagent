import { describe, expect, it, vi } from 'vitest'
import { UserError, followupOwners, key, runningAssignment, ticketOutcome, ticketStage, waitsForPerson } from '../src/core/index.ts'
import type { Policy, Trigger, Ticket, Assignment, Outcome } from '../src/core/index.ts'
import { member, guest, trigger, harness, accepted } from './fixtures/engine.ts'
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
