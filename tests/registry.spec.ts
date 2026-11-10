import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { UserError, type OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { feishuChannel, feishuTrigger, feishuTriggerId } from '../src/sources/feishu-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'

const probe: SourceKind<{ interval: number }> = {
  kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
  schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(),
  fields: [{ key: 'interval', type: 'number', min: 1, max: 60, label: { zh: '间隔', en: 'Interval' } }],
}

describe('Source registry', () => {
  it('lists the stored records in id order, marking those whose kind is not installed', () => {
    const settings = SettingsSchema.parse({ sources: { probe: { kind: 'probe', enabled: false, config: { interval: 9 } }, retired: { kind: 'retired', enabled: true, config: { x: 1 } } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(probe); sources.register(githubKind)
    expect(sources.instances()).toEqual([
      { id: 'probe', kind: 'probe', enabled: false, config: { interval: 9 }, installed: true },
      { id: 'retired', kind: 'retired', enabled: true, config: { x: 1 }, installed: false },
    ])
    expect(sources.kindsList().map(kind => kind.kind)).toEqual(['github', 'probe'])
  })
  it('validates submitted instances with the kind schema and refuses records or kinds that are not stored', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { probe: { kind: 'probe', enabled: true, config: {} } } }))
    sources.register(probe)
    expect(sources.validate('probe', { enabled: true, config: {} })).toEqual({ enabled: true, config: { interval: 5 } })
    expect(() => sources.validate('probe', { enabled: true, config: { interval: 0 } })).toThrow()
    expect(() => sources.validate('missing', { enabled: true, config: {} })).toThrow(UserError)
    const retired = new SourceRegistry(() => SettingsSchema.parse({ sources: { retired: { kind: 'retired', enabled: true, config: {} } } }))
    expect(() => retired.validate('retired', { enabled: true, config: {} })).toThrow(UserError)
  })
  it('sends, links and reads a kind\'s Threads through its own channel and context, and nothing for a kind without them', async () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { probe: { kind: 'probe', enabled: true, config: { interval: 7 } } } }))
    const sent: OutboundMessage[] = []
    const read: unknown[] = []
    sources.register({ ...probe,
      channel: { send: async (_host, message) => { sent.push(message); return 'sent' },
        link: address => ({ url: `https://probe/${address.room}`, label: { zh: '探针', en: 'Probe' } }) },
      threadContext: { messageId: trigger => String(trigger.meta.id), read: async (_commands, trigger, part, cursor, config) => {
        read.push([trigger.id, part, cursor, config.interval])
        return { messages: [{ id: 'm1', from: 'u', at: '1', text: '' }],
          body: { page: cursor ?? 'first' } }
      } } })
    const commands = {} as Commands
    const message = (source: string): OutboundMessage => ({ id: 'r1', channel: { source, thread: 'probe:1', address: { room: 'r' } },
      text: 'hi', kind: 'reply' })
    expect(await sources.send(message('probe'), commands)).toBe('sent')
    expect(sent).toEqual([message('probe')])
    // 没有记录的来源视为已删除，其回复无法投递；指向它的链接没有页面。
    expect(await sources.send(message('retired'), commands)).toBe('gone')
    expect(sources.link(message('probe').channel, {})).toEqual({ url: 'https://probe/r', label: { zh: '探针', en: 'Probe' } })
    expect(sources.link(message('retired').channel, {})).toEqual({ url: '', label: { zh: 'retired', en: 'retired' } })
    const trigger = { id: 't1', source: 'probe', threads: [{ source: 'probe', id: '1' }], actor: { source: 'probe', id: 'u' }, human: true,
      at: '', text: 'hi', meta: { id: 'm1' } }
    const context = sources.threadContext(trigger)!
    expect(context.messageId).toBe('m1')
    expect(await context.read(commands, 'thread', '2')).toMatchObject({ body: { page: '2' } })
    expect(read).toEqual([['t1', 'thread', '2', 7]])
    expect(context.images('img_x')).toEqual([])
    await expect(context.image({} as Agent, commands, { id: 'm1', text: '' }, 'img_x', '',
      new AbortController().signal)).rejects.toThrow('no images')
    // 没有渠道或上下文的类型两者都没有。
    sources.register({ ...probe, kind: 'quiet' })
    expect(await sources.send(message('quiet'), commands)).toBe('gone')
    expect(sources.threadContext({ ...trigger, source: 'quiet' })).toBeUndefined()
  })
  it('refuses a kind that declares a health entry another kind or dsh-superagent itself reports, and gives up its entries at unregister', () => {
    const board = new HealthBoard()
    // 预先占用内置健康条目；sync:* 条目保留给设置同步。
    for (const name of ['runtime', 'reply']) board.claim(name)
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const unregister = sources.register(githubKind)
    expect(() => sources.register({ ...probe, health: ['github'] })).toThrow('declares the health entry github')
    for (const name of ['runtime', 'reply', 'sync:github']) expect(() => sources.register({ ...probe, health: ['probe', name] })).toThrow(name)
    expect(sources.kindByName('probe')).toBeUndefined()
    sources.register({ ...probe, health: ['probe'] })
    const context = (kind: { kind: string; health: readonly string[] }) => sourceContextOf({ sources } as unknown as SourceContextDeps, kind)
    const first = context(githubKind)
    first.report('github', { state: 'ready', detail: 'ok' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'ok' })
    expect(() => first.report('probe', { state: 'ready', detail: '' })).toThrow('has no health entry probe')
    // 在所属类型注销后发出的报告（例如来自正在退出的 CLI 监听器）会被忽略，且不影响之后的注册。
    unregister()
    expect(() => first.report('github', { state: 'error', detail: 'WARN exiting' })).not.toThrow()
    expect(board.all.github).toBeUndefined()
    sources.register(githubKind)
    first.report('github', { state: 'error', detail: 'late' })
    expect(board.all.github).toEqual({ state: 'starting', detail: '' })
    context(githubKind).report('github', { state: 'ready', detail: 'again' })
    expect(board.all.github).toEqual({ state: 'ready', detail: 'again' })
  })
  it('names the Trigger whose message a Trigger\'s message answers, where its kind can', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { kind: 'feishu', enabled: true, config: {} },
      github: { kind: 'github', enabled: true, config: {} } } }))
    sources.register(feishuKind); sources.register(githubKind)
    const reply = feishuTrigger({ message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: 'ou_alice', sender_type: 'user',
      content: 'yes', create_time: '1757376000000', parent_id: 'om_1' }, 'ou_bot', 'cli_bot')!
    expect(sources.repliesTo(reply)).toBe(feishuTriggerId('om_1'))
    expect(sources.repliesTo({ ...reply, meta: { ...reply.meta, parentId: undefined } })).toBeUndefined()
    expect(sources.repliesTo({ ...reply, source: 'github' })).toBeUndefined()
  })
  it('finds what a search query names in each kind\'s terms', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.find('#12')).toEqual({ threads: ['github:12'], terms: [] })
    expect(sources.find('https://github.com/acme/widgets/pull/7#issuecomment-3')).toEqual({ threads: ['github:7'], terms: [] })
    expect(sources.find('see om_abc and om_abc, om_def')).toEqual({ threads: [], terms: ['om_abc', 'om_def'] })
    expect(sources.find('login fails')).toEqual({ threads: [], terms: [] })
    expect(feishuKind.policy!.unnamed).toEqual({ person: { zh: '飞书用户', en: 'Feishu user' }, bot: { zh: '飞书机器人', en: 'Feishu bot' } })
  })
  it('refuses a second registration of one kind and forgets a kind after its disposer runs', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    const dispose = sources.register(probe)
    expect(() => sources.register(probe)).toThrow('already registered')
    dispose()
    expect(sources.instance('probe')).toBeUndefined()
  })
  it('validates each Source\'s part of the Policy with its kind, keeping parts of kinds that are not installed as stored', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } },
      sources: { feishu: { kind: 'feishu', enabled: true, config: {} }, github: { kind: 'github', enabled: true, config: {} } } }))
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.validatePolicy({ feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] }, retired: { allowed: [], x: 1 } }))
      .toEqual({ feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: '', admission: {} }, retired: { allowed: [], x: 1 } })
    expect(() => sources.validatePolicy({ feishu: { allowed: [{ id: 'alice' }] } })).toThrow()
    expect(sources.policyPart('feishu')).toEqual({ allowed: [{ id: 'ou_alice' }], syncChat: '', admission: {} })
    expect(sources.policyPart('github')).toEqual({ allowed: [], admission: {} })
    sources.register(probe)
    expect(sources.policyPart('probe')).toBeUndefined()
  })
  it('allows a reply only on a Channel whose Source still listens to its chat', () => {
    const settings = SettingsSchema.parse({ sources: { feishu: { kind: 'feishu', enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }], directMessages: false } },
      github: { kind: 'github', enabled: true, config: {} } } })
    const sources = new SourceRegistry(() => settings)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_team' } })).toBe(false)
    sources.register(feishuKind); sources.register(githubKind)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_team' } })).toBe(true)
    expect(sources.channelAllowed({ source: 'feishu', address: { chatId: 'oc_other' } })).toBe(false)
    // 直接聊天 ID 也以 oc_ 开头；地址表明它是直接聊天，而关闭直接消息后它不会得到回复。
    expect(sources.channelAllowed(feishuChannel('oc_dm', 'om_1', true))).toBe(false)
    expect(sources.channelAllowed({ source: 'github', address: { number: '7' } })).toBe(true)
  })
  it('delivers a reply to a direct message under the default settings', async () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { kind: 'feishu', enabled: true, config: {} } } }))
    sources.register(feishuKind)
    const trigger = feishuTrigger({ message_id: 'om_dm', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: 'ou_alice', sender_type: 'user',
      content: 'fix it', create_time: '1757376000000' }, 'ou_bot', 'cli_bot')!
    const channel = trigger.channel!
    expect(channel.address).toEqual({ chatId: 'oc_dm', messageId: 'om_dm', direct: 'true' })
    expect(sources.channelAllowed(channel)).toBe(true)
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue('{"ok":true,"data":{}}')
    const reply: OutboundMessage = { id: 'reply-1', channel, text: 'Done', kind: 'reply' }
    expect(await sources.send(reply, commands)).toBe('sent')
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['+messages-reply', '--message-id', 'om_dm']))
  })
})
