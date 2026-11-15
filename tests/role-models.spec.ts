import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  // agent 事件按作用域过滤：给假智能体一个与 ctx 绑定的作用域，让 prepend 监听可达。
  createScope(ctx, agent as never)
  // 宿主默认值经由 DSH 的请求管线提供；这里用 `agent/request` 兜底监听模拟宿主路由，
  // 使「角色模型优先于宿主」的行为可测（initializeRoleModel 的 prepend 监听先改写 seed 结果）。
  const hostDefault = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
  // 模拟 DSH 的模型选择：已持久化的请求头或显式选择优先，否则宿主默认（initializeRoleModel 的 prepend 监听先改写 seed）。
  ctx.effect(() => ctx.on('agent/request', async (_payload, next) => {
    await next()
    const recorded = (session.requestHeader()?.config ?? session.snapshotEvents()
      .filter(event => event.type === 'model/selection').at(-1)?.data) as ModelSelection | undefined
    return recorded ?? hostDefault
  }))
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const record = (selection: ModelSelection) => { const event = session.append('request/header', { header: { config: selection }, reason: 'initial' }); ctx.emit('session/event', session, event) }
  return { ctx, agent, request, resolve, flush, record }
}
it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  const { ctx, agent, request, record, flush } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  const selected = await request(); console.log('DEBUG selected:', JSON.stringify(selected), 'assembled-check:', (agent as unknown as { ctx: { get(n: string): unknown } }).ctx.get('x') ?? 'na')
  expect(selected).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(flush).toHaveBeenCalledOnce()
  record(selected)
  // 同一已组装步骤的重试会保持同一模型，即使请求头已被持久化。
  expect(await request()).toEqual(selected)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(selected)
})
it('lets a later explicit selection win without changing the in-flight assembled step', async () => {
  const { ctx, agent, request } = await fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  const event = agent.session.append('model/selection', manual); ctx.emit('session/event', agent.session, event)
  expect(await request()).toEqual({ provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(manual)
})
it.each(['header', 'selection'])('preserves a resumed Session with existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else agent.session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, request } = await fixture()
  await initializeRoleModel(ctx, agent, null)
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(false)
})
