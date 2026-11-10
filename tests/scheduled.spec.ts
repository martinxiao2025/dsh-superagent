import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, key, threadKey } from '../src/core/index.ts'
import type { Assessor, Assignment, Candidate, EngineOptions, Executor, OutboundMessage, Policy, Ticket, Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import type { Mandate } from '../src/core/index.ts'

/**
 * 构造一个只用于定时准入的最小引擎：评估者不应被调用，执行器只记录启动的工单。
 */
function harness() {
  const repo = new MemoryRepositories()
  const launches: string[] = []
  const executor: Executor = {
    start: vi.fn((ticket: Ticket, _assignment: Assignment) => { launches.push(ticket.id) }),
    deliver: vi.fn(), stop: vi.fn(),
  }
  const assessor: Assessor = { request: vi.fn((_candidate: Candidate) => { throw new Error('定时准入不应请求评估') }) }
  const outbox: OutboundMessage[] = []
  const queued: EngineOptions['outbox'] = {
    send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
    status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
    withdraw: vi.fn(),
  }
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: false, reason: '定时准入不经过门禁' }),
    revalidate: () => true, admitsInferred: () => false,
  }
  const engine = new Engine({ repo, executor, assessor, outbox: queued, policy: () => policy,
    scope: { scope: () => ({ listened: true, observed: false }) }, now: () => '2026-11-10T00:00:00.000Z' })
  return { engine, repo, executor, assessor, outbox, launches }
}

/**
 * 构造一个触发器：来源是代码来源记录，线程指向流水线任务项。
 */
function trigger(id = 'pipeline-task-1'): Trigger {
  return { id, source: 'github', threads: [{ source: 'github', id: 'pipeline/pipe/task-1' }], actor: { source: 'pipe', id: 'schedule' },
    human: false, at: '2026-11-10T00:00:00.000Z', text: '修复登录页文案', meta: { repo: 'acme/app' } }
}

describe('scheduled admission', () => {
  it('creates a ticket with an explicit scheduled mandate without asking the assessor', () => {
    const h = harness()
    const result = h.engine.schedule({ trigger: trigger(), pipeline: 'pipe', task: 'task-1', title: '修复登录页文案', scope: '登录页' })
    expect(result.created).toBe(true)
    expect(h.assessor.request).not.toHaveBeenCalled()
    expect(h.launches).toEqual([result.ticketId])
    const ticket = h.repo.tickets.get(result.ticketId)!
    expect(ticket).toMatchObject({ title: '修复登录页文案', channels: [], origin: { triggerId: 'pipeline-task-1', triggerIds: ['pipeline-task-1'] },
      mandate: { strength: 'explicit', policyVersion: 'v1', scope: '登录页', actor: { source: 'pipe', id: 'schedule' },
        basis: { via: 'scheduled', source: 'github', pipeline: 'pipe', task: 'task-1' } } })
    expect(h.repo.threads.get(threadKey(trigger().threads[0]!))?.ref).toEqual({ source: 'github', id: 'pipeline/pipe/task-1' })
    expect(h.repo.triggers.disposition('pipeline-task-1')).toMatchObject({ decisionId: key('decision', 'pipeline-task-1'), fanout: [result.ticketId] })
    expect(h.repo.decisions.get(key('decision', 'pipeline-task-1'))).toMatchObject({ kind: 'accept', ticketId: result.ticketId, threadKey: 'github:pipeline/pipe/task-1' })
  })

  it('is idempotent: the same task item never creates a second ticket or a second assignment', () => {
    const h = harness()
    const first = h.engine.schedule({ trigger: trigger(), pipeline: 'pipe', task: 'task-1', title: 'A', scope: 'x' })
    const second = h.engine.schedule({ trigger: trigger(), pipeline: 'pipe', task: 'task-1', title: 'B', scope: 'y' })
    expect(second).toEqual({ ticketId: first.ticketId, created: false })
    expect(h.launches).toEqual([first.ticketId])
    expect(h.repo.tickets.get(first.ticketId)?.title).toBe('A')
  })
})

describe('scheduled mandate revalidation', () => {
  const mandate = (basis: Partial<Mandate['basis']>): Mandate => ({ strength: 'explicit', policyVersion: 'v1', scope: 'x',
    actor: { source: 'pipe', id: 'schedule' }, basis: { via: 'scheduled', source: 'github', scope: {}, pipeline: 'pipe', task: 'task-1', ...basis } as Mandate['basis'] })
  const settings = SettingsSchema.parse({})

  it('stays valid while both the code source and the pipeline record listen', () => {
    const policy = settingsPolicy(settings, { scope: input => (input.source === 'github' || input.source === 'pipe'
      ? { listened: true as const, observed: false } : { listened: false as const, reason: 'off' }) })
    expect(policy.revalidate(mandate({}))).toBe(true)
  })

  it('is revoked when the pipeline record stops listening or the task id is missing', () => {
    const policy = settingsPolicy(settings, { scope: input => (input.source === 'github'
      ? { listened: true as const, observed: false } : { listened: false as const, reason: 'off' }) })
    expect(policy.revalidate(mandate({}))).toBe(false)
    const both = settingsPolicy(settings, { scope: () => ({ listened: true as const, observed: false }) })
    expect(both.revalidate(mandate({ task: '' }))).toBe(false)
  })
})
