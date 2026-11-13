import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { snapshot, threadSummary, ticketSummary, triggerView } from '../src/app/views/records.ts'
import { basisFacts, ticketDetail } from '../src/app/views/tickets.ts'
import { threadDetail } from '../src/app/views/threads.ts'
import { droppedReplies, sourcesStatus } from '../src/app/views/sources.ts'
import { overview } from '../src/app/views/overview.ts'
import { markdown, plain } from '../src/app/views/text.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { KV } from '../src/kv.ts'
import { feishuLink } from '../src/sources/feishu-channel.ts'
import { feishuChannel, feishuTriggerId } from '../src/sources/feishu-trigger.ts'
import { followupOwners, type ChannelRef } from '../src/core/index.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-views-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const links = (channel: ChannelRef) => feishuLink(channel.address, {})
const drop = (id: string, channel: ChannelRef, ticketId?: string) => {
  const message = { id, channel, text: id, kind: 'reply' as const, ...ticketId ? { ticketId } : {} }
  store.receipts.add(message)
  store.receipts.settle(message, 'channelGone')
}

it('names the Thread of each dropped message: the one of the Trigger its Channel answers, or the Channel\'s own', () => {
  // 飞书渠道标明其群聊；它所回复的消息属于话题根消息所在的线程。
  store.triggers.save({ id: feishuTriggerId('feishu', 'om_reply'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }],
    actor: { source: 'feishu', id: 'ou_a' }, human: true, at: new Date().toISOString(), text: 'please', meta: {} })
  store.threads.save({ key: 'feishu:oc_3', ref: { source: 'feishu', id: 'oc_3' }, createdAt: '', subscriptions: [], correlated: [], pending: [],
    meta: {} })
  drop('a', feishuChannel('feishu', 'oc_1', 'om_reply'))
  drop('b', feishuChannel('feishu', 'oc_3', 'om_other'))
  // 触发器与线程在存储中都已不存在的消息不会链接到任何地方。
  drop('c', feishuChannel('feishu', 'oc_2', 'om_gone'))
  expect(Object.fromEntries(droppedReplies({ store, links }).map(item => [item.id, item.thread])))
    .toEqual({ a: 'feishu:oc_1:om_root', b: 'feishu:oc_3', c: undefined })
})

function views() {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } },
    rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }] },
  sources: { feishu: { kind: 'feishu', name: '飞书', enabled: true, config: {} } } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind)
  return { store, sources, links }
}
const at = new Date().toISOString()
/** 一个没有派工的活跃工单，正如后续消息的所有者需要的那样。 */
const live = (id: string) => store.tickets.save({ id, title: id, decisionId: 'd', channels: [], undelivered: [], createdAt: at,
  updatedAt: at,
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'addressed' as const, addressed: 'mention' as const }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
  origin: { triggerId: 'e0', triggerIds: ['e0'] }, assignments: [], inputs: [] })
const message = (id: string, actor: { source: string; id: string }, human = true) => ({ id, source: actor.source,
  threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor, human, at, text: `message ${id}`, meta: {} })

it('names each sender as the Policy lists it, by its id where the id is readable, and as its kind names one it does not list', () => {
  const view = snapshot(views())
  expect([view.actor({ source: 'feishu', id: 'OU_ALICE' }), view.actor({ source: 'feishu', id: 'ou_bob' }),
    view.actor({ source: 'feishu', id: 'ou_bot' }, false), view.actor({ source: 'feishu', id: '' })])
    .toEqual([{ source: 'feishu', id: 'OU_ALICE', name: { zh: 'Alice', en: 'Alice' } }, { source: 'feishu', id: 'ou_bob',
      name: feishuKind.policy!.unnamed!.person },
    { source: 'feishu', id: 'ou_bot', name: feishuKind.policy!.unnamed!.bot }, { source: 'feishu', id: '' }])
  expect(view.rule('copy')).toEqual({ id: 'copy', name: 'Copy fixes' })
  expect(view.rule('gone')).toEqual({ id: 'gone', name: 'gone' })
})

it('classifies a Thread by what it is doing, and offers a filtered Trigger of a person to Eval again', () => {
  const host = views()
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: [],
    correlated: [],
    pending: ['e2'], meta: {} })
  store.triggers.save(message('e1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.save(message('e2', { source: 'feishu', id: 'ou_bob' }))
  store.triggers.save(message('e3', { source: 'feishu', id: 'ou_bot' }, false))
  for (const id of ['e1', 'e3']) store.triggers.saveDisposition(id, { filtered: { code: 'not_a_member' }, fanout: [], at })
  const view = snapshot(host)
  expect(threadSummary(view, store.threads.get('feishu:oc_1:om_root')!).stage).toBe('queued')
  const rows = ['e1', 'e2', 'e3'].map(id => triggerView(view, store.triggers.get(id)!))
  // 已排队的触发器已经在等待评估，自动消息则不提供。
  expect(rows.map(row => row.actions.requeue)).toEqual([true, false, false])
  expect(rows[0]!.actor.name).toEqual({ zh: 'Alice', en: 'Alice' })
})

it('states each Source by the first state that holds', () => {
  const host = views()
  const states = (setup: Parameters<typeof sourcesStatus>[2], health: Parameters<typeof sourcesStatus>[1] = {}) =>
    Object.fromEntries(sourcesStatus(host, health, setup).map(source => [source.id, source.state]))
  expect(states({})).toEqual({ feishu: 'starting' })
  expect(states({}, { feishu: { state: 'ready', detail: '' }, 'feishu:history': { state: 'paused', detail: '' } }))
    .toEqual({ feishu: 'paused' })
  // 错误优先于暂停。
  expect(states({}, { feishu: { state: 'error', detail: 'x' }, 'feishu:history': { state: 'paused', detail: '' } }))
    .toEqual({ feishu: 'error' })
  const problem = { place: 'deployment', code: 'stateDirUnset', values: {}, detail: '' } as never
  expect(states({ problem }, { feishu: { state: 'ready', detail: '' }, 'feishu:history': { state: 'ready', detail: '' } }))
    .toEqual({ feishu: 'setup' })
})

it('reports each Source record\'s own health entries, including a second record of the same kind', () => {
  const host = views()
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { ...settings.sources,
    'feishu-2': { kind: 'feishu', name: '飞书 2', enabled: true, config: { cli: 'lark-cli' } } } })
  const status = Object.fromEntries(sourcesStatus(host, {
    feishu: { state: 'ready', detail: '' },
    'feishu:history': { state: 'ready', detail: '' },
    'feishu-2': { state: 'ready', detail: '' },
    'feishu-2:history': { state: 'paused', detail: '' },
  }, {}).map(source => [source.id, [source.state, source.health.map(part => part.name)]]))
  expect(status).toMatchObject({ feishu: ['ready', ['feishu', 'feishu:history']],
    'feishu-2': ['paused', ['feishu-2', 'feishu-2:history']] })
})

it('follows the Ticket\'s stage: a blocked Ticket a person answered since is working, with no retry, note or turn end', () => {
  const host = views()
  const blocked = { state: 'blocked' as const, summary: 'Needs the design file', at: '2026-09-22T00:01:00Z' }
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit' as const, policyVersion: 'v', basis: { via: 'addressed' as const, addressed: 'mention' as const }, actor: { source: 'feishu',
      id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [{ id: 'a1', state: 'running' as const, createdAt: at, startedAt: at,
      report: blocked }],
    inputs: [] as { id: string; kind: 'trigger'; triggerId: string; at: string; human?: true }[] }
  store.tickets.save(ticket)
  const row = ticketSummary(store.tickets.get('t1')!)
  expect(row).toMatchObject({ stage: 'person', action: 'blocked', actions: { retry: true }, note: { text: 'Needs the design file',
    error: false } })
  expect(ticketDetail(host, 't1')!.assignments[0]).toMatchObject({ turnEndedAt: blocked.at })
  store.tickets.save({ ...ticket, inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:02:00Z', human: true }] })
  const answered = ticketSummary(store.tickets.get('t1')!)
  expect(answered).toMatchObject({ stage: 'working', actions: { retry: false } })
  expect(answered).not.toHaveProperty('note')
  expect(ticketDetail(host, 't1')!.assignments[0]).not.toHaveProperty('turnEndedAt')
})

it('does not show a follow-up that reached a ticket as waiting for an Eval, though an older version queued it', () => {
  const host = views()
  live('t1')
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'feishu', id: 'ou_bob' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, at })
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: ['f1'], meta: {} })
  const view = snapshot(host)
  expect(threadSummary(view, store.threads.get('feishu:oc_1:om_root')!)).toMatchObject({ stage: 'subscribed', pending: 0 })
  expect(triggerView(view, store.triggers.get('f1')!).disposition.queued).toBe(false)
  // 有人再次发给评估的触发器会等待它。
  store.threads.save({ ...store.threads.get('feishu:oc_1:om_root')!, pending: ['f1', 'f2'] })
  expect(threadSummary(snapshot(host), store.threads.get('feishu:oc_1:om_root')!)).toMatchObject({ stage: 'queued', pending: 1 })
})

const load = { running: 0, queued: 0 }
const problems = (host: ReturnType<typeof views>, health: Parameters<typeof overview>[1] = {}) =>
  overview(host, health, 'v1', load).problems

it('lists an Eval past its deadline, and as dsh-superagent\'s own errors only parts no Source or Policy sync reports', () => {
  const host = views()
  const evaluating = { id: 'e1', threadKey: 'feishu:oc_1:om_root', triggerIds: ['t1'], strength: 'explicit' as const,
    actor: { source: 'feishu', id: 'ou_alice' },
    basis: { via: 'addressed' as const, addressed: 'mention' as const }, policyVersion: 'v1', startedAt: '2026-01-01T00:00:00Z',
    deadline: '2026-01-01T00:02:00Z' }
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: [],
    correlated: [], pending: [], evaluating, meta: {} })
  const error = (detail: string) => ({ state: 'error' as const, detail })
  const health = { relay: error('relay failing'), reply: error('reply failing'), feishu: error('socket closed'),
    'feishu:history': error('read failed'),
    'sync:feishu': error('sync failed'), evals: error('unavailable'), launch: { state: 'ready' as const, detail: '' } }
  const found = problems(host, health)
  expect(found).toContainEqual({ kind: 'eval-overdue', thread: expect.objectContaining({ key: 'feishu:oc_1:om_root', stage: 'evaluating' }) })
  // 效果属于 dsh-superagent 自身；来源显示其部件与策略同步，评估则逐条列出。
  expect(found.filter(item => item.kind === 'runtime-error')).toEqual([
    { kind: 'runtime-error', name: 'relay', detail: 'relay failing', category: 'runtime' },
    { kind: 'runtime-error', name: 'reply', detail: 'reply failing', category: 'runtime' }])
  expect(found.filter(item => item.kind === 'source-error').map(item => item.source.health.name)).toEqual(['feishu', 'feishu:history'])
})

it('says no Source runs when every Source is off, and states a Source missing or off', () => {
  const host = views()
  expect(problems(host).map(item => item.kind)).not.toContain('no-source')
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { feishu: { kind: 'feishu', name: '飞书', enabled: false, config: {} },
    'feishu-work': { kind: 'feishu', name: '飞书 2', enabled: false, config: {} },
    jira: { kind: 'jira', name: 'Jira', enabled: true, config: { site: 'acme' } } } })
  expect(problems(host).map(item => item.kind)).toContain('no-source')
  expect(Object.fromEntries(sourcesStatus(host, {}, {}).map(source => [source.id, [source.state, source.installed]])))
    .toEqual({ feishu: ['off', true], 'feishu-work': ['off', true], jira: ['missing', false] })
})

it('sends text without HTML, entity-encoded tags included, and with images named', () => {
  const text = '<div>Hello <b>there</b></div> &lt;script&gt;alert(1)&lt;/script&gt; <!-- note --> ![shot](https://x/y.png) [Image: diagram]'
  expect(plain(text)).toBe('Hello there alert(1) [image] [image]')
  expect(markdown(`**Fix** ${text}\n\n- one`)).toBe('**Fix** Hello there alert(1)  [image] [image]\n\n- one')
  expect(plain('[the docs](https://example.com) and `code` &amp; more')).toBe('the docs and code & more')
})

it('words each settings save by what it changed from the one before, and nothing after a gap in the history', () => {
  const host = views()
  const first = store.settings()
  const allowed = (entries: { id: string; name?: string }[]) => ({ ...first.policy, sources: { ...first.policy.sources,
    feishu: { ...first.policy.sources.feishu!, allowed: entries } } })
  const alice = { id: 'ou_alice', name: 'Alice Liu' }, bob = { id: 'ou_bob', name: 'Bob' }
  store.saveSettings({ ...first, policy: allowed([alice, bob, { id: 'ou_carol' }]), paused: true,
    sources: { ...first.sources, feishu: { kind: 'feishu', name: '飞书', enabled: false, config: {} } },
    executor: { ...first.executor, directory: '/srv/work', prepare: 'npm ci', blockedCommands: ['rm', 'curl'] } })
  const second = store.settings()
  store.saveSettings({ ...second, policy: allowed([alice, { id: 'ou_carol' }]), paused: false, sources: { ...second.sources,
    feishu: { kind: 'feishu', name: '飞书', enabled: true, config: {} } } })
  const changes = (revision: number) => policyHistory(store, host.sources, 'v').items.find(item => item.revision === revision)!.changes
  const revision = store.get(KV.settings.revision)!
  expect(changes(revision - 1)).toEqual([
    { code: 'sourceRowsAdded', source: 'feishu', part: true, field: 'allowed', items: ['Bob', 'ou_carol'] },
    { code: 'sourceRowsChanged', source: 'feishu', part: true, field: 'allowed', items: ['Alice Liu'] },
    { code: 'paused' }, { code: 'executionDirectory', from: '', to: '/srv/work' }, { code: 'prepareCommand' },
    { code: 'blockedCommands', from: '', to: 'rm curl' }, { code: 'sourceDisabled', source: 'feishu' }])
  expect(changes(revision)).toEqual([{ code: 'sourceRowsRemoved', source: 'feishu', part: true, field: 'allowed', items: ['Bob'] },
    { code: 'resumed' }, { code: 'sourceEnabled', source: 'feishu' }])
  // 历史中缺少前驱的保存没有可比较的内容。
  store.delete(KV.settings.version(revision))
  store.saveSettings({ ...store.settings(), paused: true })
  expect(changes(revision + 1)).toBeNull()
})

it('names a listed bot as the Policy lists it, and gives a bot\'s Mandate a basis fact of its own', () => {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [], bots: [{ id: 'cli_review', name: '评审机器人' }] } } } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind)
  const view = snapshot({ store, sources, links })
  expect(view.actor({ source: 'feishu', id: 'cli_review' }, false).name).toEqual({ zh: '评审机器人', en: '评审机器人' })
  expect(basisFacts({ via: 'bot', sender: '评审机器人', addressed: 'mention', observation: { mode: 'auto' } }, view.rule).facts)
    .toEqual([{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'addressed', value: 'mention' }, { name: 'mode', value: 'auto' }])
})

it('shows a follow-up that reached a ticket as delivered, the tickets that handed a Trigger back with why, and the Threads a ticket follows for context', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, handbacks: [{ ticketId: 't1', reason: 'Asks for a new feature', at }], at })
  const view = snapshot(host)
  expect(triggerView(view, store.triggers.get('f1')!).disposition).toMatchObject({ delivered: true, queued: false, handbacks: [] })
  // 被交回的触发器会像其线程上的任何消息一样进入评估；交回它的工单有标题后会以标题标出。
  expect(triggerView(view, store.triggers.get('f2')!).disposition).toMatchObject({ delivered: false,
    handbacks: [{ ticketId: 't1', title: 't1', reason: 'Asks for a new feature' }] })
  store.threads.save({ key: 'feishu:oc_7:om_root', ref: { source: 'feishu', id: 'oc_7:om_root' }, createdAt: at, subscriptions: ['t1'], context: ['t1'],
    correlated: [], pending: [], meta: {} })
  expect(threadDetail(host, 'feishu:oc_7:om_root', undefined, 50)?.context).toEqual(['t1'])
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'addressed' as const, addressed: 'mention' as const }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [],
    inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'f1', at }, { id: 'i2', kind: 'trigger', triggerId: 'f2', at }] })
  const page = ticketDetail(host, 't1')!
  expect(Object.fromEntries(page.threads.map(thread => [thread.key, !!thread.context]))).toEqual({ 'feishu:oc_1:om_root': false,
    'feishu:oc_7:om_root': true })
  expect(page.inputs.map(input => input.kind === 'trigger' && input.trigger?.handback)).toEqual([{ reason: 'Asks for a new feature', at },
    undefined])
  expect(triggerView(snapshot(host), store.triggers.get('f2')!).disposition.handbacks[0]?.title).toBe('Fix')
})

it('names a bot\'s Mandate as a bot once the Policy no longer lists it', () => {
  const host = views()
  const mandate = { strength: 'inferred' as const, policyVersion: 'v', basis: { via: 'bot' as const,
    observation: { mode: 'auto' as const } },
    actor: { source: 'feishu', id: 'cli_removed' }, scope: '' }
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at, mandate,
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [], inputs: [] })
  expect(ticketDetail(host, 't1')!.mandate.actor).toEqual({ source: 'feishu', id: 'cli_removed', name: feishuKind.policy!.unnamed!.bot })
})

it('offers a person to send a follow-up to Eval while a ticket decides it, or once nothing did', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  const row = () => triggerView(snapshot(host), store.triggers.get('f1')!)
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: true } })
  // 工单在其 worker 处理过后结束，就不再交由任何人处理：人仍可把它发给评估。
  store.tickets.save({ ...store.tickets.get('t1')!, ended: { at, by: 'executor', reason: 'done', outcome: 'completed' } })
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: false } })
  // 但 worker 确认接收并接手后就不行；对它停止只决定了工单的工作。
  store.triggers.saveDisposition('f1', { fanout: ['t1'], acked: ['t1'], at })
  expect(row().actions.requeue).toBe(false)
  store.decisions.save({ id: 'stop', evalId: 'e', threadKey: 'feishu:oc_1:om_root', triggerIds: ['f1'], policyVersion: 'v', at, kind: 'stop',
    reason: [{ code: 'humanStop' }], strength: 'explicit', ticketId: 't1' })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], decisionId: 'stop', at })
  expect(row().actions.requeue).toBe(true)
  // 因此当停止结束工单并释放该消息时，正如引擎记录的那样。
  store.triggers.saveDisposition('f1', { fanout: [], decisionId: 'stop', at })
  expect(row().actions.requeue).toBe(true)
  // 一旦发送，它就在等待评估。
  store.threads.save({ ...store.threads.get('feishu:oc_1:om_root')!, pending: ['f1'] })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], requeued: true, at })
  expect(row()).toMatchObject({ actions: { requeue: false }, disposition: { queued: true } })
})

it('reads each ticket a page\'s follow-ups reached once, and nothing for a message no ticket can decide', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [], pending: [], meta: {} })
  for (const id of ['f1', 'f2', 'f3']) {
    store.triggers.save(message(id, { source: 'feishu', id: 'ou_alice' }))
    store.triggers.saveDisposition(id, { fanout: ['t1'], at })
  }
  const view = snapshot(host)
  const tickets = vi.spyOn(store.tickets, 'get')
  expect(['f1', 'f2', 'f3'].map(id => triggerView(view, store.triggers.get(id)!).disposition.delivered)).toEqual([true, true, true])
  expect(tickets).toHaveBeenCalledOnce()
  tickets.mockRestore()
  // 工单交回的消息不由任何工单决定，因此无需读取。
  store.triggers.saveDisposition('f3', { fanout: ['t1'], handbacks: [{ ticketId: 't1', reason: 'Another change', at }], at })
  const records = { tickets: { get: vi.fn() }, threads: { get: vi.fn() }, triggers: store.triggers }
  expect(followupOwners(store.triggers.get('f3')!, records)).toEqual([])
  expect([records.tickets.get, records.threads.get].map(read => read.mock.calls.length)).toEqual([0, 0])
})
