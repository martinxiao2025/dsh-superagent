import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, key, type Assessor, type Executor, type Thread, type Ticket, type Trigger } from '../src/core/index.ts'
import { backfillChat, consumerRetry, feishuAdapter, feishuKind, feishuRef, feishuSettings, feishuTime, feishuTrigger, feishuTriggerId, historyEvent } from '../src/sources/feishu.ts'
import { KV } from '../src/kv.ts'
import { pollThreads as pollFeishuThreads } from '../src/sources/feishu.ts'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import { commentTrigger, githubAddress, githubChannel, githubPage, issueTrigger, type GithubComment, type GithubIssue } from '../src/sources/github-trigger.ts'
import { claimPull, observePull, pullEndNotices, pullOf, ticketBranch, type Pull } from '../src/sources/github-pull.ts'
import { ciCounts, ciFact, ciSummary } from '../src/sources/github-read.ts'
import { githubAdapter, githubKind, pollFailure, pollRound } from '../src/sources/github.ts'
import { pollThreads as pollGithubThreads } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { cursorAt, POLL_HORIZON_MS } from '../src/sources/poll.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment, testFeishu, testGithub } from './fixtures/deployment.ts'
import { programSource } from './fixtures/program.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SetupError, type SetupProblem } from '../src/setup.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MEMBER = 'ou_alice'
function host(overrides: Partial<SourceContextDeps> = {}, records: Record<string, { kind: string; enabled?: boolean; config?: Record<string, unknown> }> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sources-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' }, github: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' }, sources: { feishu: { kind: 'feishu', enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_observed', listen: 'all' }], directMessages: true } }, github: { kind: 'github', enabled: true, config: {} },
    ...Object.fromEntries(Object.entries(records).map(([id, record]) => [id, { enabled: true, ...record }])) } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment()
  sources.register(feishuKind); sources.register(githubKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => parts.deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // 在存储中记录出站消息，而不发送它们。
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  // 来源的函数接收上下文；插件条目与类型回调接收宿主，宿主会构建每个类型的上下文。
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }, id: string) => sourceContextOf(parts, kind, id) }
  // 测试直接调用各类型的来源函数，所以每种类型各给一个上下文：默认返回的是 GitHub 上下文，
  // 飞书函数用 eishu 拿到同一份存储与宿主、来源记录为飞书的上下文。
  const githubContext = sourceContextOf(parts, githubKind, 'github')
  const feishuContext = sourceContextOf(parts, feishuKind, 'feishu')
  const health = overrides.sources ? healthOf.get(overrides.sources)!.all : board.all
  return { ...value, ...githubContext, feishu: { ...value, ...feishuContext }, health, store, engine, receive, executor }
}
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
/** 一个尚未注册任何类型的注册表，带一条启用的记录以便观察该类型的循环。 */
function emptyRegistry(record: { id: string; kind: string } = { id: 'feishu', kind: 'feishu' }): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { [record.id]: { kind: record.kind, enabled: true, config: {} } } }), board)
  healthOf.set(sources, board)
  return sources
}
const subscribed = (h: ReturnType<typeof host>, ref: { source: string; id: string }, meta: Record<string, unknown> = {}) =>
  h.store.threads.save({ key: `${ref.source}:${ref.id}`, ref, createdAt: new Date().toISOString(), subscriptions: ['ticket'], correlated: [], pending: [], meta })
const openTicket = (id: string): Ticket => ({ id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '',
  basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: `source-${id}`, triggerIds: [] } })
const execution = (name: string) => ({ name, directory: `/w/${name}`, assignment: '' })
const pulled = (number: number) => ({ follows: [{ thread: `github:${number}`, own: true }] })
const endedPull = (number: number, at: string, merged = true): Pull =>
  ({ ...openPull(number), state: 'closed', merged, ...merged ? { merged_at: at } : { closed_at: at } })
const agentsPull = (number: number, ref: string): Pull =>
  ({ ...openPull(number), user: { login: 'agent-bot' }, head: { sha: 'abc', ref, repo: { full_name: 'acme/widgets' } } })
const openPull = (number: number) => ({ number, title: 'Fix the margin', state: 'open',
  html_url: `https://github.com/acme/widgets/pull/${number}`, user: { login: 'carol' },
  head: { sha: 'abc', ref: 'fix', repo: { full_name: 'acme/widgets' } } })
const notification = (number: number, kind: 'issues' | 'pulls' = 'issues') => ({ id: `n${number}`, updated_at: '2026-09-09T00:00:00Z',
  reason: 'mention',
  repository: { full_name: 'acme/widgets' }, subject: { url: `https://api.github.com/repos/acme/widgets/${kind}/${number}`,
    type: kind === 'pulls' ? 'PullRequest' : 'Issue', title: '' } })
const refused = (status: number, text: string) => commandError({ stderr: `gh: ${text} (HTTP ${status})`, code: 1 })
/** 对某条 GitHub 记录打桩 `gh api` 调用，并按顺序返回请求的路径。 */
function githubOn(commands: Commands, routes: Record<string, unknown>, repository = 'acme/widgets'): string[] {
  const reads: string[] = []
  const scope = new RegExp(`^repos/${repository}/`)
  vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => {
    reads.push(args[1]!.replace(scope, ''))
    const path = reads.at(-1)!.split('?')[0]!
    const list = /\/(comments|reviews|statuses)$/.test(path) ? [] : refused(404, 'Not Found')
    const route = routes[path] ?? (path.endsWith('/check-runs') ? { check_runs: [] } : list)
    const value: unknown = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    if (args.includes('--include')) return `HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify(value)}`
    return JSON.stringify(args.includes('--slurp') ? [value] : value)
  })
  return reads
}
function github(h: ReturnType<typeof host>, routes: Record<string, unknown>): string[] {
  return githubOn(h.commands, routes)
}
const bare = (reads: string[]) => reads.map(path => path.split('?')[0])
describe('feishu source', () => {
  it('registers its kind without a bot, and names on its health what setup still needs', async () => {
    const run = async (overrides: Partial<SourceContextDeps>) => {
      const value = host({ sources: emptyRegistry(), ...overrides })
      const dispose = value.sources.register(feishuKind)
      const controller = new AbortController()
      const running = feishuAdapter.watch(value, 'feishu', controller.signal)
      await vi.waitFor(() => expect(value.health['feishu:history']).toBeDefined())
      const registered = value.sources.kindByName('feishu')
      // 在取消注册清除条目之前快照健康状态。
      const health = { ...value.health }
      controller.abort(); await running; dispose()
      return { ...value, registered, health }
    }
    const unset = await run({ deployment: testDeployment({ feishu: undefined }) })
    expect(unset.registered).toBe(feishuKind)
    expect(unset.health).toMatchObject({ feishu: { state: 'paused', code: 'feishuCliUnset' }, 'feishu:history': { state: 'paused', code: 'feishuBotMissing' } })
    const problem = new SetupError('feishuBotNotReady', { app: 'cli_bot', status: 'missing' }).problem
    const refused = await run({ deployment: testDeployment({ feishu: undefined }), sourceProblems: { feishu: problem } })
    // 失败的机器人检查会等待操作者的修复和一次检查；它不会像轮询错误那样自行重试。
    expect(refused.health.feishu).toEqual({ state: 'paused', detail: problem.detail })
    expect((await run({ configured: () => false })).health.feishu).toEqual({ state: 'paused', detail: 'Waiting for the deployment check', code: 'setupPending' })
  })
  it('translates live events into triggers keyed by root message, and drops the bot\'s own messages', () => {
    const trigger = feishuTrigger('feishu', { message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1757376000000', mentions: [{ id: 'cli_bot' }], root_id: 'om_1', parent_id: 'om_1', thread_id: 'omt_1', message_app_link: 'https://applink/x' }, 'ou_bot', 'cli_bot')!
    expect(trigger).toMatchObject({ id: key('feishu', 'om_2'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: MEMBER }, human: true, at: '2025-09-09T00:00:00.000Z', url: 'https://applink/x', channel: { source: 'feishu', address: { chatId: 'oc_1', messageId: 'om_2' } }, meta: { chatId: 'oc_1', direct: false, mentioned: true, rootId: 'om_1', parentId: 'om_1', threadId: 'omt_1', messageId: 'om_2' } })
    expect(trigger.addressed).toBe('mention')
    expect(feishuTrigger('feishu', { message_id: 'om_5', chat_id: 'oc_2', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1' }, 'ou_bot', 'cli_bot')!.addressed).toBe('direct')
    expect(feishuTrigger('feishu', { message_id: 'om_6', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1' }, 'ou_bot', 'cli_bot')).not.toHaveProperty('addressed')
    expect(feishuRef(trigger)).toEqual({ triggerId: trigger.id, chatId: 'oc_1', messageId: 'om_2', at: trigger.at })
    expect(feishuTrigger('feishu', { message_id: 'om_3', chat_id: 'oc_1', chat_type: 'p2p', sender_id: 'ou_bot', sender_type: 'bot', content: 'me', create_time: '1' }, 'ou_bot', 'cli_bot')).toBeUndefined()
    expect(feishuTrigger('feishu', historyEvent({ message_id: 'om_4', chat_id: 'oc_1', create_time: '2', sender: { id: 'ou_x', sender_type: 'app' }, body: { content: '{"text":"from app"}' } }, 'oc_1', false), 'ou_bot', 'cli_bot')).toMatchObject({ human: false, text: 'from app', threads: [{ id: 'oc_1:om_4' }] })
  })
  it('polls subscribed threads and stores unseen replies as triggers on that thread', async () => {
    const h = host()
    const source = feishuTrigger('feishu', { message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: '@bot fix', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!, { chatId: 'oc_1', messageId: 'om_root', sourceTriggerId: source.id })
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!, createdAt: '2025-09-01T00:00:00Z',
      lastAt: new Date().toISOString() })
    const reply = { message_id: 'om_reply', chat_id: 'oc_1', msg_type: 'text', content: 'more details', sender: { id: 'ou_guest', sender_type: 'user' }, create_time: '1757376000000', thread_id: 'omt_1', root_id: 'om_root', mentions: [] }
    const mine = { ...reply, message_id: 'om_mine', sender: { id: 'ou_bot', sender_type: 'app', open_bot_id: 'ou_bot' } }
    const earlier = { ...reply, message_id: 'om_old', create_time: '1700000000000' }
    const lark = vi.spyOn(h.feishu.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_1', thread_id: 'omt_1' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      return { thread_id: 'omt_1', has_more: false, messages: [mine, reply, earlier] }
    })
    await pollFeishuThreads(h.feishu)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: key('feishu', 'om_reply'), threads: [{ source: 'feishu', id: 'oc_1:om_root' }],
      actor: { id: 'ou_guest' }, human: true, text: 'more details', meta: expect.objectContaining({ threadId: 'omt_1' }) })
    expect(h.store.get('thread-seen:feishu:oc_1:om_root')).toEqual(expect.arrayContaining(['om_reply', 'om_mine', 'om_old']))
    expect(h.store.threads.get('feishu:oc_1:om_root')?.meta).toMatchObject({ threadId: 'omt_1', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', facts: { chat: { value: 'oc_1' } } })
    lark.mockRejectedValue(new Error('rate limited'))
    await pollFeishuThreads(h.feishu)
    expect(h.store.threads.get('feishu:oc_1:om_root')?.meta.pollError).toContain('rate limited')
    h.store.close()
  })
  it('translates a polled topic reply as the event consumer translates the live event', async () => {
    const h = host()
    // 机器人从其事件中获知的直接消息聊天。
    h.store.set('feishu-chats:feishu', { oc_dm: true })
    const source = feishuTrigger('feishu', { message_id: 'om_root', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user',
      content: 'fix it', create_time: '1757376000000' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_dm:om_root')!, createdAt: '2025-09-01T00:00:00Z',
      lastAt: new Date().toISOString() })
    const page = (message_id: string, sender: Record<string, string>, extra: Record<string, unknown> = {}) => ({ message_id,
      chat_id: 'oc_dm', msg_type: 'text', content: 'and the header', sender,
      create_time: '2026-09-11 12:00', thread_id: 'omt_dm', ...extra })
    vi.spyOn(h.feishu.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_dm', thread_id: 'omt_dm' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      // 页面列出其回复而不含根消息，并按应用列出机器人自己的消息。
      const messages = [page('om_mine', { id: 'cli_bot', sender_type: 'app' }), page('om_reply', { id: MEMBER, sender_type: 'user' })]
      return { thread_id: 'omt_dm', has_more: false, messages }
    })
    await pollFeishuThreads(h.feishu)
    const live = feishuTrigger('feishu', { message_id: 'om_reply', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user',
      content: 'and the header',
      create_time: String(Date.parse('2026-09-11 12:00')), root_id: 'om_root', thread_id: 'omt_dm' }, 'ou_bot', 'cli_bot')
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([live])
    expect(live).toMatchObject({ addressed: 'direct', threads: [{ source: 'feishu', id: 'oc_dm:om_root' }] })
    h.store.close()
  })
  it('reads message times given as epoch milliseconds or as local times, and refuses others', () => {
    expect(feishuTime('1757376000000')).toBe('2025-09-09T00:00:00.000Z')
    expect(feishuTime('2026-09-11 12:00')).toBe(new Date(2026, 8, 11, 12, 0).toISOString())
    expect(() => feishuTime('soon')).toThrow('Unreadable Feishu message time')
  })
  it('polls a subscribed topic while a live ticket follows it or it had a message in the last two weeks', async () => {
    const h = host()
    const source = feishuTrigger('feishu', { message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: 'fix', create_time: '1' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!,
      lastAt: new Date(Date.now() - 15 * 24 * 3600_000).toISOString() })
    const lark = vi.spyOn(h.feishu.commands, 'lark').mockResolvedValue({ items: [] })
    await pollFeishuThreads(h.feishu)
    expect(lark).not.toHaveBeenCalled()
    h.store.tickets.save(openTicket('ticket'))
    await pollFeishuThreads(h.feishu)
    expect(lark).toHaveBeenCalled()
    h.store.close()
  })
  it('keeps a quiet topic in history recovery while a subscribed Thread that is polled follows it', async () => {
    const h = host()
    const day = 24 * 3600_000
    const source = feishuTrigger('feishu', { message_id: 'om_root', chat_id: 'oc_team', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: 'fix', create_time: String(Date.now() - 30 * day), thread_id: 'omt_followed' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.tickets.save(openTicket('ticket'))
    const old = new Date(Date.now() - 30 * day).toISOString()
    h.store.set('feishu-history-threads:feishu:oc_team', { omt_followed: old, omt_quiet: old })
    vi.spyOn(h.feishu.commands, 'withSignal').mockReturnValue(h.feishu.commands)
    vi.spyOn(h.feishu.commands, 'lark').mockResolvedValue({ has_more: false, items: [] })
    const now = new Date().toISOString()
    await backfillChat(h.feishu, 'oc_team', false, new Date(Date.now() - 60_000).toISOString(), now, new AbortController().signal)
    expect(h.store.get('feishu-history-threads:feishu:oc_team')).toEqual({ omt_followed: old })
    h.store.close()
  })
  it('refuses a history page with a message outside its chat or topic, and a page token that does not advance', async () => {
    const h = host()
    vi.spyOn(h.feishu.commands, 'withSignal').mockReturnValue(h.feishu.commands)
    const message = (fields: Record<string, unknown>) => ({ message_id: 'om_1', chat_id: 'oc_team', create_time: String(Date.now() - 1000),
      sender: { id: MEMBER, sender_type: 'user' }, body: { content: '{"text":"hi"}' }, ...fields })
    const lark = vi.spyOn(h.feishu.commands, 'lark')
    const now = new Date().toISOString()
    const recover = () => backfillChat(h.feishu, 'oc_team', false, new Date(Date.now() - 60_000).toISOString(), now, new AbortController().signal)
    lark.mockResolvedValueOnce({ has_more: false, items: [message({ chat_id: 'oc_other' })] })
    await expect(recover()).rejects.toThrow('outside the requested chat or thread')
    // 话题页面包含另一个话题的消息。
    h.store.set('feishu-history-threads:feishu:oc_team', { omt_1: now })
    lark.mockResolvedValueOnce({ has_more: false, items: [] }).mockResolvedValueOnce({ has_more: false, items: [message({ thread_id: 'omt_2' })] })
    await expect(recover()).rejects.toThrow('outside the requested chat or thread')
    h.store.set('feishu-history-threads:feishu:oc_team', {})
    const stuck = { has_more: true, page_token: 'p1', items: [] }
    lark.mockResolvedValueOnce(stuck).mockResolvedValueOnce(stuck)
    await expect(recover()).rejects.toThrow('did not advance')
    lark.mockResolvedValueOnce({ has_more: true, items: [] })
    await expect(recover()).rejects.toThrow('did not advance')
    h.store.close()
  })
  it('stops reading a polled topic at the first message it knew, once the topic\'s first poll ran', async () => {
    const h = host()
    const source = feishuTrigger('feishu', { message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: '@bot fix', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!, { chatId: 'oc_1', messageId: 'om_root', sourceTriggerId: source.id })
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!, lastAt: new Date().toISOString() })
    h.store.set('thread-seen:feishu:oc_1:om_root', ['om_2'])
    h.store.set('thread-initialized:feishu:oc_1:om_root', true)
    const reply = (id: string) => ({ message_id: id, chat_id: 'oc_1', msg_type: 'text', content: `reply ${id}`, create_time: String(Date.now()),
      sender: { id: 'ou_guest', sender_type: 'user' }, thread_id: 'omt_1', root_id: 'om_root' })
    const lark = vi.spyOn(h.feishu.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_1', thread_id: 'omt_1' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      // 从新到旧：一条新回复，然后是线程已知的那条，以及一个未读取的较旧页面。
      return { thread_id: 'omt_1', has_more: true, page_token: 'older', messages: [reply('om_3'), reply('om_2')] }
    })
    await pollFeishuThreads(h.feishu)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_3'])
    expect(lark.mock.calls.filter(([args]) => args[1] === '+threads-messages-list')).toHaveLength(1)
    h.store.close()
  })
  it('recovers the topics of a chat while they had a message in the last two weeks, and forgets quieter ones', async () => {
    const h = host()
    const day = 24 * 3600_000
    const start = Date.parse('2026-09-01T00:00:00.000Z')
    h.store.set('feishu-history-threads:feishu:oc_team', { omt_old: new Date(start).toISOString() })
    let round = 0
    const scans: string[] = []
    vi.spyOn(h.feishu.commands, 'withSignal').mockReturnValue(h.feishu.commands)
    vi.spyOn(h.feishu.commands, 'lark').mockImplementation(async args => {
      const params = JSON.parse(args[args.indexOf('--params') + 1]!) as { container_id_type: string; container_id: string }
      scans.push(params.container_id)
      // 每天的聊天扫描产生一个新线程；线程扫描不再返回消息。
      return { has_more: false, items: params.container_id_type === 'chat' ? [{ message_id: `om_${round}`, chat_id: 'oc_team',
        create_time: String(start + round * day), thread_id: `omt_${round}`,
        sender: { id: 'ou_bob', sender_type: 'user' }, body: { content: '{"text":"hi"}' } }] : [] }
    })
    for (round = 0; round < 30; round++) {
      scans.length = 0
      const since = new Date(start + round * day - 60_000).toISOString()
      await backfillChat(h.feishu, 'oc_team', false, since, new Date(start + round * day + 60_000).toISOString(), new AbortController().signal)
      if (round === 0) expect(scans).toContain('omt_old')
    }
    // 聊天，以及最近 14 天内有消息的话题。
    expect(scans).toHaveLength(1 + 14)
    expect(Object.keys(h.store.get<Record<string, string>>('feishu-history-threads:feishu:oc_team')!)).toHaveLength(14)
    expect(h.store.get<Record<string, string>>('feishu-history-threads:feishu:oc_team')!.omt_29).toBe(new Date(start + 29 * day).toISOString())
    h.store.close()
  })
  it('skips and counts a history message it cannot read, and takes in the others', async () => {
    const h = host()
    vi.spyOn(h.feishu.commands, 'withSignal').mockReturnValue(h.feishu.commands)
    const item = (id: string) => ({ message_id: id, chat_id: 'oc_team', create_time: String(Date.now()), sender: { id: MEMBER,
      sender_type: 'user' },
      body: { content: '{"text":"@bot fix it"}' } })
    vi.spyOn(h.feishu.commands, 'lark').mockResolvedValue({ has_more: false, items: [item('om_good'), { message_id: 'om_bad',
      chat_id: 'oc_team' }] })
    const tally = { skipped: 0 }
    const since = new Date(Date.now() - 60_000).toISOString()
    await backfillChat(h.feishu, 'oc_team', false, since, new Date().toISOString(), new AbortController().signal, tally)
    expect(tally.skipped).toBe(1)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_good'])
    h.store.close()
  })
  it('waits a second before restarting the event consumer after a run that stayed up for a minute, and backs off otherwise', () => {
    expect(consumerRetry(undefined, 0)).toBe(1000)
    expect(consumerRetry(1000, 500)).toBe(2000)
    expect(consumerRetry(32_000, 500)).toBe(60_000)
    expect(consumerRetry(60_000, 120_000)).toBe(1000)
  })
  it('syncs its part of the Policy from the sync chat: people who left are removed, names follow the chat, new people are appended', async () => {
    const h = host()
    // 同步在其信号下读取聊天，因此停止同步会停止读取。
    const withSignal = vi.spyOn(h.feishu.commands, 'withSignal').mockReturnValue(h.feishu.commands)
    const lark = vi.spyOn(h.feishu.commands, 'lark').mockResolvedValue({ users: [{ member_id: 'ou_carol', name: 'Carol' }, { member_id: MEMBER, name: 'Alice Li' }], has_more: false })
    const sync = feishuKind.policy!.sync!
    expect(sync.ready({ allowed: [] })).toBe(false)
    const signal = new AbortController().signal
    expect(await sync.run(h.feishu, 'feishu', { allowed: [{ id: MEMBER, name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }], syncChat: 'oc_team' }, signal))
      .toEqual({ allowed: [{ id: MEMBER, name: 'Alice Li' }, { id: 'ou_carol', name: 'Carol' }], syncChat: 'oc_team' })
    expect(withSignal).toHaveBeenCalledWith(signal)
    expect(lark.mock.calls[0]![0]).toEqual(expect.arrayContaining(['+chat-members-list', '--chat-id', 'oc_team']))
    lark.mockResolvedValue({ users: [], has_more: true })
    await expect(sync.run(h.feishu, 'feishu', { allowed: [], syncChat: 'oc_team' }, new AbortController().signal)).rejects.toThrow('incomplete member list')
    h.store.close()
  })
})
describe('github source', () => {
  it('normalizes comments and reviews into triggers with review-thread channels, and marks only GitHub Apps and machine accounts as automated', () => {
    const trigger = commentTrigger('github', { id: 5, body: 'nit', user: { login: 'review-bot[bot]', type: 'Bot' }, html_url: 'https://github.com/acme/widgets/pull/7#discussion_r5', updated_at: '2026-09-01T00:00:00Z' }, { number: 7, isPr: true, prAuthor: 'agent-bot' }, 'inline', 'agent-bot')
    expect(trigger).toMatchObject({ source: 'github', threads: [{ source: 'github', id: '7' }], human: false, channel: { address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#discussion_r5' } }, meta: { commentId: 5, kind: 'inline', prAuthor: 'agent-bot' } })
    // 普通账户上的评审机器人在这里按人处理；提示词将其称为自动化的。
    expect(commentTrigger('github', { id: 6, body: 'x', user: { login: 'review-bot', type: 'User' } }, { number: 7, isPr: false }, 'conversation', 'agent-bot').human).toBe(true)
    expect(commentTrigger('github', { id: 7, body: 'x', user: { login: 'ci[bot]', type: 'Bot' } }, { number: 7, isPr: false }, 'conversation', 'agent-bot').human).toBe(false)
    // 评审决定即使没有正文也会到达工单；普通评审评论只携带其正文。
    const review = (fields: Partial<GithubComment>) => commentTrigger('github', { id: 8, user: { login: 'carol', type: 'User' }, submitted_at: '2026-09-01T00:00:00Z', ...fields }, { number: 7, isPr: true }, 'review', 'agent-bot').text
    expect(review({ state: 'APPROVED', commit_id: 'abc123' })).toBe('APPROVED review of commit abc123')
    expect(review({ state: 'CHANGES_REQUESTED', commit_id: 'abc123', body: 'Keep the margin' })).toBe('CHANGES_REQUESTED review of commit abc123\n\nKeep the margin')
    expect(review({ state: 'COMMENTED', commit_id: 'abc123' })).toBe('')
    // 对智能体的提及会构成请求，无论大小写；智能体自己的消息是自动化的。
    expect(commentTrigger('github', { id: 9, body: '@Agent-Bot please fix', user: { login: 'alice', type: 'User' } }, { number: 7, isPr: true }, 'conversation', 'agent-bot')).toMatchObject({ human: true, addressed: 'mention' })
    expect(commentTrigger('github', { id: 10, body: 'mail@agent-bot.example', user: { login: 'alice', type: 'User' } }, { number: 7, isPr: true }, 'conversation', 'agent-bot')).not.toHaveProperty('addressed')
    expect(commentTrigger('github', { id: 11, body: 'pushed', user: { login: 'Agent-Bot', type: 'User' } }, { number: 7, isPr: true }, 'conversation', 'agent-bot').human).toBe(false)
  })
  it('reads the address of an Issue, a PR or a review comment of the repository, and nothing else', () => {
    expect(githubAddress('https://api.github.com/repos/acme/widgets/pulls/9', 'acme/widgets')).toEqual({ number: 9, pr: true })
    expect(githubAddress('https://api.github.com/repos/Acme/Widgets/issues/12', 'acme/widgets')).toEqual({ number: 12, pr: false })
    expect(githubAddress('https://github.com/acme/widgets/pull/7/#discussion_r5', 'acme/widgets')).toEqual({ number: 7, pr: true,
      discussion: 5 })
    expect(githubAddress('https://github.com/acme/widgets/issues/7#issuecomment-3', 'acme/widgets')).toEqual({ number: 7, pr: false })
    for (const url of ['https://github.com/acme/gadgets/pull/7', 'https://api.github.com/repos/acme/widgets/commits/abc',
      'https://github.com/acme/widgets/pull/7/files', '']) {
      expect(githubAddress(url, 'acme/widgets')).toBeUndefined()
    }
  })
  it('matches a branch to a ticket by its short name as the last path segment', () => {
    expect(ticketBranch({ execution: execution('fix-title-1a2b3c') }, 'agent/fix-title-1a2b3c')).toBe(true)
    expect(ticketBranch({ execution: execution('fix-title-1a2b3c') }, 'fix-title-1a2b3c')).toBe(true)
    expect(ticketBranch({ execution: execution('fix-title-1a2b3c') }, 'agent/fix-title-1a2b3c-2')).toBe(false)
    expect(ticketBranch({}, 'agent/x')).toBe(false)
  })
  it('describes CI as one fact: failed checks first, then unfinished ones, otherwise passed', () => {
    const counts = ciCounts({ head: 'abc', checks: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }, { name: 'docs', status: 'completed', conclusion: 'skipped' }], statuses: [{ context: 'deploy', state: 'error' }, { context: 'preview', state: 'pending' }] })
    expect(counts).toEqual({ failed: 2, running: 2 })
    expect(ciFact(counts)).toEqual({ label: { zh: 'CI 失败', en: 'CI failed' }, value: '2', problem: true })
    expect(ciFact({ failed: 0, running: 1 })).toEqual({ label: { zh: 'CI 进行中', en: 'CI running' }, value: '1' })
    expect(ciFact({ failed: 0, running: 0 })).toEqual({ label: 'CI', value: { zh: '通过', en: 'passed' } })
  })
  it('starts a review comment\'s text with its file, line and diff lines, and keeps them and the comment it answers', () => {
    const comment: GithubComment = { id: 5, body: 'Use the theme token', user: { login: 'carol', type: 'User' }, path: 'src/render.ts', line: 43,
      diff_hunk: '@@ -40,6 +40,8 @@\n   const title = view.title\n   const margin = 12\n+  const padding = 8', in_reply_to_id: 4,
      html_url: 'https://github.com/acme/widgets/pull/9#discussion_r5', created_at: '2026-09-09T00:00:00Z' }
    const trigger = commentTrigger('github', comment, { number: 9, isPr: true }, 'inline', 'agent-bot')
    expect(trigger.text).toBe('src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\nUse the theme token')
    expect(trigger.meta).toMatchObject({ path: 'src/render.ts', line: 43, inReplyTo: 4, commentId: 5, kind: 'inline' })
  })
  it('gives an assessment of a review comment the earlier comments of its review thread', async () => {
    const h = host()
    const comment = (id: number, reply?: number) => ({ id, body: `comment ${id}`, user: { login: 'carol', type: 'User' }, path: 'src/render.ts',
      line: 43, html_url: `https://github.com/acme/widgets/pull/9#discussion_r${id}`, created_at: `2026-09-09T00:00:0${id}Z`,
      ...reply ? { in_reply_to_id: reply } : {} })
    vi.spyOn(h.commands, 'pages').mockResolvedValue([comment(1), comment(2, 1), comment(3), comment(4, 1)])
    const trigger = commentTrigger('github', comment(4, 1), { number: 9, isPr: true }, 'inline', 'agent-bot')
    const context = h.sources.threadContext(trigger)!
    const thread = await context.read(h.commands, 'thread')
    expect(thread).toMatchObject({ status: 'review_thread' })
    expect(thread.messages.map(message => message.id)).toEqual([1, 2, 4].map(id => `https://github.com/acme/widgets/pull/9#discussion_r${id}`))
    expect(context.messageId).toBe(thread.messages[2]!.id)
    expect((await context.read(h.commands, 'parent')).messages.map(message => message.id)).toEqual([thread.messages[0]!.id])
    h.store.close()
  })
  it('starts a CI Trigger\'s text with what failed or still runs, so its preview says it', () => {
    const check = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion })
    const failing = { head: 'abc1234def', checks: [check('lint', 'completed', 'failure'), check('e2e', 'completed', 'timed_out'),
      check('unit', 'completed', 'success'), check('docs', 'in_progress', null)], statuses: [] }
    const read = 'github/pulls/9/checks'
    expect(ciSummary(failing, 'PR #9',
      read)).toBe('CI failed 2/4 on PR #9 at abc1234: lint, e2e; 1 still running\nRead github/pulls/9/checks for every check.')
    expect(ciSummary({ ...failing, checks: [check('docs', 'queued', null)] }, 'PR #9',
      read)).toMatch(/^CI running 1\/1 on PR #9 at abc1234: docs/)
    expect(ciSummary({ ...failing, checks: [check('unit', 'completed', 'success')] }, 'PR #9',
      read)).toMatch(/^CI passed 1\/1 on PR #9 at abc1234/)
  })
  it('binds a PR to the unique live ticket on its branch and ends tickets when the PR closes', async () => {
    const h = host()
    const decisionId = 'd'
    const request = feishuTrigger('feishu', { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: '@bot 修一下标题', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(request)
    h.store.tickets.save({ id: 't1', title: 'one', decisionId, mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: MEMBER }, scope: '' }, channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }], assignments: [{ id: 'a', state: 'running', createdAt: '' }], inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution: execution('one'), origin: { triggerId: request.id, triggerIds: [request.id] } })
    const agentsPull = (number: number): Pull => ({ ...openPull(number), user: { login: 'agent-bot' }, head: { sha: 'abc',
      ref: 'agent/one', repo: { full_name: 'acme/widgets' } } })
    await observePull(h, agentsPull(9))
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(9)
    expect(h.store.threads.get('github:9')?.subscriptions).toEqual(['t1'])
    // 跟随 PR 的工单只会因执行器的报告而转移。
    await observePull(h, agentsPull(10))
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(9)
    expect(await observePull(h, endedPull(9, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-09-02T00:00:00.000Z' } })
    expect(h.store.threads.get('github:9')?.subscriptions).toEqual(['t1'])
    // 其结束产生的通知会跟随来源请求的语言。
    const notices = pullEndNotices(h.store.tickets.get('t1')!, request.text, h.deployment.sources)
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', channel: expect.objectContaining({ source: 'feishu' }), text: expect.stringContaining('已合并') })])
    expect(h.executor.stop).toHaveBeenCalledOnce()
    // 合并后恢复，工单继续工作：之后查看已合并的 PR 不会再报告任何内容。
    h.store.tickets.save({ ...h.store.tickets.get('t1')!, ended: undefined, assignments: [...h.store.tickets.get('t1')!.assignments, { id: 'a2', state: 'pending', createdAt: '2026-09-03T00:00:00Z' }] })
    expect(await observePull(h, endedPull(9, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
    // 恢复的工作报告就绪后，工单会随已合并的 PR 结束，就在那时，且没有第二次通知。
    h.engine.report('t1', { state: 'ready', summary: 'answered' })
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
    expect(Date.parse(h.store.tickets.get('t1')!.ended!.at)).toBeGreaterThan(Date.parse('2026-09-03T00:00:00Z'))
    // 其通知拥有第一条的 id，因此只会发出一次。
    expect(pullEndNotices(h.store.tickets.get('t1')!, request.text, h.deployment.sources).map(notice => notice.id)).toEqual(notices.map(notice => notice.id))
    h.store.close()
  })
  it('keeps a ticket working on its other open PR when one of its PRs merges', async () => {
    const h = host()
    h.store.tickets.save({ id: 't3', title: 'three', decisionId: 'd3', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: MEMBER }, scope: '' }, channels: [], assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-01T00:00:00Z' }], inputs: [], undelivered: [], execution: execution('fix-3'), origin: { triggerId: 'x', triggerIds: [] }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })
    expect(claimPull(h, 't3', agentsPull(21, 'agent/fix-3'))).toBeUndefined()
    expect(claimPull(h, 't3', agentsPull(22, 'agent/fix-3'))).toBeUndefined()
    expect(await observePull(h, endedPull(22, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t3')).toMatchObject({ follows: [{ thread: 'github:21', own: true },
      { thread: 'github:22', own: true, closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'merged' } }] })
    expect(h.store.tickets.get('t3')).not.toHaveProperty('ended')
    expect(pullOf(h.store.tickets.get('t3')!)).toBe(21)
    expect(h.executor.stop).not.toHaveBeenCalled()
    expect(await observePull(h, endedPull(21, '2026-09-03T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t3')).toMatchObject({ ended: { outcome: 'merged', at: '2026-09-03T00:00:00.000Z' } })
    // PR 的结束会保留在跟随它的工单上，因此绑定和关闭不会写入键值记录。
    expect(h.store.keys('github-')).toEqual([])
    h.store.close()
  })
  it('follows a PR it opened again when it reopens, while another PR it opened is open', async () => {
    const h = host()
    h.store.tickets.save({ ...openTicket('t5'), execution: execution('fix-5'),
      follows: [{ thread: 'github:21', own: true }, { thread: 'github:22', own: true, closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'closed' } }] })
    await observePull(h, agentsPull(22, 'agent/fix-5'))
    expect(h.store.tickets.get('t5')!.follows).toEqual([{ thread: 'github:21', own: true }, { thread: 'github:22', own: true }])
    h.store.close()
  })
  it('ends a ticket when its own PR merges, though the PR it started from is still open', async () => {
    const h = host()
    h.store.tickets.save({ id: 't4', title: 'four', decisionId: 'd4', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' }, channels: [githubChannel('github', 30, 'https://github.com/acme/widgets/pull/30#issuecomment-1')], assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-01T00:00:00Z' }], inputs: [], undelivered: [], execution: execution('fix-4'), origin: { triggerId: 'x', triggerIds: [] }, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })
    h.store.threads.save({ key: 'github:30', ref: { source: 'github', id: '30' }, createdAt: '', subscriptions: ['t4'], correlated: [], pending: [], meta: { number: 30, isPr: true } })
    expect(claimPull(h, 't4', agentsPull(31, 'agent/fix-4'))).toBeUndefined()
    expect(await observePull(h, endedPull(31, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t4')).toMatchObject({ ended: { outcome: 'merged' } })
    h.store.close()
  })
  it('writes the terminal notice in English for a request without Han characters', async () => {
    const h = host()
    const request = feishuTrigger('feishu', { message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: '@bot fix the title', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(request)
    h.store.tickets.save({ id: 't2', title: 'two', decisionId: 'd2', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'feishu', id: MEMBER }, scope: '' }, channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_2' } }], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', ...pulled(12), origin: { triggerId: request.id, triggerIds: [request.id] } })
    expect(await observePull(h, endedPull(12, '2026-09-02T00:00:00Z', false))).toBe(true)
    expect(pullEndNotices(h.store.tickets.get('t2')!, request.text, h.deployment.sources))
      .toEqual([expect.objectContaining({ text: '[PR #12](https://github.com/acme/widgets/pull/12) was closed without merging.' })])
    h.store.close()
  })
  it('polls subscribed PR threads since their checkpoint and skips the bot\'s own comments', async () => {
    const h = host()
    const thread: Thread = { key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: true } }
    h.store.threads.save(thread)
    const comment = (id: number, login: string, at: string, body: string) => ({ id, body, user: { login }, created_at: at, updated_at: at })
    github(h, { 'issues/7': { ...issue(7, { title: 'Fix the margin' }), pull_request: { url: 'x' } }, 'pulls/7': openPull(7),
      'issues/7/comments': [comment(1, 'agent-bot', '2026-09-01T01:00:00Z', 'mine'), comment(2, 'a', '2026-08-01T00:00:00Z', 'old'),
        comment(3, 'b', '2026-09-01T02:00:00Z', 'new')] })
    await pollGithubThreads(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ actor: { id: 'b' }, text: 'new', threads: [{ source: 'github', id: '7' }] })
    expect(h.store.get('github-cursor:github:7')).toBeDefined()
    // 来源尚未读取标题的线程会以编号和标题命名，并以编号作为事实。
    expect(h.store.threads.get('github:7')!.meta).toMatchObject({ title: 'Fix the margin', label: '#7 Fix the margin', facts: { number: { value: '#7' } } })
    h.store.close()
  })
  it('polls a subscribed Thread for two weeks after the Ticket that follows it ended', async () => {
    const h = host()
    const day = 24 * 3600_000
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date(Date.now() - 30 * day).toISOString(), subscriptions: ['t1'], correlated: [], pending: [],
      meta: { number: 7, isPr: false, title: 'Login fails' } })
    const ended = (ago: number) => h.store.tickets.save({ ...openTicket('t1'),
      ended: { at: new Date(Date.now() - ago).toISOString(), by: 'executor', reason: 'merged', outcome: 'merged' } })
    const reads = github(h, {})
    ended(3 * day)
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments'])
    ended(15 * day)
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments'])
    h.store.close()
  })
  it('polls a subscribed Thread while a live ticket follows it or its last Trigger is under two weeks old', async () => {
    const h = host()
    const day = 24 * 3600_000
    const thread = (lastAt: number, subscriptions = ['t']) => h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' },
      createdAt: '2026-09-01T00:00:00Z', lastAt: new Date(Date.now() - lastAt).toISOString(),
      subscriptions, correlated: [], pending: [], meta: { number: 7, isPr: false, title: 'Login fails' } })
    const reads = github(h, {})
    thread(15 * day)
    await pollGithubThreads(h)
    expect(reads).toEqual([])
    thread(13 * day)
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments'])
    // 活跃工单会让安静的线程保持轮询。
    h.store.tickets.save(openTicket('t9'))
    thread(15 * day, ['t9'])
    await pollGithubThreads(h)
    expect(bare(reads)).toEqual(['issues/7/comments', 'issues/7/comments'])
    h.store.close()
  })
  it('takes in a review decision without a body and skips a plain review comment without one', async () => {
    const h = host()
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: true,
      title: 'Fix the margin' } })
    github(h, { 'pulls/7': openPull(7), 'pulls/7/reviews': [
      { id: 4, state: 'APPROVED', commit_id: 'abc123', user: { login: 'carol', type: 'User' }, submitted_at: '2026-09-02T00:00:00Z' },
      { id: 5, state: 'COMMENTED', commit_id: 'abc123', body: '', user: { login: 'dave', type: 'User' }, submitted_at: '2026-09-02T00:01:00Z' },
    ] })
    await pollGithubThreads(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ actor: { id: 'carol' }, text: 'APPROVED review of commit abc123', meta: { kind: 'review' } })
    h.store.close()
  })
  it('reads each PR once per round and takes its end, auto-merge and CI from that read', async () => {
    const h = host()
    h.store.tickets.save({ ...openTicket('t9'), ...pulled(9) })
    h.store.threads.save({ key: 'github:9', ref: { source: 'github', id: '9' }, createdAt: '', lastAt: new Date().toISOString(),
      subscriptions: ['t9'], correlated: [], pending: [], meta: { number: 9, isPr: true, title: 'Fix' } })
    const pr = { number: 9, title: 'Fix', state: 'open', auto_merge: { merge_method: 'merge' } as unknown,
      html_url: 'https://github.com/acme/widgets/pull/9', user: { login: 'agent-bot' },
      head: { sha: 'abc', ref: 'agent/nine', repo: { full_name: 'acme/widgets' } } }
    const checks = { check_runs: [{ name: 'test', status: 'in_progress', conclusion: null }] }
    const routes: Record<string, unknown> = { notifications: [notification(9, 'pulls')], 'pulls/9': pr, 'commits/abc/check-runs': checks }
    const reads = github(h, routes)
    await pollRound(h)
    // 通知、工单的 PR 和已订阅的线程共享一次 PR 读取。
    expect(reads.filter(path => path === 'pulls/9')).toHaveLength(1)
    const facts = () => h.store.threads.get('github:9')!.meta.facts as Record<string, unknown>
    expect(facts()).toMatchObject({ autoMerge: { label: { zh: '自动合并', en: 'Auto-merge' } }, ci: { value: '1' } })
    routes['pulls/9'] = { ...pr, auto_merge: null }
    routes['commits/abc/check-runs'] = { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }
    await pollRound(h)
    expect(facts()).not.toHaveProperty('autoMerge')
    // 只有第一次查看之后的变化才是触发器。
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta)).toEqual([expect.objectContaining({ ci: true, revision: 1 })])
    routes['pulls/9'] = { ...pr, state: 'closed', merged: true, merged_at: '2026-09-09T00:00:00Z' }
    await pollRound(h)
    expect(h.store.tickets.get('t9')).toMatchObject({ ended: { outcome: 'merged' } })
    h.store.close()
  })
  it('reads each notified Issue alone and reads a failed one again next round, from where it was', async () => {
    const h = host()
    h.store.set('github-since:github', '2026-09-08T00:00:00.000Z')
    h.store.threads.save({ key: 'github:12', ref: { source: 'github', id: '12' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: {} })
    const mention = (id: number, number: number, at: string): GithubComment => ({ id, body: '@agent-bot take this',
      user: { login: 'alice', type: 'User' }, html_url: `https://github.com/acme/widgets/issues/${number}#issuecomment-${id}`,
      created_at: at, updated_at: at })
    const routes: Record<string, unknown> = { notifications: [notification(12), notification(13)], 'issues/12': refused(502, 'Bad Gateway'),
      'issues/13': issue(13, { created_at: '2026-08-01T00:00:00Z' }),
      'issues/13/comments': [mention(1, 13, '2026-09-08T01:00:00Z')] }
    github(h, routes)
    // 因 Issue 缺失之外原因失败的读取会在每个步骤运行后使本轮失败一次。
    await expect(pollRound(h)).rejects.toThrow('#12: Error: gh: Bad Gateway (HTTP 502)')
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.number)).toEqual([13])
    // 游标随它尚未覆盖的 Issue 一起移动。
    expect(Date.parse(h.store.get<string>('github-since:github')!)).toBeGreaterThan(Date.parse('2026-09-08T00:00:00.000Z'))
    expect(h.store.get('github-retry:github')).toEqual({ 12: { since: '2026-09-08T00:00:00.000Z', pr: false, attempts: 1, failedAt: expect.any(String) } })
    expect(h.store.threads.get('github:12')!.meta.pollError).toContain('Bad Gateway')
    Object.assign(routes, { notifications: [], 'issues/12': issue(12, { created_at: '2026-08-01T00:00:00Z' }),
      'issues/12/comments': [mention(2, 12, '2026-09-08T02:00:00Z')] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.number)).toEqual([13, 12])
    expect(h.store.get('github-retry:github')).toEqual({})
    expect(h.store.threads.get('github:12')!.meta).not.toHaveProperty('pollError')
    h.store.close()
  })
  it('drops an Issue GitHub reports as deleted after recording it, and reads one it answers 404 for again', async () => {
    const h = host()
    h.store.set('github-since:github', '2026-09-08T00:00:00.000Z')
    h.store.tickets.save(openTicket('t14'))
    h.store.threads.save({ key: 'github:14', ref: { source: 'github', id: '14' }, createdAt: '', lastAt: new Date().toISOString(),
      subscriptions: ['t14'], correlated: [], pending: [], meta: { number: 14, isPr: false, title: 'Gone' } })
    const deleted = refused(410, 'This issue was deleted')
    github(h, { notifications: [notification(14), notification(15)], 'issues/14': deleted, 'issues/15': deleted })
    await pollRound(h)
    expect(h.store.get('github-retry:github')).toEqual({})
    // 丢弃读取不会移动读取位置。
    expect(h.store.get('github-cursor:github:14')).toBeUndefined()
    expect(h.store.threads.get('github:14')!.meta.pollError).toContain('deleted')
    // 没有线程保存它时，来源的健康状态会点名它。
    expect(h.health.github).toMatchObject({ state: 'ready', detail: '2 notifications; next poll ≥ 60s; deleted on GitHub: #14, #15' })
    // GitHub 对智能体失去访问权限的私有仓库也返回 404：那是一次再次读取的失败。
    github(h, { notifications: [notification(16)] })
    await expect(pollRound(h)).rejects.toThrow('#16: Error: gh: Not Found (HTTP 404)')
    expect(h.store.get('github-retry:github')).toEqual({ 16: expect.objectContaining({ pr: false }) })
    h.store.close()
  })
  it('skips and counts a notification or comment it cannot read, and names the count in the health', async () => {
    const h = host()
    h.store.set('github-since:github', '2026-09-08T00:00:00.000Z')
    const comment = { id: 3, body: '@agent-bot please fix', user: { login: 'alice', type: 'User' },
      html_url: 'https://github.com/acme/widgets/issues/12#issuecomment-3', created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z' }
    github(h, { notifications: [notification(12), { id: 'n-odd', subject: {} }], 'issues/12': issue(12,
      { created_at: '2026-08-01T00:00:00Z' }),
      'issues/12/comments': [comment, { body: 'no id' }] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toEqual(['@agent-bot please fix'])
    expect(h.health.github).toMatchObject({ state: 'ready', detail: '1 notifications; next poll ≥ 60s; 2 unreadable items skipped' })
    h.store.close()
  })
  it('reads every page of the notifications when GitHub says there are more, and waits as long as GitHub asks', async () => {
    const h = host()
    h.store.set('github-since:github', '2026-09-08T00:00:00.000Z')
    const calls: string[][] = []
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      calls.push(args)
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, '').split('?')[0]!
      if (path === 'notifications' && args.includes('--include')) {
        return 'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/notifications?page=2>; rel="next"\r\nX-Poll-Interval: 120\r\n\r\n[]'
      }
      if (path === 'notifications') return JSON.stringify([[notification(12)], [notification(13)]])
      if (/^issues\/\d+$/.test(path)) return JSON.stringify(issue(Number(path.split('/')[1]), { created_at: '2026-08-01T00:00:00Z' }))
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    expect(await pollRound(h)).toBe(120)
    const notifications = calls.filter(args => args[1]!.includes('/notifications'))
    expect(notifications.map(args => args.includes('--paginate'))).toEqual([false, true])
    const paths = calls.map(args => args[1]!.split('?')[0])
    expect(paths).toEqual(expect.arrayContaining(['repos/acme/widgets/issues/12', 'repos/acme/widgets/issues/13']))
    expect(h.health.github).toMatchObject({ state: 'ready', detail: '2 notifications; next poll ≥ 120s' })
    h.store.close()
  })
  it('drops a notified Issue whose reads fail for a day, so the Source leaves the error, and keeps its read position', async () => {
    const h = host()
    h.store.set('github-since:github', '2026-09-08T00:00:00.000Z')
    h.store.threads.save({ key: 'github:16', ref: { source: 'github', id: '16' }, createdAt: '', subscriptions: [], correlated: [], pending: [],
      meta: {} })
    h.store.set('github-cursor:github:16', '2026-09-01T00:00:00.000Z')
    github(h, { notifications: [notification(16)] })
    await expect(pollRound(h)).rejects.toThrow('#16: Error: gh: Not Found (HTTP 404)')
    const first = h.store.get<Record<string, { failedAt: string; attempts: number }>>('github-retry:github')![16]!
    expect(first).toMatchObject({ attempts: 1, failedAt: expect.any(String) })
    // 无论多少次读取失败，一天尚未过去：会重试读取，而本轮仍会失败。
    h.store.set('github-retry:github', { 16: { ...first, attempts: 99 } })
    github(h, { notifications: [] })
    await expect(pollRound(h)).rejects.toThrow('#16')
    // 首次失败读取一天后，它会被丢弃：其线程保留错误，健康状态点名它，而本轮不会
    // 失败。其读取位置保留，因此之后的读取会纳入失败读取遗漏的内容。
    h.store.set('github-retry:github', { 16: { ...first, failedAt: new Date(Date.now() - 25 * 3600_000).toISOString() } })
    await pollRound(h)
    expect(h.store.get('github-retry:github')).toEqual({})
    expect(h.store.get('github-cursor:github:16')).toBe('2026-09-01T00:00:00.000Z')
    expect(h.store.threads.get('github:16')?.meta.pollError).toContain('Not Found')
    expect(h.health.github).toMatchObject({ state: 'ready',
      detail: '0 notifications; next poll ≥ 60s; dropped after their reads kept failing: #16' })
    h.store.close()
  })
  it('polls the PRs of open tickets and subscribed Threads although the notifications fail, and then fails the round', async () => {
    const h = host()
    h.store.set('github-since:github', '2026-09-08T00:00:00.000Z')
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: false,
      title: 'Login fails' } })
    github(h, { notifications: refused(503, 'Service Unavailable'), 'issues/7/comments': [{ id: 3, body: 'still broken',
      user: { login: 'b', type: 'User' }, created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' }] })
    await expect(pollRound(h)).rejects.toThrow('HTTP 503')
    expect(h.receive).toHaveBeenCalledWith(expect.objectContaining({ text: 'still broken' }))
    expect(h.store.get('github-since:github')).toBe('2026-09-08T00:00:00.000Z')
    h.store.close()
  })
  it('takes in the description of a notified PR someone opened since the cursor, as a new PR\'s stream does', async () => {
    const h = host()
    h.store.set('github-since:github', '2026-09-08T00:00:00.000Z')
    const pr = { ...openPull(9), body: '@agent-bot please review', created_at: '2026-09-09T00:00:00Z' }
    github(h, { notifications: [notification(9, 'pulls')], 'pulls/9': pr })
    await pollRound(h)
    const opened = h.receive.mock.calls.map(([trigger]) => trigger).filter(trigger => trigger.meta.kind === 'pull')
    const id = issueTrigger('github', { ...pr, id: 9 } as GithubIssue, 'agent-bot').id
    expect(opened).toEqual([expect.objectContaining({ id, addressed: 'mention', actor: { source: 'github', id: 'carol' },
      meta: expect.objectContaining({ number: 9, isPr: true, prAuthor: 'carol' }) })])
    // 智能体自己的 PR，以及游标之前打开的一个，不会带来描述。
    h.receive.mockClear()
    h.store.set('github-since:github', '2026-09-08T00:00:00.000Z')
    github(h, { notifications: [notification(9, 'pulls')], 'pulls/9': { ...pr, user: { login: 'agent-bot' } } })
    await pollRound(h)
    h.store.set('github-since:github', '2026-09-10T00:00:00.000Z')
    github(h, { notifications: [{ ...notification(9, 'pulls'), updated_at: '2026-09-11T00:00:00Z' }], 'pulls/9': pr })
    await pollRound(h)
    expect(h.receive.mock.calls.filter(([trigger]) => trigger.meta.kind === 'pull')).toEqual([])
    h.store.close()
  })
  it('reads a subscribed default-branch CI Thread as no Issue, and keeps no poll error on it', async () => {
    const h = host()
    h.store.tickets.save(openTicket('ticket'))
    subscribed(h, { source: 'github', id: 'ci:main' })
    h.store.threads.save({ ...h.store.threads.get('github:ci:main')!, lastAt: new Date().toISOString() })
    const reads = github(h, {})
    await pollGithubThreads(h)
    expect(reads).toEqual([])
    expect(h.store.threads.get('github:ci:main')!.meta).not.toHaveProperty('pollError')
    h.store.close()
  })
  it('drops an Issue or a ticket\'s PR that GitHub answers 410 for, and keeps a failed PR read on its Thread', async () => {
    const h = host()
    h.store.set('github-since:github', '2026-09-08T00:00:00.000Z')
    h.store.tickets.save({ ...openTicket('ticket'), follows: [{ thread: 'github:7', own: true }, { thread: 'github:8', own: true }] })
    subscribed(h, { source: 'github', id: '5' }, { number: 5, isPr: false, title: 'Gone' })
    h.store.threads.save({ ...h.store.threads.get('github:5')!, lastAt: new Date().toISOString() })
    // PR 的线程没有订阅者，因此只有工单 PR 的读取会到达它们。
    for (const number of [7, 8]) {
      h.store.threads.save({ key: `github:${number}`, ref: { source: 'github', id: String(number) }, createdAt: '', subscriptions: [],
        correlated: [], pending: [], meta: {} })
    }
    github(h, { notifications: [], 'issues/5/comments': refused(410, 'Gone'), 'pulls/7': refused(410, 'Gone') })
    // 除 #8 外每次 PR 读取都成功或被丢弃；#8 像网络错误一样失败。
    vi.mocked(h.commands.run).mockImplementation(async (_program, args) => {
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, '').split('?')[0]!
      if (path === 'notifications') return 'HTTP/2.0 200 OK\r\n\r\n[]'
      if (path === 'issues/5/comments' || path === 'pulls/7') throw refused(410, 'Gone')
      if (path === 'pulls/8') throw refused(502, 'Bad Gateway')
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    await expect(pollRound(h)).rejects.toThrow(/#8: .*502/)
    expect(h.store.threads.get('github:8')!.meta.pollError).toContain('502')
    expect(h.store.threads.get('github:7')!.meta.pollError).toContain('410')
    vi.mocked(h.commands.run).mockImplementation(async (_program, args) => {
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, '').split('?')[0]!
      if (path === 'notifications') return 'HTTP/2.0 200 OK\r\n\r\n[]'
      if (path === 'issues/5/comments' || path === 'pulls/7' || path === 'pulls/8') throw refused(410, 'Gone')
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    // 每次失败都是 410 时，本轮成功并点名 GitHub 删除的内容。
    await pollRound(h)
    expect(h.health.github).toMatchObject({ state: 'ready', detail: expect.stringContaining('deleted on GitHub: #5, #7, #8') })
    h.store.close()
  })
  it('waits for setup, pauses while the Source is off, and counts only consecutive failed polls towards an error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const start = async (overrides: Partial<SourceContextDeps>,
        github: { enabled: boolean; config: Record<string, unknown> } = { enabled: true, config: {} }) => {
        const board = new HealthBoard()
        const settings = SettingsSchema.parse({ sources: { github: { kind: 'github', ...github } } })
        const sources = new SourceRegistry(() => settings, board)
        healthOf.set(sources, board)
        const dispose = sources.register(githubKind)
        const value = host({ sources, ...overrides })
        const controller = new AbortController()
        const running = githubAdapter.watch(value, 'github', controller.signal)
        return { value, stop: async () => { controller.abort(); await running; dispose(); value.store.close() } }
      }
      const pending = await start({ configured: () => false })
      await vi.waitFor(() => expect(pending.value.health.github).toMatchObject({ state: 'paused', code: 'setupPending' }))
      await pending.stop()
      const off = await start({}, { enabled: false, config: {} })
      await vi.waitFor(() => expect(off.value.health.github).toMatchObject({ state: 'paused', code: 'sourceOff' }))
      await off.stop()
      // 轮次失败、成功、失败、失败：只有连续最后两次才会产生错误。一轮通过自己的命令读取。
      const outcomes = [false, true, false, false]
      let round = 0
      const run = vi.spyOn(Commands.prototype, 'run').mockImplementation(async () => {
        if (!outcomes[round++]) throw refused(502, 'Bad Gateway')
        return 'HTTP/2.0 200 OK\r\n\r\n[]'
      })
      const flaky = await start({}, { enabled: true, config: { failuresBeforeError: 2 } })
      // 每轮读取一次通知，然后等待一分钟进入下一轮。
      const until = async (count: number) => {
        while (round < count) {
          await vi.waitFor(() => expect(round).toBeGreaterThan(0))
          if (round < count) await vi.advanceTimersByTimeAsync(60_000)
        }
      }
      await until(3)
      expect(flaky.value.health.github).toMatchObject({ state: 'ready' })
      await until(4)
      await vi.waitFor(() => expect(flaky.value.health.github).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } }))
      await flaky.stop()
      run.mockRestore()
    } finally { vi.useRealTimers() }
  })
  it('reports a failure that escapes the polling loop as its health instead of an unhandled rejection', async () => {
    // 夹具的注册表尚未持有该类型，以便适配器注册它。
    const value = host({ sources: emptyRegistry({ id: 'github', kind: 'github' }), ready: Promise.reject(new Error('lock held')) })
    const dispose = value.sources.register(githubKind)
    const controller = new AbortController()
    const running = githubAdapter.watch(value, 'github', controller.signal)
    await vi.waitFor(() => expect(value.health.github).toMatchObject({ state: 'error', detail: expect.stringContaining('lock held') }))
    controller.abort(); await running; dispose()
    value.store.close()
  })
  /** GitHub 返回的 Issue，由 alice 打开。 */
  const issue = (number: number, fields: Partial<GithubIssue> = {}): GithubIssue => ({ id: 1000 + number, number, title: 'Login fails',
    body: 'details', state: 'open', created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/acme/widgets/issues/${number}`,
    user: { login: 'alice', type: 'User' }, ...fields })
  /** GitHub 在 `since` 之后被 `pollRound` 读取的内容：每个 Issue 一条通知、Issue 本身，以及按编号的会话评论。 */
  function notify(h: ReturnType<typeof host>, issues: GithubIssue[], comments: Record<number, GithubComment[]> = {},
    since = '2026-09-08T00:00:00.000Z') {
    h.store.set('github-since:github', since)
    // 通知与它报告的最新变化一样新：Issue 或其最新评论。
    const updated = (item: GithubIssue) => [item.updated_at ?? item.created_at,
      ...(comments[item.number] ?? []).map(comment => comment.updated_at ?? '')].sort().at(-1)!
    const notifications = issues.map(item => ({ id: `n${item.number}`, updated_at: updated(item), reason: 'mention',
      repository: { full_name: 'acme/widgets' },
      subject: { url: `https://api.github.com/repos/acme/widgets/issues/${item.number}`, type: 'Issue', title: item.title } }))
    // 作为 PR 的 Issue 也会作为 PR 回答。
    const routes: Record<string, unknown> = { notifications, ...Object.fromEntries(issues.flatMap(item => [[`issues/${item.number}`, item],
      [`pulls/${item.number}`, openPull(item.number)],
      [`issues/${item.number}/comments`, comments[item.number] ?? []]])) }
    return { routes, reads: github(h, routes) }
  }
  it('takes in a new Issue from its notification as a Trigger with its body, addressed to the agent when the body mentions it', async () => {
    const h = host()
    // 在 Issue 地址报告的拉取请求，以及智能体自己打开的 Issue，不会添加任何内容。
    const agents = { user: { login: 'agent-bot', type: 'User' } }
    notify(h, [issue(12, { body: '@agent-bot please fix the login' }), issue(13, { pull_request: { url: 'x' } }), issue(14, agents)])
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledOnce()
    const id = key('github-issue', '12')
    const url = 'https://github.com/acme/widgets/issues/12'
    expect(h.receive.mock.calls[0]![0]).toEqual({ id, source: 'github', threads: [{ source: 'github', id: '12' }],
      actor: { source: 'github', id: 'alice' }, human: true, at: '2026-09-09T00:00:00Z',
      text: 'Login fails\n\n@agent-bot please fix the login', addressed: 'mention', channel: githubChannel('github', 12, url), url,
      meta: { number: 12, isPr: false, kind: 'issue' } })
    // 允许发送者的提及就是该轮询上的明确请求。
    expect(h.engine.candidate(id)?.strength).toBe('explicit')
    expect(h.store.threads.get('github:12')!.meta).toMatchObject({ title: 'Login fails', label: '#12 Login fails' })
    h.store.close()
  })
  it('takes in a comment on an earlier Issue from its notification, without the Issue body', async () => {
    const h = host()
    const url = 'https://github.com/acme/widgets/issues/12'
    const comment: GithubComment = { id: 5, body: '@agent-bot can you take this?', user: { login: 'alice', type: 'User' },
      html_url: `${url}#issuecomment-5`, created_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:00Z' }
    const { reads } = notify(h, [issue(12, { created_at: '2026-08-01T00:00:00Z' })], { 12: [comment] })
    await pollRound(h)
    const expected = commentTrigger('github', comment, { number: 12, isPr: false, url }, 'conversation', 'agent-bot')
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expected])
    // Issue 只有其会话；评论从通知游标之后读取。
    const since = encodeURIComponent('2026-09-08T00:00:00.000Z')
    expect(reads.filter(path => path.includes('/comments'))).toEqual([`issues/12/comments?per_page=100&since=${since}`])
    h.store.close()
  })
  it('keeps one body Trigger for an Issue that a later poll reads again', async () => {
    const h = host()
    // 就在轮询前打开的 Issue 在下一轮读取所依据的游标之后。
    notify(h, [issue(12, { created_at: new Date(Date.now() - 1000).toISOString() })], {}, new Date(Date.now() - 60_000).toISOString())
    await pollRound(h)
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.store.read.threadTriggers('github:12', 10).map(trigger => trigger.id)).toEqual([key('github-issue', '12')])
    expect(h.store.decisions.byThread('github:12').map(decision => decision.triggerIds)).toEqual([[key('github-issue', '12')]])
    h.store.close()
  })
  it('takes in an Issue without a mention as a Trigger that is not addressed, and a bot\'s Issue as automated', async () => {
    const h = host()
    notify(h, [issue(12, { body: 'Login fails on Safari' }), issue(15, { user: { login: 'dependabot[bot]', type: 'Bot' } })])
    await pollRound(h)
    const taken = (number: number) => h.receive.mock.calls.map(([trigger]) => trigger).find(trigger => trigger.meta.number === number)
    const [plain, bot] = [taken(12), taken(15)]
    expect(plain).toMatchObject({ id: key('github-issue', '12'), human: true })
    expect(plain).not.toHaveProperty('addressed')
    expect(bot).toMatchObject({ id: key('github-issue', '15'), human: false })
    // Issue 自己的读取位置会越过本轮读取的内容。
    expect(Date.parse(h.store.get<string>('github-cursor:github:12')!)).toBeGreaterThan(Date.parse('2026-09-08T00:00:00.000Z'))
    h.store.close()
  })
  it('keeps an Issue body the unclaimed-Issue Source stored before as the one Trigger of that body', async () => {
    const h = host()
    const stored: Trigger = { id: key('github-issue', '12'), source: 'github-issue', threads: [{ source: 'github', id: '12' }],
      actor: { source: 'github', id: 'alice' },
      human: true, at: '2026-09-09T00:00:00Z', text: 'Login fails\n\n@agent-bot please fix the login', meta: { number: 12, isPr: false,
        eligibleAt: '' } }
    h.store.triggers.save(stored)
    notify(h, [issue(12, { body: '@agent-bot please fix the login' })])
    await pollRound(h)
    expect(await h.receive.mock.results[0]!.value).toBe('duplicate')
    expect(h.store.read.threadTriggers('github:12', 10)).toEqual([stored])
    h.store.close()
  })
  it('takes in an Issue body only when the Issue was opened since the cursor, not when an edit or a comment changed it', async () => {
    const h = host()
    // 无论谁编辑正文，其作者都会成为参与者，因此编辑添加的提及不会被读取。
    const edited = issue(12, { created_at: '2026-08-01T00:00:00Z', updated_at: '2026-09-09T00:00:00Z',
      body: 'Login fails. @agent-bot can you look?' })
    notify(h, [edited])
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    h.store.close()
  })
  it('reads a PR that a notification names by its Issue address as the PR', async () => {
    const h = host()
    h.store.set('github-since:github', '2026-09-08T00:00:00.000Z')
    const review = { id: 4, state: 'APPROVED', commit_id: 'abc', user: { login: 'carol', type: 'User' },
      submitted_at: '2026-09-09T00:00:00Z' }
    const reads = github(h, { notifications: [notification(9)], 'issues/9': { ...issue(9), pull_request: { url: 'x' } },
      'pulls/9/reviews': [review],
      'pulls/9': { title: 'Fix', state: 'open', html_url: 'https://github.com/acme/widgets/pull/9', user: { login: 'carol' },
        head: { sha: 'abc', ref: 'fix', repo: null } } })
    await pollRound(h)
    expect(bare(reads)).toEqual(['notifications', 'issues/9', 'pulls/9', 'issues/9/comments', 'pulls/9/comments', 'pulls/9/reviews'])
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expect.objectContaining({ text: 'APPROVED review of commit abc',
      meta: expect.objectContaining({ isPr: true }) })])
    h.store.close()
  })
  it('moves no read position when the Source is turned off during a read', async () => {
    const h = host()
    const comment: GithubComment = { id: 5, body: 'more', user: { login: 'alice', type: 'User' }, created_at: '2026-09-09T00:00:00Z',
      updated_at: '2026-09-09T00:00:00Z' }
    const { routes } = notify(h, [issue(12, { created_at: '2026-08-01T00:00:00Z' })], { 12: [comment] })
    routes['issues/12/comments'] = () => {
      h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, github: { kind: 'github', enabled: false, config: {} } } })
      return [comment]
    }
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get('github-cursor:github:12')).toBeUndefined()
    expect(h.store.get('github-since:github')).toBe('2026-09-08T00:00:00.000Z')
    h.store.close()
  })
  it('lets a ticket follow its source PR or the agent\'s PR from its branch, and refuses others', async () => {
    const h = host()
    const source = commentTrigger('github', { id: 1, body: '@agent-bot fix', user: { login: 'alice' },
      html_url: 'https://github.com/acme/widgets/pull/30#issuecomment-1' }, { number: 30, isPr: true }, 'conversation', 'agent-bot')
    h.store.triggers.save(source)
    h.store.tickets.save({ ...openTicket('t1'), execution: execution('fix-1'), origin: { triggerId: source.id, triggerIds: [source.id] } })
    h.store.tickets.save({ ...openTicket('t2'), execution: execution('other-2'), ...pulled(41) })
    const agents = (number: number, ref: string, repo = 'acme/widgets'): Pull => ({ ...openPull(number), user: { login: 'agent-bot' },
      head: { sha: 'abc', ref, repo: { full_name: repo } } })
    expect(claimPull(h, 't1', agents(40, 'agent/fix-1', 'someone/fork'))).toContain('PR does not belong to this ticket')
    expect(claimPull(h, 't1', { ...openPull(31), head: { sha: 'abc', ref: 'agent/fix-1',
      repo: { full_name: 'acme/widgets' } } })).toContain('PR does not belong to this ticket')
    expect(claimPull(h, 't1', agents(41, 'agent/fix-1'))).toBe('PR already belongs to another active ticket')
    // 未打开的 PR 不会被绑定，而这不算拒绝。
    expect(claimPull(h, 't1', { ...agents(42, 'agent/fix-1'), state: 'closed' })).toBeUndefined()
    expect(pullOf(h.store.tickets.get('t1')!)).toBeUndefined()
    expect(claimPull(h, 't1', openPull(30))).toBeUndefined()
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'github:30', own: false }])
    expect(claimPull(h, 't1', agents(43, 'agent/fix-1'))).toBeUndefined()
    expect(h.store.tickets.get('t1')).toMatchObject({ follows: [{ thread: 'github:30', own: false }, { thread: 'github:43', own: true }], channels: [] })
    expect(pullOf(h.store.tickets.get('t1')!)).toBe(43)
    expect(h.store.threads.get('github:43')).toMatchObject({ subscriptions: ['t1'], meta: { isPr: true, prAuthor: 'agent-bot' } })
    // 工单起始的 PR 不是它打开的：当其自己的 PR 合并时，工单会结束而不是跟随它。
    expect(await observePull(h, endedPull(43, '2026-09-02T00:00:00Z'))).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
    expect(claimPull(h, 't1', openPull(30))).toBe('Ticket ended because its PR was closed')
    h.store.close()
  })
})

describe('source context', () => {
  it('gives each kind its own record setup problem', () => {
    const feishu: SetupProblem = { place: 'feishu', code: 'feishuNoBot', values: {}, detail: 'No bot' }
    const github: SetupProblem = { place: 'github', code: 'agentCliUnset', values: {}, detail: 'No CLI' }
    const h = host({ sourceProblems: { feishu, github } })
    expect(h.context(feishuKind, 'feishu').problem).toBe(feishu)
    expect(h.context(githubKind, 'github').problem).toBe(github)
    expect(h.context({ kind: 'probe', health: [] }, 'probe').problem).toBeUndefined()
    h.store.close()
  })
  it('lets a kind report only its own health entries', () => {
    const h = host()
    const github = h.context(githubKind, 'github')
    github.report('github', { state: 'ready', detail: 'ok' })
    expect(h.health.github).toEqual({ state: 'ready', detail: 'ok' })
    expect(() => github.report('feishu', { state: 'error', detail: 'x' })).toThrow('no health entry feishu')
    h.store.close()
  })
  it('patches a Thread\'s meta as it is now, so a change another writer made meanwhile stays', () => {
    const h = host()
    h.store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: { title: 'old', pollError: 'boom' } })
    const snapshot = h.store.threads.get('github:7')!
    h.store.threads.save({ ...snapshot, subscriptions: ['t'], meta: { ...snapshot.meta, label: '#7 old' } })
    h.threads.patch('github:7', { title: 'new', pollError: undefined })
    expect(h.store.threads.get('github:7')).toMatchObject({ subscriptions: ['t'], meta: { title: 'new', label: '#7 old' } })
    expect(h.store.threads.get('github:7')!.meta).not.toHaveProperty('pollError')
    // 不存在的线程不会被创建。
    h.threads.patch('github:8', { title: 'x' })
    expect(h.store.threads.get('github:8')).toBeUndefined()
    h.store.close()
  })
  it('reads the configuration of an instance that is on, removes a record set to undefined, and merges ticket meta', () => {
    const h = host()
    expect(h.feishu.config()).toMatchObject({ directMessages: true })
    h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, feishu: { kind: 'feishu', enabled: false, config: {} } } })
    expect(h.feishu.config()).toBeUndefined()
    h.state.set('github-retry:github', { 1: {} })
    h.state.set('github-retry:github', undefined)
    expect(h.store.keys('github-retry:github')).toEqual([])
    h.store.tickets.save({ ...openTicket('t1'), execution: execution('one') })
    h.tickets.bindThread('t1', { source: 'github', id: '4' }, true)
    // 工单跟随该线程；其其他字段保持原样。
    expect(h.store.tickets.get('t1')).toMatchObject({ follows: [{ thread: 'github:4', own: true }], execution: execution('one'),
      origin: { triggerId: 'source-t1' } })
    h.store.close()
  })
})
it('reports GitHub as failing only after the configured number of consecutive failed polls', () => {
  const eof = new Error('Get "https://api.github.com/x": EOF')
  expect(pollFailure(1, 3, eof)).toBeUndefined()
  expect(pollFailure(2, 3, eof)).toBeUndefined()
  expect(pollFailure(3, 3, eof)).toEqual({ state: 'error', detail: '3 consecutive failed polls; last: Error: Get "https://api.github.com/x": EOF', code: 'pollFailures', values: { count: '3', error: 'Error: Get "https://api.github.com/x": EOF' } })
  expect(githubKind.schema.parse({})).toEqual({ instanceUrl: '', repository: '', cli: '', pollSeconds: 60, failuresBeforeError: 3, observeIssues: false,
    observePulls: false, observeComments: false, observeCi: false })
})
describe('feishu event consumer', () => {
  let dir: string
  let controller: AbortController
  let running: Promise<unknown> | undefined
  // 伪 CLI 是真实进程，整个测试套件运行时启动较慢。
  const until = { timeout: 10_000 }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feishu-consumer-')); controller = new AbortController() })
  afterEach(async () => {
    controller.abort()
    await running
    vi.useRealTimers()
    // Windows 可能在终止后短暂保留上一个 CLI 的文件。
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  /**
   * 一个机器人 CLI，其 `event consume` 按 `mode` 所述运行：`never` 会就绪，`warn` 就绪后警告一次，`ready` 保持运行，
   * 而 `flaky` 在首次就绪后退出。它记录每次运行以及最新运行的 PID。
   */
  function cli(mode: 'never' | 'warn' | 'ready' | 'flaky' | 'events' | 'late' | 'crlf'): string {
    const runsFile = JSON.stringify(join(dir, 'runs')), pidFile = JSON.stringify(join(dir, 'pid'))
    const events = JSON.stringify(join(dir, 'events')), printed = JSON.stringify(join(dir, 'printed'))
    const ready = `process.stderr.write('[event] ready\\n')`
    const stay = 'await sleep(60000); return 0'
    const body = {
      never: stay,
      warn: `process.stderr.write('[event] ready\\nWARN the connection was reset\\n'); ${stay}`,
      ready: `${ready}; ${stay}`,
      flaky: `${ready}; if (runs > 1) { await sleep(60000) } return 1`,
      events: `${ready}; process.stdout.write(fs.readFileSync(${events}, 'utf8')); fs.writeFileSync(${printed}, ''); ${stay}`,
      late: `${ready}; await sleep(1000); process.stdout.write(fs.readFileSync(${events}, 'utf8')); fs.writeFileSync(${printed}, ''); ${stay}`,
      crlf: `${ready}; process.stdout.write(fs.readFileSync(${events}, 'utf8').replaceAll('\\n', '\\r\\n')); fs.writeFileSync(${printed}, ''); ${stay}`,
    }[mode]
    return programSource(dir, 'lark-bot', `const fs = require('node:fs')
if (argv[0] !== 'event') { console.log('{"ok":true,"data":{}}'); return 0 }
const runs = Number(fs.existsSync(${runsFile}) ? fs.readFileSync(${runsFile}, 'utf8').trim() : 0) + 1
fs.writeFileSync(${runsFile}, String(runs))
fs.writeFileSync(${pidFile}, String(process.pid))
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
${body}`)
  }
  const runs = () => existsSync(join(dir, 'runs')) ? Number(readFileSync(join(dir, 'runs'), 'utf8')) : 0
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  /** 飞书来源的上下文，位于一个开启飞书来源的新 Store 上，`cli` 作为机器人 CLI。 */
  function consumerSource(path: string, config: Record<string, unknown> = { chats: [] }) {
    const store = new Store(join(dir, 'db.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { feishu: { kind: 'feishu', enabled: true, config } } }))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(feishuKind)
    const assessor: Assessor = { request: vi.fn(async () => {}) }
    const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
    const policy = () => settingsPolicy(store.settings(), sources)
    const engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, outbox })
    const deployment = testDeployment({ feishu: testFeishu({ cli: path }) })
    const health = board.all
    const commands = new Commands(() => deployment, {}, controller.signal)
    const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment, ready: Promise.resolve(), configured: () => true,
      receive: (trigger: Trigger) => engine.receive(trigger) }
    const turnOff = () => store.saveSettings(SettingsSchema.parse({ sources: { feishu: { kind: 'feishu', enabled: false, config: { chats: [] } } } }))
    return { ctx: sourceContextOf(deps, feishuKind, 'feishu'), health, store, turnOff }
  }

  /** `event consume` 打印的消息事件行；群消息会提及机器人。 */
  const event = (id: string, chat: string, type: 'group' | 'p2p') => JSON.stringify({ message_id: id, chat_id: chat, chat_type: type,
    sender_id: 'ou_alice', sender_type: 'user', content: 'fix it', create_time: String(Date.now()),
    ...type === 'group' ? { mentions: [{ id: 'ou_bot', name: 'Bot' }] } : {} })
  it('takes in the event lines it reads, records each chat as direct or not, and reports a malformed line without stopping', async () => {
    writeFileSync(join(dir, 'events'), [event('om_1', 'oc_group', 'group'), event('om_2', 'oc_dm', 'p2p'), 'not json',
      event('om_3', 'oc_group', 'group')].join('\n') + '\n')
    const { ctx, health, store } = consumerSource(cli('events'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(store.triggers.get(feishuTriggerId('feishu', 'om_3'))).toBeDefined(), until)
    expect(['om_1', 'om_2'].map(id => store.triggers.get(feishuTriggerId('feishu', id))?.meta.direct)).toEqual([false, true])
    expect(store.get(KV.feishu.chats('feishu'))).toEqual({ oc_group: false, oc_dm: true })
    expect(health.feishu).toMatchObject({ state: 'error', detail: expect.stringContaining('JSON') })
    controller.abort(); await running; store.close()
  }, 20_000)
  it('reads event lines that end in CRLF, as a native CLI on Windows prints them', async () => {
    writeFileSync(join(dir, 'events'), event('om_crlf', 'oc_group', 'group') + '\n')
    const { ctx, health, store } = consumerSource(cli('crlf'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(store.triggers.get(feishuTriggerId('feishu', 'om_crlf'))).toBeDefined(), until)
    expect(health.feishu).toMatchObject({ state: 'ready' })
    controller.abort(); await running; store.close()
  }, 20_000)
  it('drops the events it reads once the Source is off', async () => {
    writeFileSync(join(dir, 'events'), event('om_9', 'oc_group', 'group') + '\n')
    const { ctx, health, store, turnOff } = consumerSource(cli('late'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready' }), until)
    turnOff()
    // CLI 在就绪一秒后打印事件，早于消费者因来源关闭而停止。
    await vi.waitFor(() => expect(existsSync(join(dir, 'printed'))).toBe(true), until)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(store.triggers.get(feishuTriggerId('feishu', 'om_9'))).toBeUndefined()
    controller.abort(); await running; store.close()
  }, 20_000)
  it('keeps a chat\'s history cursor when its read fails, and recovers known direct chats only while direct messages are on', async () => {
    const hour = new Date(Date.now() - 3_600_000).toISOString()
    const recovered = async (directMessages: boolean) => {
      const chat = (chatId: string) => ({ chatId, listen: 'mentions' })
      const { ctx, health, store } = consumerSource(cli('ready'), { chats: [chat('oc_a'), chat('oc_b')], directMessages })
      store.set(KV.feishu.chats('feishu'), { oc_dm: true, oc_a: false })
      for (const chat of ['oc_a', 'oc_b', 'oc_dm']) store.set(KV.feishu.history('feishu', chat), hour)
      const chats: string[] = []
      const lark = vi.spyOn(Commands.prototype, 'lark').mockImplementation(async args => {
        const params = args[2] === '/open-apis/im/v1/messages' ? JSON.parse(args.at(-1)!) as { container_id: string } : undefined
        if (params) chats.push(params.container_id)
        if (params?.container_id === 'oc_a') throw new Error('rate limited')
        return { has_more: false, items: [] }
      })
      const stop = new AbortController()
      const loops = runFeishu(ctx, AbortSignal.any([stop.signal, controller.signal]))
      await vi.waitFor(() => expect(['ready', 'error']).toContain(health['feishu:history']?.state), until)
      stop.abort(); await loops; lark.mockRestore()
      const cursors = Object.fromEntries(['oc_a', 'oc_b', 'oc_dm'].map(chat => [chat, store.get(KV.feishu.history('feishu', chat))]))
      const result = { chats, cursors, history: health['feishu:history'] }
      store.close(); rmSync(join(dir, 'db.sqlite'), { force: true }); rmSync(join(dir, 'db.sqlite-wal'), { force: true })
      rmSync(join(dir, 'db.sqlite-shm'), { force: true })
      return result
    }
    const on = await recovered(true)
    expect(on.chats).toEqual(['oc_a', 'oc_b', 'oc_dm'])
    expect(on.history).toMatchObject({ state: 'error', detail: expect.stringContaining('oc_a: Error: rate limited') })
    expect(on.cursors.oc_a).toBe(hour)
    expect(Date.parse(on.cursors.oc_b!)).toBeGreaterThan(Date.parse(hour))
    expect(Date.parse(on.cursors.oc_dm!)).toBeGreaterThan(Date.parse(hour))
    const off = await recovered(false)
    expect(off.chats).toEqual(['oc_a', 'oc_b'])
    expect(off.cursors.oc_dm).toBe(hour)
  }, 20_000)
  it('reports an error when the consumer is not ready within 45 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { ctx, health, store } = consumerSource(cli('never'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(runs()).toBe(1), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    await vi.advanceTimersByTimeAsync(45_000)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'error',
      detail: expect.stringContaining('did not become ready within 45 seconds') }), until)
    expect(alive(pid)).toBe(false)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('reports a warning the consumer prints as an error', async () => {
    const { ctx, health, store } = consumerSource(cli('warn'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'error', detail: 'WARN the connection was reset' }), until)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('stops the consumer within five seconds once the Source is off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { ctx, health, store, turnOff } = consumerSource(cli('ready'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready', detail: 'Listening for bot events' }), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    turnOff()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'paused', code: 'sourceOff' }), until)
    expect(alive(pid)).toBe(false)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('starts the consumer again after it exits, and is ready once the next run listens', async () => {
    const { ctx, health, store } = consumerSource(cli('flaky'))
    running = runFeishu(ctx, controller.signal)
    const exited = { state: 'error', detail: expect.stringContaining('exited (1, ready=true)') }
    await vi.waitFor(() => expect(health.feishu).toMatchObject(exited), until)
    // 第一次重启等待一秒。
    await vi.waitFor(() => expect(runs()).toBe(2), until)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready' }), until)
    controller.abort(); await running; store.close()
  }, 20_000)
})

describe('GitHub instance addresses', () => {
  const instance = 'https://ghe.example.com'
  it('parses pages and API URLs on the record\'s own instance', () => {
    expect(githubAddress(`${instance}/acme/widgets/pull/7/#discussion_r5`, 'acme/widgets', instance))
      .toEqual({ number: 7, pr: true, discussion: 5 })
    expect(githubAddress(`${instance}/api/v3/repos/acme/widgets/issues/3`, 'acme/widgets', instance))
      .toEqual({ number: 3, pr: false })
    expect(githubAddress('https://github.com/acme/widgets/issues/3', 'acme/widgets', instance)).toBeUndefined()
    expect(githubAddress(`${instance}/acme/widgets/issues/3`, 'acme/widgets')).toBeUndefined()
    expect(githubAddress('https://api.github.com/repos/acme/widgets/pulls/9', 'acme/widgets')).toEqual({ number: 9, pr: true })
  })
  it('links to the page on the record\'s own instance', () => {
    expect(githubPage(`${instance}/`, 'acme/gadgets', 8, true)).toBe(`${instance}/acme/gadgets/pull/8`)
    expect(githubKind.channel!.link(githubChannel('github-ghe', 8).address,
      { github: testGithub({ id: 'github-ghe', instanceUrl: `${instance}/`, repository: 'acme/gadgets' }) }))
      .toEqual({ url: `${instance}/acme/gadgets/issues/8`, label: { zh: 'GitHub #8', en: 'GitHub #8' } })
  })
})

describe('observing the GitHub repository', () => {
  /** 前天 `hour` 点，完全在轮询范围内。 */
  const at = (hour: number) => new Date(Math.floor(Date.now() / 86_400_000 - 2) * 86_400_000 + hour * 3_600_000).toISOString()
  const issue = (number: number, fields: Partial<GithubIssue> = {}): GithubIssue => ({ id: 1000 + number, number, title: `Issue ${number}`,
    body: 'details', state: 'open', created_at: at(0), updated_at: at(0),
    html_url: `https://github.com/acme/widgets/issues/${number}`, user: { login: 'carol', type: 'User' }, ...fields })
  const observe = (h: ReturnType<typeof host>, config: Record<string, boolean>) =>
    h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, github: { kind: 'github', enabled: true, config } } })
  /** GitHub 作为仓库列表及其默认分支作答；对未更改列表的 ETag 请求会返回 304。 */
  function repository(h: ReturnType<typeof host>, answers: { issues?: unknown[]; comments?: unknown[]; reviewComments?: unknown[];
    branch?: { sha: string; checks: unknown[] } }) {
    const calls: string[][] = []
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      calls.push(args)
      const bare = args[1]!.replace(/^repos\/acme\/widgets\/?/, '').split('?')[0]!
      const listed = (list: unknown[] | undefined) => `HTTP/2.0 200 OK\r\nETag: "same"\r\n\r\n${JSON.stringify(list ?? [])}`
      if (bare === 'notifications') return 'HTTP/2.0 200 OK\r\n\r\n[]'
      if (args.includes('If-None-Match: "same"')) throw commandError({ stderr: 'gh: HTTP 304', code: 1 })
      if (bare === 'issues') return listed(answers.issues)
      if (bare === 'issues/comments') return listed(answers.comments)
      if (bare === 'pulls/comments') return listed(answers.reviewComments)
      if (bare === '') return JSON.stringify({ default_branch: 'main' })
      if (bare === 'commits/main') return JSON.stringify({ sha: answers.branch!.sha })
      if (bare.endsWith('/check-runs')) return JSON.stringify([{ check_runs: answers.branch!.checks }])
      return JSON.stringify(args.includes('--slurp') ? [[]] : [])
    })
    return calls
  }
  it('takes in the new Issues and PRs from when it started observing them, and asks again with the ETag while nothing is newer',
    async () => {
    const h = host()
    observe(h, { observeIssues: true, observePulls: true })
    h.store.set('github-since:github', at(-24))
    h.store.set('github-stream:github:issues', { since: at(0), started: { issues: at(0), pulls: at(0) } })
    const calls = repository(h, { issues: [issue(3, { created_at: at(-24), updated_at: at(1) }),
      issue(4, { created_at: at(2), updated_at: at(2) }),
      { ...issue(5, { created_at: at(3), updated_at: at(3) }), pull_request: { url: 'x' } },
      issue(6, { created_at: at(4), updated_at: at(4), user: { login: 'agent-bot', type: 'User' } })] })
    await pollRound(h)
    // #3 在来源观察 Issue 之前打开，#6 是智能体自己的。
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.kind, trigger.id]))
      .toEqual([[4, 'issue', issueTrigger('github', issue(4), 'agent-bot').id], [5, 'pull', issueTrigger('github', issue(5), 'agent-bot').id]])
    const started = { issues: at(0), pulls: at(0) }
    expect(h.store.get('github-stream:github:issues')).toEqual({ since: cursorAt(at(4)), started })
    const list = () => calls.filter(args => args[1]!.startsWith('repos/acme/widgets/issues?'))
    expect(list()[0]![1]).toContain(`since=${encodeURIComponent(at(0))}`)
    // 下一轮会在最新 Issue 处重复请求，其后一轮会发送该 ETag，GitHub 对此返回 304。
    await pollRound(h)
    expect(h.store.get('github-stream:github:issues')).toEqual({ since: cursorAt(at(4)), started, etag: '"same"' })
    h.receive.mockClear()
    await pollRound(h)
    expect(list().at(-1)).toEqual(expect.arrayContaining(['-H', 'If-None-Match: "same"']))
    expect(h.receive).not.toHaveBeenCalled()
    // 关闭后，流会忘记其位置，因此再次开启时会重新开始。
    observe(h, {})
    await pollRound(h)
    expect(h.store.get('github-stream:github:issues')).toBeUndefined()
    h.store.close()
  })
  it('keeps two GitHub records\' threads, triggers and cursors apart', async () => {
    const instance = 'https://ghe.example.com/'
    const h = host({ deployment: testDeployment({ sources: {
      github: testGithub(),
      'github-ghe': testGithub({ id: 'github-ghe', instanceUrl: instance, repository: 'acme/gadgets' }) } }) },
    { 'github-ghe': { kind: 'github', enabled: true, config: { repository: 'acme/gadgets', instanceUrl: instance } } })
    const ghe = h.context(githubKind, 'github-ghe')
    // 渠道、线程与触发器都按记录 ID 命名，不会与默认记录共用。
    expect(githubChannel('github-ghe', 7)).toMatchObject({ source: 'github-ghe', thread: 'github-ghe:7' })
    const trigger = commentTrigger('github-ghe', { id: 5, body: 'x', user: { login: 'alice' } }, { number: 7, isPr: true },
      'conversation', 'agent-bot')
    expect(trigger).toMatchObject({ source: 'github-ghe', threads: [{ source: 'github-ghe', id: '7' }],
      actor: { source: 'github-ghe', id: 'alice' }, channel: { source: 'github-ghe', thread: 'github-ghe:7' } })
    // 同样的评论在不同记录上得到不同的触发器 ID。
    const comment = { id: 5, body: 'x', user: { login: 'alice' } }
    expect(trigger.id).not.toBe(commentTrigger('github', comment, { number: 7, isPr: true }, 'conversation', 'agent-bot').id)
    h.store.threads.save({ key: 'github-ghe:7', ref: { source: 'github-ghe', id: '7' }, createdAt: '2026-09-01T00:00:00Z',
      lastAt: new Date().toISOString(), subscriptions: ['t'], correlated: [], pending: [], meta: { number: 7, isPr: true } })
    const reply = { id: 1, body: 'new', user: { login: 'b' }, created_at: '2026-09-01T02:00:00Z', updated_at: '2026-09-01T02:00:00Z' }
    const reads = githubOn(ghe.commands, {
      'issues/7': { ...issue(7, { html_url: `${instance}acme/gadgets/issues/7` }), pull_request: { url: 'x' } },
      'pulls/7': { ...openPull(7), html_url: `${instance}acme/gadgets/pull/7` },
      'issues/7/comments': [reply] }, 'acme/gadgets')
    await pollGithubThreads(ghe)
    expect(reads[0]).toBe('issues/7')
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ source: 'github-ghe', text: 'new',
      threads: [{ source: 'github-ghe', id: '7' }] })
    // 游标写在记录自己的键上，默认记录不受影响。
    expect(h.store.get('github-cursor:github-ghe:7')).toBeDefined()
    expect(h.store.get('github-cursor:github:7')).toBeUndefined()
    h.store.close()
  })
  it('takes in the repository\'s conversation and review comments, on the Issue or PR each is on', async () => {
    const h = host()
    observe(h, { observeComments: true })
    h.store.set('github-since:github', at(-24))
    for (const stream of ['comments', 'review-comments']) {
      h.store.set(`github-stream:github:${stream}`, { since: at(0), started: { comments: at(0) } })
    }
    const comment = (id: number, fields: Record<string, unknown>) => ({ id, body: `comment ${id}`, user: { login: 'carol', type: 'User' },
      created_at: at(1), updated_at: at(1), ...fields })
    repository(h, {
      comments: [comment(1, { issue_url: 'https://api.github.com/repos/acme/widgets/issues/7',
        html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-1' }),
        comment(2, { issue_url: 'https://api.github.com/repos/acme/widgets/issues/9',
          html_url: 'https://github.com/acme/widgets/pull/9#issuecomment-2',
          user: { login: 'dependabot[bot]', type: 'Bot' } })],
      reviewComments: [comment(3, { pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/9', path: 'src/a.ts', line: 4,
        html_url: 'https://github.com/acme/widgets/pull/9#discussion_r3' })] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.isPr, trigger.meta.kind, trigger.human]))
      .toEqual([[7, false, 'conversation', true], [9, true, 'conversation', false], [9, true, 'inline', true]])
    h.store.close()
  })
  it('fails the round for a stream whose read fails, keeps its cursor, and still reads the other streams', async () => {
    const h = host()
    observe(h, { observeIssues: true, observeComments: true })
    h.store.set('github-since:github', at(-24))
    const kind = (stream: string) => stream === 'issues' ? 'issues' : 'comments'
    for (const stream of ['issues', 'comments', 'review-comments']) {
      h.store.set(`github-stream:github:${stream}`, { since: at(0), started: { [kind(stream)]: at(0) } })
    }
    const comment = { id: 1, body: 'looks off', user: { login: 'carol', type: 'User' }, created_at: at(1), updated_at: at(1),
      issue_url: 'https://api.github.com/repos/acme/widgets/issues/7', html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-1' }
    repository(h, { comments: [comment] })
    const run = h.commands.run as unknown as { getMockImplementation(): (program: string, args: string[]) => Promise<string> }
    const answer = run.getMockImplementation()
    vi.mocked(h.commands.run).mockImplementation(async (program, args) => {
      if (args[1]!.startsWith('repos/acme/widgets/issues?')) throw refused(502, 'Bad Gateway')
      return answer(program, args)
    })
    await expect(pollRound(h)).rejects.toThrow(/issues: .*502/)
    expect(h.store.get('github-stream:github:issues')).toEqual({ since: at(0), started: { issues: at(0) } })
    expect(h.receive).toHaveBeenCalledWith(expect.objectContaining({ text: 'looks off' }))
    expect(h.store.get('github-stream:github:comments')).toEqual({ since: cursorAt(at(1)), started: { comments: at(0) } })
    h.store.close()
  })
  it('reads a stream whose cursor is older than the polling horizon from the horizon, without the ETag of the older request', async () => {
    const h = host()
    observe(h, { observeIssues: true })
    h.store.set('github-since:github', at(-24))
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString()
    h.store.set('github-stream:github:issues', { since: old, started: { issues: old }, etag: '"same"' })
    const calls = repository(h, {})
    await pollRound(h)
    const list = calls.find(args => args[1]!.startsWith('repos/acme/widgets/issues?'))!
    expect(list).not.toContain('-H')
    const since = Date.parse(decodeURIComponent(/since=([^&]+)/.exec(list[1]!)![1]!))
    // 地平线，按小时。
    expect(Date.now() - POLL_HORIZON_MS - since).toBeGreaterThanOrEqual(0)
    expect(Date.now() - POLL_HORIZON_MS - since).toBeLessThan(3_600_000)
    h.store.close()
  })
  it('starts the default branch\'s CI afresh when the default branch is renamed, without a Trigger', async () => {
    const h = host()
    observe(h, { observeCi: true })
    h.store.set('github-since:github', at(-24))
    h.store.set('github-branch-ci:github', { branch: 'master', failures: [], revision: 2 })
    const answers = { branch: { sha: 'ddd4444', checks: [{ name: 'lint', status: 'completed', conclusion: 'failure' }] } }
    repository(h, answers)
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get('github-branch-ci:github')).toEqual({ branch: 'main', failures: ['lint'], revision: 2 })
    h.store.close()
  })
  it('takes in new PRs only from when their switch turned on, apart from when new Issues were', async () => {
    const h = host()
    observe(h, { observeIssues: true, observePulls: true })
    h.store.set('github-since:github', at(-24))
    // 流从第 0 小时起纳入 Issue；PR 直到现在才开启。
    h.store.set('github-stream:github:issues', { since: at(0), started: { issues: at(0) } })
    repository(h, { issues: [{ ...issue(5, { created_at: at(2), updated_at: at(2) }), pull_request: { url: 'x' } },
      issue(6, { created_at: at(3), updated_at: at(3) })] })
    await pollRound(h)
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.kind])).toEqual([[6, 'issue']])
    expect(h.store.get<{ started: Record<string, string> }>('github-stream:github:issues')!.started).toEqual({ issues: at(0), pulls: expect.any(String) })
    // 关闭后，类型会忘记其起点。
    observe(h, { observePulls: true })
    await pollRound(h)
    expect(Object.keys(h.store.get<{ started: Record<string, string> }>('github-stream:github:issues')!.started)).toEqual(['pulls'])
    h.store.close()
  })
  it('keeps a stream\'s cursor five seconds before its newest item, and a stale cursor on the hour, so the ETag is sent again', async () => {
    const h = host()
    observe(h, { observeIssues: true })
    h.store.set('github-since:github', at(-24))
    h.store.set('github-stream:github:issues', { since: at(0), started: { issues: at(0) } })
    repository(h, { issues: [issue(6, { created_at: at(3), updated_at: at(3) })] })
    await pollRound(h)
    expect(h.store.get<{ since: string }>('github-stream:github:issues')!.since).toBe(new Date(Date.parse(at(3)) - 5000).toISOString())
    // 落后于地平线的游标会从按小时的地平线读取，下一轮也一样，并发送 ETag。
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString()
    h.store.set('github-stream:github:issues', { since: old, started: { issues: old } })
    const calls = repository(h, {})
    await pollRound(h); await pollRound(h)
    const lists = calls.filter(args => args[1]!.startsWith('repos/acme/widgets/issues?'))
    const since = (args: string[]) => decodeURIComponent(/since=([^&]+)/.exec(args[1]!)![1]!)
    expect(since(lists[0]!)).toBe(since(lists[1]!))
    expect(Date.parse(since(lists[0]!)) % 3_600_000).toBe(0)
    expect(lists[1]).toEqual(expect.arrayContaining(['-H', 'If-None-Match: "same"']))
    h.store.close()
  })
  it('gives each change of the default branch\'s CI its own id, also when one commit fails, passes and fails again', async () => {
    const h = host()
    observe(h, { observeCi: true })
    h.store.set('github-since:github', at(-24))
    const check = (name: string, conclusion: string) => ({ name, status: 'completed', conclusion })
    const answers = { branch: { sha: 'eee5555', checks: [check('lint', 'success')] } }
    repository(h, answers)
    await pollRound(h)
    for (const conclusion of ['failure', 'success', 'failure']) {
      answers.branch = { sha: 'eee5555', checks: [check('lint', conclusion)] }
      await pollRound(h)
    }
    const ids = h.receive.mock.calls.map(([trigger]) => trigger.id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    // 再次关闭并开启后，CI 会从新的首次查看开始，其 id 继续计数。
    observe(h, {})
    await pollRound(h)
    observe(h, { observeCi: true })
    await pollRound(h)
    answers.branch = { sha: 'eee5555', checks: [check('lint', 'success')] }
    await pollRound(h)
    expect(new Set(h.receive.mock.calls.map(([trigger]) => trigger.id)).size).toBe(4)
    h.store.close()
  })
  it('tells of the default branch\'s CI when its failed checks change and once it passes again, after a first look', async () => {
    const h = host()
    observe(h, { observeCi: true })
    h.store.set('github-since:github', at(-24))
    const check = (name: string, conclusion: string | null) => ({ name, status: conclusion ? 'completed' : 'in_progress', conclusion })
    const answers = { branch: { sha: 'aaa1111', checks: [check('lint', 'success'), check('e2e', 'success')] } }
    repository(h, answers)
    const texts = () => h.receive.mock.calls.map(([trigger]) => trigger.text.split('\n')[0])
    await pollRound(h)
    expect(texts()).toEqual([])
    answers.branch = { sha: 'bbb2222', checks: [check('lint', 'failure'), check('e2e', null)] }
    await pollRound(h)
    answers.branch = { sha: 'bbb2222', checks: [check('lint', 'failure'), check('e2e', 'success')] }
    await pollRound(h)
    // 仍在运行的重新运行尚不算恢复；每次检查通过后才会通知恢复。
    answers.branch = { sha: 'ccc3333', checks: [check('lint', null), check('e2e', null)] }
    await pollRound(h)
    answers.branch = { sha: 'ccc3333', checks: [check('lint', 'success'), check('e2e', 'success')] }
    await pollRound(h)
    expect(texts()).toEqual(['CI failed 1/2 on main at bbb2222: lint; 1 still running', 'CI passed 2/2 on main at ccc3333'])
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ human: false, actor: { id: '' }, threads: [{ source: 'github', id: 'ci:main' }],
      meta: { ci: true, branch: 'main', sha: 'bbb2222' }, url: 'https://github.com/acme/widgets/commit/bbb2222' })
    expect(h.receive.mock.calls[0]![0].text).toContain('Read github/commits/bbb2222/checks for every check.')
    h.store.close()
  })
})
describe('Feishu records', () => {
  it('reads page size and link timeout from the record\'s own settings and keeps its keys apart', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: {
      feishu: { kind: 'feishu', enabled: true, config: { readPageSize: 5, linkTimeoutMs: 1000 } },
      'feishu-work': { kind: 'feishu', enabled: true, config: { readPageSize: 33, linkTimeoutMs: 9000 } } } }))
    sources.register(feishuKind)
    expect(feishuSettings(sources, 'feishu')).toMatchObject({ readPageSize: 5, linkTimeoutMs: 1000 })
    expect(feishuSettings(sources, 'feishu-work')).toMatchObject({ readPageSize: 33, linkTimeoutMs: 9000 })
    expect(feishuSettings(sources)).toMatchObject({ readPageSize: 5 })
    expect(KV.feishu.history('feishu', 'oc_1')).not.toBe(KV.feishu.history('feishu-work', 'oc_1'))
    expect(KV.feishu.topics('feishu', 'oc_1')).not.toBe(KV.feishu.topics('feishu-work', 'oc_1'))
    expect(KV.feishu.chats('feishu')).not.toBe(KV.feishu.chats('feishu-work'))
  })
})
