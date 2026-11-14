/**
 * 工单生命周期（从 runtime.spec.ts 拆出）：在模拟 DeepSeek Harness 宿主上通过工具和 HTTP 运行整个应用——
 * 明确提及的候选与接受、工单的执行环境与派工、跟进消息的分发、worker 报告与结束、
 * 人的停止与恢复、orchestrator_route 的附加与拒绝、重启后的恢复派工、
 * 管理页阅读模型、Executor 丢弃线程、提问的位置、等待人的工单与 IM 字数上限。
 */
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { key, threadKey } from '../src/core/index.ts'
import { IM_WORDS } from '../src/infra/text.ts'
import { ticketList } from '../src/app/views/tickets.ts'
import { runtimeHost } from './fixtures/runtime-host.ts'

const h = runtimeHost()
const { runTool, subscribe, receive, relays, feishu, route, acceptedTicket, viewsOf, MEMBER, CHAT, worktreeName } = h
it('relays an explicit member mention as a candidate and creates the ticket, acknowledgement, subscription and worker on accept', async () => {
  const { trigger, ticket, sessionId } = await acceptedTicket()
  const candidate = relays(h.runtime.masterId).find(item => item.kind === 'candidate')!
  expect(candidate).toMatchObject({ strength: 'explicit', trigger_id: trigger.id, next_action: 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.' })
  expect(ticket).toMatchObject({ title: '修复回归', mandate: { strength: 'explicit', basis: expect.objectContaining({ via: 'addressed', source: 'feishu', sender: 'Alice', addressed: 'mention', scope: expect.objectContaining({ chatId: CHAT }) }) },
    execution: expect.objectContaining({ name: expect.stringMatching(/^fix-regression-/) }), origin: expect.objectContaining({ triggerId: trigger.id }) })
  expect(ticket).not.toHaveProperty('ended')
  // 工单的执行环境在接受时固定：执行目录为来源记录的项目目录下按工单 id 命名的子目录（飞书没有项目标识，退回记录 ID），来源值来自其触发器。
  expect(ticket.execution!.project).toBe('feishu')
  expect(ticket.execution!.directory).toBe(join(h.directory, 'work', 'feishu', ticket.id))
  expect(Object.fromEntries(h.runtime.ticketEnvironment(ticket).map(variable => [variable.key, variable.value]))).toMatchObject({ DSH_SUPERAGENT_DIR: ticket.execution!.directory, DSH_SUPERAGENT_NAME: ticket.execution!.name, DSH_SUPERAGENT_TICKET: ticket.id, DSH_SUPERAGENT_SOURCE: 'feishu', DSH_SUPERAGENT_FEISHU_CHAT: CHAT })
  expect(ticket.assignments).toEqual([expect.objectContaining({ state: 'running', startedAt: expect.any(String) })])
  expect(sessionId).toBe(`worker-${ticket.id}`)
  expect(h.runtime.store.threads.get(`feishu:${CHAT}:om_1`)?.subscriptions).toEqual([ticket.id])
  expect(h.runtime.store.replyStatus(key('ack', trigger.id))).toBe('sent')
  const larkCalls = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args)
  expect(larkCalls.find(args => args[1] === '+messages-reply')).toEqual(expect.arrayContaining(['--message-id', 'om_1', '--markdown', '收到，修复回归。']))
  // 第一条消息承载请求本身：明确工单除它之外没有派工文本，也没有需要先读取的内容。
  const first = relays(sessionId)[0]!
  expect(first).toEqual({ ticket_id: ticket.id, title: '修复回归', trigger: expect.objectContaining({ trigger_id: trigger.id, from: MEMBER,
    thread: `feishu:${CHAT}:om_1`, text: trigger.text }) })
  expect(first.trigger).not.toHaveProperty('read')
  expect(await route({ kind: 'accept', trigger_id: trigger.id, title: 'again', worktree_name: worktreeName, acknowledgement: 'x' })).toMatchObject({ ticket: { ticket_id: ticket.id } })
})

it('fans a person\'s later thread message out to the live worker as context and tells the orchestrator, without an Eval', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  h.deliveries.mockClear()
  const followup = feishu('2', '顺便看看日志', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })
  await receive(followup)
  const worker = relays(sessionId)
  expect(worker).toHaveLength(1)
  expect(worker[0]).toMatchObject({ trigger_id: followup.id, from: 'ou_guest', text: '顺便看看日志' })
  expect(worker[0]).not.toHaveProperty('read')
  // 其资源的渲染相同，来自工单；不存储其正文。
  const resource = `ticket/${ticket.id}/input/${key(h.runtime.store.tickets.get(ticket.id)!.inputs[0]!.id)}`
  expect(JSON.parse(((await runTool(sessionId, 'orchestrator_read', { resource })) as { text: string }).text)).toEqual(worker[0])
  expect(h.runtime.store.get(resource)).toBeUndefined()
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'trigger', triggerId: followup.id })])
  expect(relays(h.runtime.masterId)).toEqual([{ kind: 'follow_up', trigger_id: followup.id, from: 'ou_guest', thread: `feishu:${CHAT}:om_1`,
    at: followup.at, text: '顺便看看日志', delivered_to: [{ ticket_id: ticket.id, title: '修复回归', state: 'working' }],
      note: expect.stringContaining('worker has it and decides') }])
  expect(h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_1`).map(decision => decision.triggerIds)).toEqual([[ticket.origin.triggerId]])
  expect(await runTool(sessionId, 'orchestrator_read', { resource: `trigger/${followup.id}` }))
    .toMatchObject({ trigger_id: followup.id, around: { before: expect.objectContaining({ read: `trigger/${key('feishu', 'om_1')}` }) } })
})

it('records worker reports, relays attention, and ends the ticket on ready', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  h.deliveries.mockClear()
  expect(await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'started' })).toMatchObject({ notification: 'internal_only' })
  expect(relays(h.runtime.masterId)).toEqual([])
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'need a decision', human_action: 'Desktop too?' })
  expect(h.runtime.store.tickets.get(ticket.id)!.attention).toMatchObject({ question: 'Desktop too?' })
  expect(relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_attention', ticket: { ticket_id: ticket.id, attention: { question: 'Desktop too?' } } })
  await expect(runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'other', text: 'x' })).rejects.toThrow('current attention question')
  expect(await runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'Desktop too?', text: '要不要也改桌面端？' })).toEqual({ status: 'sent' })
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'working', human_action: null })
  expect(h.runtime.store.tickets.get(ticket.id)!.attention).toBeUndefined()
  await runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'reviewed' })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
  expect(relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state: 'ready' })
  expect(await runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: '已完成修改。' })).toEqual({ status: 'sent' })
})

it('lists each ticket with the Threads it subscribes to, as their Sources describe them', async () => {
  const { ticket } = await acceptedTicket()
  subscribe(ticket.id, { source: 'github', id: '42' })
  const line = () => ticketList(viewsOf(h.runtime), 'working', 0, 20).items.find(item => item.id === ticket.id)!
  h.runtime.store.threads.describe('github:42', { label: '#42 Fix the margin', facts: { number: { value: '#42' }, ci: { label: 'CI', value: { zh: '通过', en: 'passed' } } } })
  expect(line().threads).toContainEqual(expect.objectContaining({ key: 'github:42', source: 'github', title: '#42 Fix the margin', facts: { number: { value: '#42' }, ci: { label: 'CI', value: { zh: '通过', en: 'passed' } } } }))
  h.runtime.store.threads.describe('github:42', { facts: { ci: null } })
  expect(line().threads.find(thread => thread.key === 'github:42')!.facts).toEqual({ number: { value: '#42' } })
})

it('ends a ticket on ready when no PR is bound', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done locally' })
  expect(h.runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: expect.objectContaining({ outcome: 'completed' }) })
  await expect(runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'late' })).rejects.toThrow('Ticket ended')
})

it('stops a ticket on a person\'s instruction for good, and resumes an ended one on any person\'s message on its thread', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const request = feishu('5', '@bot 停下，不用修了', { root_id: 'om_1' })
  await receive(request)
  expect(await route({ kind: 'stop', ticket_id: ticket.id, trigger_id: request.id }))
    .toMatchObject({ decision: 'stop', reason: 'Human asked to stop', ticket: { ticket_id: ticket.id, state: 'stopped' } })
  // 结束说明这是人的一次停止：没有重复结果的 reason，也没有复制到派工上。
  const stopped = h.runtime.store.tickets.get(ticket.id)!
  expect(stopped.ended).toEqual({ at: expect.any(String), by: 'human', outcome: 'stopped' })
  expect(stopped.assignments[0]).not.toHaveProperty('endedReason')
  expect(h.agents.get(sessionId)!.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  // 停止会撤回授权：之后的消息作为上下文等待，只有新的工作才会重启它。
  const guest = feishu('6', '继续吧', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })
  await receive(guest)
  await h.runtime.pump()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
  await expect(route({ kind: 'attach', ticket_id: ticket.id, trigger_id: guest.id })).rejects.toThrow('stopped')
  // 自行结束的工单会在其线程上有人发消息时恢复，无论发送者是谁。
  const other = await acceptedTicket(feishu('20', '@bot 修另一个'))
  await runTool(other.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'not reproduced' })
  expect(h.runtime.store.tickets.get(other.ticket.id)!.ended).toBeDefined()
  await receive(feishu('21', '我这边还能复现', { mentions: [], root_id: 'om_20', sender_id: 'ou_guest' }))
  await h.runtime.pump()
  const resumed = h.runtime.store.tickets.get(other.ticket.id)!
  expect(resumed.ended).toBeUndefined()
  expect(resumed.assignments).toHaveLength(2)
  expect(resumed.inputs.map(input => input.kind)).toContain('resumed')
})

it('tells live workers about policy changes instead of revoking them and restarts in-flight assessments', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const pending = feishu('8', '新观察', { mentions: [], sender_id: MEMBER, root_id: undefined })
  await receive(pending)
  expect(h.runtime.store.threads.get(`feishu:${CHAT}:om_8`)?.evaluating).toBeDefined()
  h.deliveries.mockClear()
  const settings = h.runtime.store.settings()
  const result = await h.runtime.settings.save('policy', { ...settings.policy, rules: settings.policy.rules.map(rule => ({ ...rule, enabled: rule.id === 'copy' })) }, h.runtime.store.blockRevision('policy'), 'panel')
  await h.runtime.idle()
  expect(result).toMatchObject({ saved: true, policy_changed: true })
  // 规则变了，但并未影响这个明确工单（其请求者仍在名单中）：worker 不会被唤醒。
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs).toEqual([])
  expect(relays(sessionId)).toEqual([])
  // 其请求者被移出允许名单：worker 会收到内联告知，工单继续。
  const current = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...current, sources: { ...current.sources, feishu: { ...current.sources.feishu!, allowed: [] } } },
    h.runtime.store.blockRevision('policy'), 'panel')
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'policy-changed',
    effect: { requesterAllowed: false, requester: { source: 'feishu', id: MEMBER } } })])
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(relays(sessionId)).toEqual([{ text: expect.stringContaining('may no longer start work') }])
  expect(h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_8`)[0]).toMatchObject({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })
  expect(relays(h.runtime.masterId).filter(item => item.kind === 'candidate' && item.trigger_id === pending.id)).toHaveLength(1)
})

it('attaches an event to an existing open task through orchestrator_route', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const other = feishu('9', '@bot 顺手把这里也改了', { root_id: undefined })
  await receive(other)
  h.deliveries.mockClear()
  expect(await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id, note: '同一个页面' })).toMatchObject({ ticket: { ticket_id: ticket.id } })
  expect(h.runtime.store.threads.get(`feishu:${CHAT}:om_9`)?.subscriptions).toEqual([ticket.id])
  expect(h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_9`)).toEqual([expect.objectContaining({ kind: 'ignore', reason: [{ code: 'routed', values: { ticket: ticket.id } }] })])
  expect(relays(sessionId)[0]).toMatchObject({ trigger_id: other.id, text: '@bot 顺手把这里也改了', routing_note: '同一个页面' })
})

it('acknowledges a follow-up from the worker once and rejects events outside the task', async () => {
  const { sessionId, ticket } = await acceptedTicket()
  const followup = feishu('10', '还有这个', { mentions: [], root_id: 'om_1' })
  await receive(followup)
  expect(await runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id, text: '收到，也处理这个。' })).toMatchObject({ acknowledgement: 'sent', reused: false })
  expect(await runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id, text: '不同措辞' })).toMatchObject({ reused: true })
  const stranger = feishu('11', '无关', { mentions: [], root_id: undefined })
  await receive(stranger)
  await expect(runTool(sessionId, 'orchestrator_ack', { trigger_id: stranger.id, text: 'x' })).rejects.toThrow('does not belong')
  expect(h.runtime.store.tickets.get(ticket.id)!.inputs.map(input => input.kind)).toEqual(['trigger'])
})

it('relaunches running assignments after a restart with a recovery note', async () => {
  const { ticket } = await acceptedTicket()
  h.runtime.executor.resume()
  const recovered = h.runtime.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
  h.deliveries.mockClear()
  await h.runtime.pump()
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments[1]).toMatchObject({ state: 'running' })
  // 新派工的消息只说明新增内容，因为会话已保存第一条；启动自身的轮次会按所读取的内容投递
  // 恢复说明。
  expect(relays(`worker-${ticket.id}`)).toEqual([{ ticket_id: ticket.id, assignment: 2 }, { text: expect.stringContaining('host restarted') }])
})

it('lets an Executor drop only its own ticket from a thread it finds unrelated, but not the thread it started on or its pull request\'s', async () => {
  const { ticket, trigger, sessionId } = await acceptedTicket()
  const other = await acceptedTicket(feishu('5', '@bot 另一件事'))
  // 一个已附加的线程，后来发现是关于另一件事的，另一个工单也跟随它。
  const attached = { source: 'feishu', id: 'oc_side:om_side' }
  subscribe(ticket.id, attached); subscribe(other.ticket.id, attached)
  const inject = h.agents.get(h.runtime.masterId)!.inject
  vi.mocked(inject).mockClear()
  expect(await runTool(sessionId, 'orchestrator_thread_unrelated', { thread: 'feishu:oc_side:om_side', reason: 'It discusses the login page, not this regression.' })).toEqual({ removed: true, thread: 'feishu:oc_side:om_side' })
  expect(h.runtime.store.threads.get('feishu:oc_side:om_side')!.subscriptions).toEqual([other.ticket.id])
  await vi.waitFor(() => expect(JSON.stringify(vi.mocked(inject).mock.calls)).toContain('thread_unrelated'))
  await expect(runTool(sessionId, 'orchestrator_thread_unrelated', { thread: 'feishu:oc_side:om_side', reason: 'again' })).rejects.toThrow('does not follow that thread')
  await expect(runTool(sessionId, 'orchestrator_thread_unrelated', { thread: threadKey(trigger.threads[0]!), reason: 'no' })).rejects.toThrow('the ticket started on')
  h.runtime.engine.bindThread(ticket.id, { source: 'github', id: '7' }, true)
  await expect(runTool(sessionId, 'orchestrator_thread_unrelated', { thread: 'github:7', reason: 'no' })).rejects.toThrow('pull request')
  // worker 只会丢弃自己的工单：另一个工单的线程不是此工单跟随的线程。
  await expect(runTool(sessionId, 'orchestrator_thread_unrelated', { thread: threadKey(other.trigger.threads[0]!), reason: 'no' })).rejects.toThrow('does not follow that thread')
})

it('refuses an accept through orchestrator_route for inferred candidates so proactive work always goes through Eval', async () => {
  const observed = feishu('21', '这个文案好奇怪，改成“浏览网页”吧', { mentions: [] })
  await receive(observed)
  await expect(route({ kind: 'accept', trigger_id: observed.id, title: 'x', worktree_name: 'copy-fix', acknowledgement: 'x' })).rejects.toThrow('explicit requests from allowed senders')
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('asks a question where the human message that raised it was written, not in the ticket\'s original conversation', async () => {
  const { ticket, trigger, sessionId } = await acceptedTicket()
  const review = feishu('5', 'Can you add the reason?', { mentions: [], root_id: 'om_review', sender_id: 'ou_guest' })
  subscribe(ticket.id, { source: 'feishu', id: `${CHAT}:om_review` })
  await receive(review)
  await expect(runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', question_for_trigger_id: review.id })).rejects.toThrow('needs the question it raised')
  await expect(runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', human_action: 'Keep it?', question_for_trigger_id: 'unknown' })).rejects.toThrow('the person\'s message that raised it')
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'no stop reason is recorded', human_action: 'Keep the change and record the reason in a follow-up?', question_for_trigger_id: review.id })
  const queued = vi.spyOn(h.runtime.outbox, 'send')
  await runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'Keep the change and record the reason in a follow-up?', text: 'Keep the change and record the reason in a follow-up?' })
  expect(queued.mock.calls.at(-1)![0].channel).toEqual(review.channel)
  // 关于整个工单的问题仍会送到工单开始的地方。
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'y', human_action: 'Desktop too?' })
  await runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'Desktop too?', text: '要不要也改桌面端？' })
  expect(queued.mock.calls.at(-1)![0].channel).toEqual(trigger.channel)
})

it('lists Tickets that wait on a person with where to answer them, as the overview does', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'need a decision', human_action: '按钮用哪种颜色？' })
  expect(ticketList(viewsOf(h.runtime), 'person', 0, 20).items).toEqual([expect.objectContaining({ id: ticket.id, stage: 'person', reply: expect.objectContaining({ source: 'feishu' }) })])
})

it('keeps replies and acknowledgements to an IM conversation within the IM limit', async () => {
  const { ticket, trigger, sessionId } = await acceptedTicket()
  const long = Array.from({ length: IM_WORDS + 1 }, () => 'word').join(' ')
  await runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'reviewed' })
  await expect(runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: long })).rejects.toThrow(`maximum is ${IM_WORDS}`)
  const follow = feishu('3', '还有一个问题', { mentions: [], root_id: trigger.meta.messageId as string, sender_id: MEMBER })
  await receive(follow)
  await expect(runTool(sessionId, 'orchestrator_ack', { trigger_id: follow.id, text: long })).rejects.toThrow(`at most ${IM_WORDS} words`)
})
