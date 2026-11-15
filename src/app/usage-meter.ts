/**
 * 模型用量计量与工单预算闸。
 * 计量：监听 `agent/request`（记住每 turn/step 实际使用的路由）与 `session/event` 的
 * `assistant/message`（携带宿主适配器的 `usage`），按工单归因（子代理沿父链上溯）后写入 `Store.usage`。
 * 预算：每条记录落库后按工单求和对照 `executor.budget`（项目 `execution.budget` 优先）——
 * 软档 80% 注入 worker 引导收敛并转发主会话（每工单一次），同时禁止其再启动子代理；
 * 硬档 100% 经 `Engine.exhaustTicket` 结束工单（outcome `stopped`、by `executor`）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { EngineForExecutor } from '../core/index.ts'
import { ticketOfSession, workerSessionId } from '../executor/format.ts'
import { KV } from '../kv.ts'
import type { Sessions } from './sessions.ts'
import type { Store, UsageRecord } from './store.ts'

/** `UsageMeter` 使用的宿主依赖。 */
export interface UsageHost {
  readonly store: Pick<Store, 'usage' | 'tickets' | 'get' | 'settings' | 'projects'>
  readonly masterId: string
  readonly engine: Pick<EngineForExecutor, 'exhaustTicket'>
  readonly sessions: Pick<Sessions, 'relay' | 'prompt'>
  readonly lifetime: AbortSignal
}
/** 一条用量记录的归因结果：范围与（worker/subagent 时的）工单。 */
interface Attribution { scope: UsageRecord['scope']; ticket?: string }
/** 预算的软档阈值：达到即提醒收敛并封锁子代理。 */
const SOFT = 0.8
/**
 * 监听宿主会话事件，把每次模型请求的 token 用量按工单归因落账（`Store.usage`），并执行两档预算：
 * 软档 80% 注入 worker 引导收敛、封锁子代理并转发主会话；硬档 100% 经 `Engine.exhaustTicket` 结束工单。
 */
export class UsageMeter {
  /** 每个 `${session}:${turn}:${step}` 实际使用的路由；`assistant/message` 以同键取回。 */
  private readonly requests = new Map<string, { provider: string; model: string }>()
  /** 已发过软档提醒的工单；硬档或提醒后不再重复。 */
  private readonly softNotified = new Set<string>()
  constructor(private readonly host: UsageHost, private readonly ctx: Context) {}
  /** 订阅宿主事件；由 Runtime 在初始化时调用一次。 */
  install(): void {
    const ctx = this.ctx
    // 旁观 waterfall：记录每步实际使用的路由，不改写结果。
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      const config: LlmCallConfig = await next()
      if (this.host.lifetime.aborted) return config
      this.requests.set(`${agent.id}:${turn}:${step}`, { provider: String(config.provider ?? ''), model: String(config.model ?? '') })
      return config
    })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const key of this.requests.keys()) if (key.startsWith(`${agent.id}:`)) this.requests.delete(key)
    })
    ctx.on('session/event', (session, event) => this.observe(session.id, event))
  }
  /** 处理一条会话事件；`assistant/message` 且带 `usage` 时落库并执行预算判定。 */
  private observe(sessionId: string, event: SessionEvent): void {
    if (event.type !== 'assistant/message') return
    const usage = event.data.usage
    if (!usage) return
    if (this.host.lifetime.aborted) return
    const route = this.requests.get(`${sessionId}:${event.data.turn}:${event.data.step}`) ?? { provider: 'unknown', model: 'unknown' }
    const at = new Date().toISOString()
    const attributed = this.attribute(sessionId)
    const ticket = attributed.ticket ? this.host.store.tickets.get(attributed.ticket) : undefined
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    const record: UsageRecord = {
      at, session: sessionId, scope: attributed.scope, ...(attributed.ticket ? { ticket: attributed.ticket } : {}),
      provider: route.provider, model: route.model, ...(ticket?.stage ? { stage: ticket.stage } : {}),
      input: usage.inputTokens, output: usage.outputTokens, ...(usage.totalTokens !== undefined ? { total: usage.totalTokens } : {}),
      cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0, reasoning: usage.reasoningTokens ?? 0,
      ...(revision !== undefined ? { promptRevision: revision } : {}),
    }
    this.host.store.usage.add(record)
    if (attributed.ticket) this.enforce(attributed.ticket)
  }
  /** 会话归属：主会话、工单工作单元（会话 ID 即工单键），或经父链归因的子代理。 */
  private attribute(sessionId: string): Attribution {
    if (sessionId === this.host.masterId) return { scope: 'master' }
    const ticketId = ticketOfSession(sessionId)
    if (ticketId !== undefined) return { scope: 'worker', ticket: ticketId }
    const agents = this.ctx.agents
    let parent = agents.get(sessionId as never)?.session.header.parentSession
    for (let depth = 0; parent !== undefined && depth < 8; depth++) {
      const ticket = ticketOfSession(parent)
      if (ticket !== undefined) return { scope: 'subagent', ticket }
      parent = agents.get(parent)?.session.header.parentSession
    }
    return { scope: 'subagent' }
  }
  /** 工单的生效预算：项目 `execution.budget` 优先，否则全局 `executor.budget`；未配置返回 undefined。 */
  budgetOf(ticketId: string): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
    return effectiveBudget(this.host.store, ticketId)
  }
  /** 一个工单的预算用量比例（0–∞）：对每个配置的维度求比值取最大；无预算时为 0。 */
  private ratioOf(ticketId: string): { ratio: number; sum: NonNullable<ReturnType<Store['usage']['sumTicket']>> } {
    const sum = this.host.store.usage.sumTicket(ticketId) ?? { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    const budget = this.budgetOf(ticketId)
    if (!budget) return { ratio: 0, sum }
    const billed = sum.input + sum.cacheRead + sum.cacheWrite
    const ratios = [budget.totalTokens ? (billed + sum.output) / budget.totalTokens : 0,
      budget.inputTokens ? billed / budget.inputTokens : 0, budget.outputTokens ? sum.output / budget.outputTokens : 0]
    return { ratio: Math.max(...ratios), sum }
  }
  /** 落库后的预算判定：软档提醒与子代理封锁、硬档结束工单。 */
  private enforce(ticketId: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || ticket.ended) return
    const { ratio, sum } = this.ratioOf(ticketId)
    if (ratio < SOFT) return
    if (ratio >= 1) {
      try {
        this.host.engine.exhaustTicket(ticketId, `Token budget exhausted: ${describe(sum)}`)
      } catch { /* 工单已在别处结束。 */ }
      // 连续性补洞：被截断回合的工作单元收到一次解释（固定 requestId 幂等、不唤醒）——
      // 人在该会话继续追问时，模型知道回合为何被取消、工单为何 ended，而不是只见工具 guard 的拒绝文案。
      // 注入发生在结束事务提交之后，不会被停止路径的 keepInbox:false 清除；主会话经 ticket.ended 通知获知。
      const detail = `used ${describe(sum)}; the token budget is exhausted, so this ticket was ended (stopped, budget_exceeded) and its turn cancelled.`
      this.host.sessions.prompt(workerSessionId(ticketId), `budget-hard:${ticketId}`, JSON.stringify({ budget_hard: true, ticket_id: ticketId, detail }),
        { inject: 'The token budget is exhausted; the ticket ended' }).catch(() => { /* 会话不存在时跳过。 */ })
      return
    }
    if (this.softNotified.has(ticketId)) return
    this.softNotified.add(ticketId)
    const detail = `used ${describe(sum)}; at least ${Math.round((1 - ratio) * 100)}% of the budget remains. Wrap up now: finish the current step, verify what you have and report, instead of starting more work or subagents.`
    // 注入工作单元（固定 requestId 幂等，投递一次）并转发主会话。
    this.host.sessions.prompt(workerSessionId(ticketId), `budget-soft:${ticketId}`, JSON.stringify({ budget_soft: true, ticket_id: ticketId, detail }),
      { inject: 'The token budget is nearly used; wrap up' }).catch(() => { /* 会话不存在时跳过；主会话转发仍然送达。 */ })
    this.host.sessions.relay(`budget-soft:${ticketId}`, `Ticket ${ticketId} ${detail}`)
  }
  /** 预算软档是否已封锁该工单的子代理启动（`tools.guard` 读取）。 */
  subagentsBlocked(ticketId: string): boolean {
    return this.ratioOf(ticketId).ratio >= SOFT
  }
}
/** 工单的生效预算：项目 `execution.budget` 优先，否则全局 `executor.budget`；未配置返回 undefined。`UsageMeter` 与 usage 资源共用这一回退链。 */
export function effectiveBudget(store: Pick<Store, 'tickets' | 'projects' | 'settings'>, ticketId: string):
  { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  const ticket = store.tickets.get(ticketId)
  const projectId = ticket?.execution?.project
  return (projectId ? store.projects.get(projectId)?.execution.budget : undefined) ?? store.settings().executor.budget
}

/** 用量合计的一句话形态。 */
function describe(sum: NonNullable<ReturnType<Store['usage']['sumTicket']>>): string {
  const parts = [`input ${sum.input + sum.cacheRead + sum.cacheWrite}`, `output ${sum.output}`, `requests ${sum.requests}`]
  return sum.reasoning ? `${parts.join(', ')}, reasoning ${sum.reasoning}` : parts.join(', ')
}
