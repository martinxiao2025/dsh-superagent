/**
 * 每请求模型路由：按角色与阶段在每次模型请求上覆盖 provider/model/effort。
 * 覆盖点是 DSH 的 `agent/request` waterfall——监听器拿到 `next()` 的默认配置后按需改写；
 * 未配置（null）时原样放行，即继承宿主默认，零配置零行为变化。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'

/** 通过活动提供方解析已配置的路由；是否属于目录并不是限制条件。 */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}
/**
 * 在智能体上安装每请求模型覆盖（随 `agent.ctx.effect` 生存，智能体释放时自动拆除）：
 * `override` 在每次模型请求时调用，返回该请求应使用的配置；返回 `null`/`undefined` 时该请求
 * 继承既有选择（宿主默认或会话内手动选择）。同一路由的解析结果按配置缓存，失败即逐出。
 */
export function applyRequestModel(ctx: Context, agent: Agent, override: () => RoleModel | null | undefined): void {
  const cache = new Map<string, Promise<ModelSelection>>()
  const resolve = (model: RoleModel): Promise<ModelSelection> => {
    const route = JSON.stringify(model)
    const cached = cache.get(route)
    if (cached) return cached
    const promise = resolveRoleModel(ctx, model)
    promise.catch(() => cache.delete(route))
    cache.set(route, promise)
    return promise
  }
  agent.ctx.effect(() => {
    let applied: ModelSelection | undefined
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const model = override()
        // 组装先于每一步的请求：这里同样应用覆盖，使 {provider}/{model} 变量与本次请求的实际路由一致。
        applied = model ? await resolve(model) : undefined
        const result = await next()
        return applied ? { ...result, variables: { ...result.variables, provider: applied.provider, model: applied.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const model = override()
        if (!model) { applied = undefined; return next() }
        const selected = await resolve(model)
        applied = selected
        // 剥掉继承的 reasoningEffort 再整体叠加，与既有"覆盖优先"语义一致。
        const { reasoningEffort: _inherited, ...rest } = await next()
        return { ...rest, ...selected }
      }, { prepend: true }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
}
