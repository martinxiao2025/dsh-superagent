/**
 * 来源与策略（从 runtime.spec.ts 拆出）：在模拟 DeepSeek Harness 宿主上通过工具和 HTTP 运行整个应用——
 * 消息文本的渲染、来源健康与启动报告、设置保存与策略历史、插件加载后的名单同步、
 * 同步群聊名单、规则与准入的编辑记录、频道与线程链接、当日流量计数、重新入队、
 * 按飞书消息 id 搜索、内存中的阅读页与消息链接、旧词表资源名、显示名刷新、
 * 会话消失/未监听/来源关闭时的丢弃、丢弃的确认、重复入队告知，以及每条来源记录的轮询循环。
 */
import { expect, it, vi } from 'vitest'
import { policyVersion } from '../src/policy.ts'
import { TextCache } from '../src/app/cache.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { key } from '../src/core/index.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { type SourceAdapter } from '../src/sources/kind.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { preview, readable } from '../src/app/views/text.ts'
import { decisionList, search, threadDetail, threadList } from '../src/app/views/threads.ts'
import { ticketDetail } from '../src/app/views/tickets.ts'
import { runtimeHost } from './fixtures/runtime-host.ts'

const h = runtimeHost()
const { api, runTool, receive, viewsOf, overviewOf, restart, feishu, acceptedTicket, MEMBER, CHAT } = h
it('shows a message that carries JSON, with or without a label, as its label and values on lines', () => {
  const text = `GitHub PR #7 CI: ${JSON.stringify({ head: 'abc1234', checks: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }], statuses: [] })}`
  expect(readable(text)).toBe('GitHub PR #7 CI\nhead: abc1234\nchecks:\n- e2e · completed · failure\n- lint · in_progress\nstatuses: ')
  expect(preview(text)).toBe('GitHub PR #7 CI head: abc1234 checks: e2e · completed · failure lint · in_progress statuses:')
  expect(readable('see {this} later')).toBe('see {this} later')
  expect(readable('label: {not json}')).toBe('label: {not json}')
})

it('reports a Source that was switched on as starting until its next pass reports its health', async () => {
  const save = (enabled: boolean) => h.runtime.settings.save('source:feishu', { name: h.runtime.store.settings().sources.feishu!.name, enabled, config: h.runtime.store.settings().sources.feishu!.config }, h.runtime.store.blockRevision('source:feishu'), 'panel')
  const feishu = async () => ((await api('GET', 'sources')).body as { id: string; health: unknown[] }[]).find(source => source.id === 'feishu')!.health
  await save(false)
  h.runtime.context(feishuKind, 'feishu').report('feishu', { state: 'paused', detail: 'Off', code: 'sourceOff' })
  await save(true)
  expect(await feishu()).toEqual([{ name: 'feishu', state: 'starting', detail: '' }, { name: 'feishu:history', state: 'starting', detail: '' }])
  // 报告其他内容的部件（例如缺失的 CLI）会保留其报告：不会有轮次来替换它。
  await save(false)
  h.runtime.context(feishuKind, 'feishu').report('feishu', { state: 'paused', detail: 'x', code: 'feishuCliUnset' })
  await save(true)
  expect((await feishu())[0]).toEqual(expect.objectContaining({ code: 'feishuCliUnset' }))
})

it('records each settings save with its policy change and the open tickets told about it', async () => {
  const { ticket } = await acceptedTicket()
  const settings = h.runtime.store.settings()
  await h.runtime.settings.save('executor', { ...settings.executor, maxWorkers: 5 }, h.runtime.store.blockRevision('executor'), 'panel')
  // 来源接收什么由它自己的配置决定，而不是策略；在那里谁可以发起工作由策略决定。
  const feishu = h.runtime.sources.instance('feishu')!
  await h.runtime.settings.save('source:feishu', { name: h.runtime.store.settings().sources.feishu!.name, enabled: true, config: { ...feishu.config, directMessages: false } }, h.runtime.store.blockRevision('source:feishu'), 'panel')
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, allowed: [...policy.sources.feishu!.allowed, { id: 'ou_bob', name: 'Bob' }] } } }, h.runtime.store.blockRevision('policy'), 'panel')
  await expect(h.runtime.settings.save('executor', settings.executor, 0, 'panel')).rejects.toThrow('Settings changed')
  const history = policyHistory(h.runtime.store, h.runtime.sources, policyVersion(h.runtime.store.settings()))
  expect(history.items.slice(0, 3)).toEqual([
    // 名单上的另一位发送者不影响任何未结束工单，因此不会告知任何人。
    expect.objectContaining({ source: 'panel', block: 'policy', policyChanged: true, notified: [], changes: [expect.objectContaining({ source: 'feishu', field: 'allowed', part: true })] }),
    expect.objectContaining({ source: 'panel', block: 'source:feishu', policyChanged: false, notified: [], changes: [{ code: 'sourceField', source: 'feishu', field: 'directMessages', from: true, to: false }] }),
    expect.objectContaining({ source: 'panel', block: 'executor', policyChanged: false, notified: [], changes: [{ code: 'maxWorkers', from: 3, to: 5 }] }),
  ])
})

it('syncs a Source\'s list once its plugin loads after dsh-superagent started', async () => {
  const next = await restart()
  await next.ready
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  next.sources.register(feishuKind)
  await vi.waitFor(() => expect(next.health['sync:feishu']).toMatchObject({ state: 'ready' }))
})

it('syncs the Feishu part of the Policy from its sync chat in place, and keeps the Policy version when only the order the chat lists changes', async () => {
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { allowed: [{ id: 'ou_bob', name: 'Bob' }, { id: MEMBER, name: 'Alice' }], syncChat: CHAT } } }, h.runtime.store.blockRevision('policy'), 'panel')
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: 'ou_erin', name: 'Erin' }, { member_id: MEMBER, name: 'Alice Liddell' }], has_more: false })
  expect(await h.runtime.settings.sync('feishu')).toEqual({ allowed: [{ id: MEMBER, name: 'Alice Liddell' }, { id: 'ou_erin', name: 'Erin' }], syncChat: CHAT, admission: {} })
  expect(h.runtime.store.settings().policy.sources.feishu!.allowed.map(entry => entry.id)).toEqual([MEMBER, 'ou_erin'])
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'ready', detail: '2 allowed' })
  const version = policyVersion(h.runtime.store.settings())
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice Liddell' }, { member_id: 'ou_erin', name: 'Erin' }], has_more: false })
  await h.runtime.settings.sync('feishu')
  expect(policyVersion(h.runtime.store.settings())).toBe(version)
  await expect(h.runtime.settings.sync('github')).rejects.toThrow('nothing to sync from')
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new Error('rate limited'))
  await expect(h.runtime.settings.sync('feishu')).rejects.toThrow('rate limited')
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('rate limited') })
})

it('describes rule edits in the Policy history and skips Policy syncs that change nothing', async () => {
  const settings = h.runtime.store.settings()
  const revision = () => h.runtime.store.get('settings-revision') as number
  const before = revision()
  // 同步群聊已恰好列出允许的用户，因此不会保存任何内容。
  await h.runtime.settings.sync('feishu')
  expect(revision()).toBe(before)
  await h.runtime.settings.save('policy', { ...h.runtime.store.settings().policy, rules: [{ ...settings.policy.rules[0]!, name: '文案' }, { ...settings.policy.rules[1]!, enabled: false }, { id: 'docs', name: '文档', enabled: true, instruction: 'x' }] }, h.runtime.store.blockRevision('policy'), 'panel')
  expect(policyHistory(h.runtime.store, h.runtime.sources, policyVersion(h.runtime.store.settings())).items[0]!.changes).toEqual([{ code: 'ruleRenamed', from: 'Copy fixes', to: '文案' }, { code: 'ruleDisabled', name: 'Visual fixes' }, { code: 'ruleAdded', name: '文档' }])
})

it('records an admission table change in the Policy history as one line for its Source, with a new Policy version', async () => {
  const policy = h.runtime.store.settings().policy
  const version = policyVersion(h.runtime.store.settings())
  await h.runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, admission: { [CHAT]: { unlistedAddressed: 'explicit' } } } } }, h.runtime.store.blockRevision('policy'), 'panel')
  expect(policyVersion(h.runtime.store.settings())).not.toBe(version)
  expect(policyHistory(h.runtime.store, h.runtime.sources, policyVersion(h.runtime.store.settings())).items[0]!.changes).toEqual([{ code: 'sourceAdmission', source: 'feishu', part: true }])
})

it('links Channels and Threads for people and keeps ended subscriptions out of the default Thread filter', async () => {
  const { ticket } = await acceptedTicket(feishu('1', '@_user_1 修一下回归', { mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'dsh-superagent' }] }))
  const home = `feishu:${CHAT}:om_1`
  expect(h.runtime.store.triggers.get(key('feishu', 'om_1'))!.text).toBe('@dsh-superagent 修一下回归')
  const chatLink = `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`
  expect(ticketDetail(viewsOf(h.runtime), ticket.id)!.channels).toEqual([expect.objectContaining({ source: 'feishu', url: chatLink })])
  expect(threadDetail(viewsOf(h.runtime), home, undefined, 10)!.url).toBe(chatLink)
  expect(threadList(viewsOf(h.runtime), 'subscribed', 0, 10).items.map(thread => thread.key)).toEqual([home])
  h.runtime.engine.stopTicket(ticket.id)
  expect(threadList(viewsOf(h.runtime), 'subscribed', 0, 10).items).toEqual([])
  expect(threadList(viewsOf(h.runtime), 'all', 0, 10).items.map(thread => thread.key)).toContain(home)
  await receive(feishu('9', '别的群的消息', { chat_id: 'oc_elsewhere' }))
  expect(search(viewsOf(h.runtime), '别的群', new TextCache(0)).items).toEqual([expect.objectContaining({ filtered: { code: 'chat_not_allowed' }, threadTitle: undefined })])
})

it('counts every step of the day\'s flow over the same arriving messages and lists the same accepted Decisions', async () => {
  const now = String(Date.now())
  await acceptedTicket(feishu('1', '@bot 修一下回归', { create_time: now }))
  await receive(feishu('7', '另一个群', { chat_id: 'oc_elsewhere', create_time: now }))
  const since = new Date(Date.now() - 86_400_000).toISOString()
  expect(overviewOf(h.runtime).flow).toMatchObject({ received: 2, filtered: 1, triggers: 1, judged: 1, accepted: 1 })
  expect(decisionList(viewsOf(h.runtime), ['accept'], 0, 10, since).items).toHaveLength(1)
  expect(decisionList(viewsOf(h.runtime), ['accept'], 0, 10, new Date(Date.now() + 60_000).toISOString()).items).toEqual([])
})

it('queues a requeued trigger visibly and tells the orchestrator', async () => {
  const stranger = feishu('3', '随便说说', { mentions: [], sender_id: 'ou_guest' })
  await receive(stranger)
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), paused: true })
  expect(h.runtime.engine.reevaluate(stranger.id)).toBe(true)
  expect(threadDetail(viewsOf(h.runtime), `feishu:${CHAT}:om_3`, undefined, 50)!.timeline[0]!.disposition).toMatchObject({ queued: true })
  await vi.waitFor(() => expect(h.agents.get(h.runtime.masterId)!.inject).toHaveBeenCalled())
})

it('finds triggers by Feishu message id', async () => {
  const message = feishu('30', '随便说说', { mentions: [] })
  await receive(message)
  expect(search(viewsOf(h.runtime), 'https://x/y?id=om_30', new TextCache(0)).items.map(item => item.id)).toContain(message.id)
})

it('keeps pages of Source reads, prompt previews and Feishu message links in memory, outside the kv area', async () => {
  const message = feishu('30', '随便说说', { mentions: [] })
  await receive(message)
  const link = 'https://applink.feishu.cn/client/message/link/open?token=t30'
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ messages: [{ message_id: 'om_30', chat_id: CHAT, message_app_link: link }] })
  expect(await runTool(h.runtime.masterId, 'orchestrator_read', { resource: `trigger/${message.id}` })).toMatchObject({ source_url: link })
  // AppLink 通过自 dsh-superagent 启动以来读取的链接找到。
  expect((await api('GET', `search?q=${encodeURIComponent(link)}`)).body).toMatchObject({ items: [expect.objectContaining({ id: message.id })] })
  const config = h.runtime.prompts.current().config
  const { previews } = await runTool(h.runtime.masterId, 'orchestrator_prompts_save', { config, preview: true }) as { previews: { read: string }[] }
  expect(await runTool(h.runtime.masterId, 'orchestrator_read', { resource: previews[0]!.read, offset: 4000 })).toMatchObject({ offset: 4000 })
  expect(h.runtime.store.keys('').filter(name => /-read:|source-link:|prompt-preview\//.test(name))).toEqual([])
})

it('reads resources recorded under the pre-vocabulary names', async () => {
  const { ticket, trigger, sessionId } = await acceptedTicket()
  expect(await runTool(sessionId, 'orchestrator_read', { resource: `event/${trigger.id}` })).toMatchObject({ trigger_id: trigger.id })
  expect(await runTool(sessionId, 'orchestrator_read', { resource: `task/${ticket.id}/assignment` })).toMatchObject({ resource: `ticket/${ticket.id}/assignment` })
})

it('rereads a Source\'s display names on request, reports the new ones and keeps the list when the read fails', async () => {
  h.runtime.store.set('source-labels:feishu', { oc_team: 'Team' })
  const lark = vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ chats: [{ chat_id: 'oc_team', name: 'Team' }, { chat_id: 'oc_new', name: 'New chat' }] })
  expect(await h.runtime.settings.refreshLabels('feishu')).toEqual({ added: ['New chat'] })
  expect(lark).toHaveBeenCalledWith(['im', '+chat-list', '--page-all', '--page-size', '100'])
  expect(h.runtime.store.get('source-labels:feishu')).toEqual({ oc_team: 'Team', oc_new: 'New chat' })
  lark.mockRejectedValue(new Error('token expired'))
  await expect(h.runtime.settings.refreshLabels('feishu')).rejects.toThrow('token expired')
  expect(h.runtime.store.get('source-labels:feishu')).toEqual({ oc_team: 'Team', oc_new: 'New chat' })
  await expect(h.runtime.settings.refreshLabels('github')).rejects.toThrow('no names to refresh')
})

it('drops a message only when its conversation is gone or not listened to, newest drop first, and keeps it while its Source is off', async () => {
  const channel = feishu('7', 'x').channel!
  // 不属于任何工单的消息不保留顺序，因此没有消息会排在另一个之后。
  const queue = (id: string, address: Record<string, string>) => { h.runtime.outbox.send({ id, channel: { ...channel, address }, text: '已合并。', kind: 'notice' }) }
  queue('gone-reply', channel.address)
  queue('failing-reply', { ...channel.address, messageId: 'om_8' })
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => {
    const replying = args.join(' ')
    if (replying.includes('om_7')) throw new CliError('the message was withdrawn', 230011)
    if (replying.includes('om_9')) return {}
    // 指明撤回的文本并非飞书关于会话已消失的答复。
    throw new Error('Request failed: withdrawn tokens are not recalled messages')
  })
  await h.runtime.sendReplies()
  // 飞书渠道将撤回代码视为已消失；其他任何失败都会保留回复以供重试。
  expect(h.runtime.store.replyStatus('gone-reply')).toBe('dropped')
  expect(h.runtime.store.replyStatus('failing-reply')).toBe('pending')
  const settings = h.runtime.store.settings(), feishuSource = settings.sources.feishu!
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...feishuSource, enabled: false } } })
  queue('off-reply', { ...channel.address, messageId: 'om_9' })
  queue('ignored-reply', { chatId: 'oc_elsewhere', messageId: 'om_10' })
  await h.runtime.sendReplies()
  expect([h.runtime.store.replyStatus('off-reply'), h.runtime.store.replyStatus('ignored-reply')]).toEqual(['pending', 'pending'])
  // 来源再次开启后，等待的消息会在 5 秒后重试时发出或被丢弃。
  h.runtime.store.saveSettings(settings)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5000 })
  try { await h.runtime.sendReplies() } finally { vi.useRealTimers() }
  expect([h.runtime.store.replyStatus('off-reply'), h.runtime.store.replyStatus('ignored-reply')]).toEqual(['sent', 'dropped'])
  const dropped = ((await api('GET', 'sources')).body as unknown as { dropped: { id: string }[] }[]).flatMap(source => source.dropped)
  expect(dropped).toMatchObject([{ id: 'ignored-reply', dropped: { reason: 'channelIgnored' } }, { id: 'gone-reply', dropped: { reason: 'channelGone' } }])
})

it('reports a dropped acknowledgement as dropped, with its Ticket on the Source status and in the last day\'s flow', async () => {
  const { sessionId, ticket } = await acceptedTicket()
  const followup = feishu('10', '还有这个', { mentions: [], root_id: 'om_1' })
  await receive(followup)
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new CliError('the message was withdrawn', 230011))
  expect(await runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id, text: '收到，也处理这个。' })).toMatchObject({ acknowledgement: 'dropped' })
  expect(await runTool(h.runtime.masterId, 'orchestrator_read', { resource: `trigger/${followup.id}` })).toMatchObject({ acknowledgement: 'dropped' })
  const dropped = ((await api('GET', 'sources')).body as unknown as { dropped: unknown[] }[]).flatMap(source => source.dropped)
  expect(dropped).toMatchObject([{ id: key('ack', followup.id), ticket: { id: ticket.id, title: ticket.title } }])
  expect(overviewOf(h.runtime).flow.dropped).toBe(1)
})

it('tells the main Session of each requeue of the same Trigger', async () => {
  const stranger = feishu('4', 'still wrong', { mentions: [], sender_id: 'ou_guest' })
  await receive(stranger)
  const requeued = () => h.agents.get(h.runtime.masterId)!.inject.mock.calls.filter(([message]) => JSON.stringify(message).includes('trigger_requeued')).length
  expect(h.runtime.engine.reevaluate(stranger.id)).toBe(true)
  await h.runtime.idle()
  expect(h.runtime.engine.reevaluate(stranger.id)).toBe(true)
  await h.runtime.idle()
  expect(requeued()).toBe(2)
})

it('runs one polling loop per source record and ends them all on shutdown', async () => {
  const started: string[] = []
  const adapter = { kind: feishuKind, async watch(_host: unknown, id: string, signal: AbortSignal) {
    started.push(id)
    await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve()))
  } } as SourceAdapter
  const current = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...current, sources: { ...current.sources,
    'feishu-a': { kind: 'feishu', name: 'Feishu A', enabled: true, config: current.sources.feishu!.config },
    'feishu-b': { kind: 'feishu', name: 'Feishu B', enabled: true, config: current.sources.feishu!.config },
  } })
  h.runtime.startSources([adapter])
  await vi.waitFor(() => expect([...started].sort()).toEqual(['feishu', 'feishu-a', 'feishu-b']))
  await h.runtime.stop()
})
