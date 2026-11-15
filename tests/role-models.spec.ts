/** 每请求模型路由：override 非空时逐请求覆盖路由与提示词变量；返回 null 时继承宿主；路由解析按配置缓存。 */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { applyRequestModel } from '../src/app/role-models.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  // agent 事件按作用域过滤：给假智能体一个与 ctx 绑定的作用域，让 prepend 监听可达。
  createScope(ctx, agent as never)
  // 宿主默认值经由 DSH 的请求管线提供；这里用 `agent/request` 兜底监听模拟宿主路由，
  // 使「每请求覆盖优先于宿主」的行为可测（applyRequestModel 的 prepend 监听改写兜底结果）。
  const hostDefault = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
  ctx.effect(() => ctx.on('agent/request', async (_payload, next) => await next().then(() => hostDefault)))
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  return { ctx, agent, request, resolve }
}
it('overrides every request with the current route and updates the prompt variables', async () => {
  const { ctx, agent, request, resolve } = await fixture()
  let route: ModelSelection | null = { provider: 'worker-provider', model: 'worker-model' }
  applyRequestModel(ctx, agent, () => route)
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  expect(await request()).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  // 阶段切换：override 返回新路由后，下一个请求立即使用它。
  route = { provider: 'stage-provider', model: 'stage-model', reasoningEffort: ReasoningEffortId('low') }
  expect(await request()).toEqual({ provider: 'stage-provider', model: 'stage-model', reasoningEffort: ReasoningEffortId('low') })
  await ctx.systemPrompt.assemble()
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'stage-provider', model: 'stage-model' })
  // 同一路由的解析只发生一次（缓存），两个 provider/model 各一次。
  expect(resolve).toHaveBeenCalledTimes(2)
})
it('inherits the host default while the route is unset, and picks the route up when it arrives', async () => {
  const { ctx, agent, request, resolve } = await fixture()
  let route: { provider: string; model: string } | null = null
  applyRequestModel(ctx, agent, () => route)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual({ provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') })
  route = { provider: 'late', model: 'comer' }
  expect(await request()).toEqual({ provider: 'late', model: 'comer' })
  expect(resolve).toHaveBeenCalledTimes(1)
})
