/** UsageMeter：用量归因落账（master/worker）与两档预算（软档提醒+子代理封锁、硬档结束工单）。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Engine, Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { Store } from '../src/app/store.ts'
import { UsageMeter } from '../src/app/usage-meter.ts'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const ticket = (): Ticket => ({
  id: 't1', title: '修一下', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v', scope: '修一下',
    actor: { source: 'feishu', id: 'ou_a' }, basis: { via: 'addressed', addressed: 'mention' } },
  origin: { triggerId: 'trig-1', triggerIds: ['trig-1'] },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
})
/** 一台最小宿主：真 Store（临时 SQLite），事件由测试直接 emit；`exhaustTicket` 打桩并真实结束工单。 */
function fixture(options: { budget?: { totalTokens?: number }; projectBudget?: { totalTokens?: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-')); dirs.push(dir)
  const store = new Store(join(dir, 'test.sqlite')); stores.push(store)
  store.projects.save('p1', { name: 'P', enabled: true, execution: { directory: '', branch: '', prepare: '', gitTimeoutSeconds: 0,
    ...(options.projectBudget ? { budget: options.projectBudget } : {}) } } as never)
  store.saveSettings({ executor: { ...(options.budget ? { budget: options.budget } : {}) } } as never)
  const ctx = new Context()
  const exhaust = vi.fn((id: string, reason: string) => {
    const current = store.tickets.get(id)
    if (current && !current.ended) store.tickets.save({ ...current, ended: { at: '2026-01-01T01:00:00Z', by: 'executor' as const,
      outcome: 'stopped' as const, reason } })
    return store.tickets.get(id)!
  })
  const engine = { exhaustTicket: exhaust } as unknown as Engine
  const relays: { id: string; text: string }[] = []
  const prompts: { sessionId: string; requestId: string; text: string }[] = []
  const meter = new UsageMeter({ store, masterId: 'master-1', engine, lifetime: new AbortController().signal,
    sessions: { relay: (id, text) => { relays.push({ id, text }) },
      prompt: (sessionId, requestId, text) => { prompts.push({ sessionId, requestId, text }); return Promise.resolve() } } }, ctx)
  meter.install()
  const emit = (sessionId: string, usage: { inputTokens: number; outputTokens: number }, turn = 1, step = 1) => {
    // 直接构造事件对象：assistant/message 是 surface 事件，Session.append 会要求 surfaceOp 标记，
    // 而 UsageMeter 只读 `session.id` 与事件数据，手工 emit 绕开 surface 校验。
    const session = { id: SessionId(sessionId) } as never
    const event = { type: 'assistant/message', seq: 1, time: Date.now(),
      data: { turn, step, message: { role: 'assistant', content: [] },
        usage: { ...usage, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 7 } } } as never
    ctx.emit('session/event', session, event)
  }
  return { store, meter, relays, prompts, exhaust, emit, seed: (t: Ticket = ticket()) => store.tickets.save(t) }
}

it('attributes a master message and a worker message to their scopes and tickets', () => {
  const { store, emit, seed } = fixture()
  seed()
  emit('master-1', { inputTokens: 10, outputTokens: 5 })
  emit('worker-t1', { inputTokens: 20, outputTokens: 8 })
  const all = store.usage.recent(10)
  expect(all.map(record => record.scope)).toEqual(['worker', 'master'])
  expect(all[0]).toMatchObject({ ticket: 't1', session: 'worker-t1', provider: 'unknown', model: 'unknown', cacheRead: 100, reasoning: 7 })
  expect(store.usage.sumTicket('t1')).toMatchObject({ requests: 1, input: 20, output: 8 })
})

it('warns once at the soft threshold, blocks subagents, and relays to the master', () => {
  const { store, meter, relays, prompts, emit, seed } = fixture({ budget: { totalTokens: 1000 } })
  seed()
  // 计入 cacheRead：每请求 consumed = input + cache 100 + output。两请求合计 900（90%），落在软档。
  emit('worker-t1', { inputTokens: 300, outputTokens: 100 })
  emit('worker-t1', { inputTokens: 250, outputTokens: 50 })
  expect(relays).toHaveLength(1)
  expect(relays[0]!.id).toBe('budget-soft:t1')
  expect(prompts[0]!.sessionId).toBe('worker-t1')
  expect(meter.subagentsBlocked('t1')).toBe(true)
  expect(store.tickets.get('t1')!.ended).toBeUndefined()
  // 软档提醒每工单一次：继续用量不再重复转发。
  emit('worker-t1', { inputTokens: 10, outputTokens: 10 })
  expect(relays).toHaveLength(1)
})

it('prefers the project budget over the global one', () => {
  const { store, relays, emit, seed } = fixture({ budget: { totalTokens: 100_000 }, projectBudget: { totalTokens: 1000 } })
  seed()
  store.tickets.save({ ...store.tickets.get('t1')!, execution: { project: 'p1' } } as never)
  // 项目预算 1000：两请求合计 900 已过软档；全局 100_000 还远未到，出现提醒即证明用的是项目预算。
  emit('worker-t1', { inputTokens: 300, outputTokens: 100 })
  emit('worker-t1', { inputTokens: 250, outputTokens: 50 })
  expect(relays).toHaveLength(1)
})

it('ends the ticket at the hard threshold and explains the cut-off to the worker', () => {
  const { store, relays, prompts, exhaust, emit, seed } = fixture({ budget: { totalTokens: 1000 } })
  seed()
  emit('worker-t1', { inputTokens: 900, outputTokens: 200 })
  expect(exhaust).toHaveBeenCalledOnce()
  const ended = store.tickets.get('t1')!.ended
  expect(ended).toMatchObject({ outcome: 'stopped', by: 'executor', reason: expect.stringContaining('Token budget exhausted') })
  // 硬档越过软档：不重复提醒；被截断回合的工作单元收到一次 budget_hard 解释（幂等 requestId，不唤醒）。
  expect(relays).toHaveLength(0)
  expect(prompts.map(prompt => prompt.requestId)).toEqual(['budget-hard:t1'])
  expect(prompts[0]!.sessionId).toBe('worker-t1')
  expect(prompts[0]!.text).toContain('"budget_hard":true')
})

it('ignores usage without a budget and messages without usage accounting', () => {
  const { store, meter, relays, emit, seed } = fixture()
  seed()
  emit('worker-t1', { inputTokens: 5_000_000, outputTokens: 5_000_000 })
  expect(store.tickets.get('t1')!.ended).toBeUndefined()
  expect(relays).toHaveLength(0)
  expect(meter.subagentsBlocked('t1')).toBe(false)
  expect(store.usage.recent(10)).toHaveLength(1)
})

it('aggregates the retrospective by revision with the ticket outcomes joined in', () => {
  const { store, emit, seed } = fixture()
  seed()
  const done = { ...ticket(), id: 't2' }
  store.tickets.save({ ...done, ended: { at: '2026-01-02T00:00:00Z', by: 'executor' as const, outcome: 'completed' as const } })
  // 两个请求绑定修订 3：t1 一个请求、t2 一个请求。
  store.set(KV.sessions.prompts('worker-t1'), [3])
  store.set(KV.sessions.prompts('worker-t2'), [3])
  emit('worker-t1', { inputTokens: 100, outputTokens: 10 })
  emit('worker-t2', { inputTokens: 200, outputTokens: 20 })
  const buckets = store.read.retro('revision')
  // 计费输入含 cacheRead（各 100）：500 = (100+100) + (200+100)。
  expect(buckets).toEqual([expect.objectContaining({ key: '3', tickets: 2, requests: 2, input: 500, output: 30, completed: 1 })])
  const models = store.read.retro('model')
  expect(models[0]).toMatchObject({ key: 'unknown', requests: 2 })
  expect(store.read.retro('stage')).toEqual([])
})
