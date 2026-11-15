/** 从会话事件流中投影出活跃的模型预算重试等待，而不修改重试策略或日志。 */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

export interface RetryHealthEvent { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }
export interface BudgetRetryStatus { sessionId: string; provider: string; attempts: number; since: string; lastAt: string }
type Chain = { id: string; provider: string; status: BudgetRetryStatus }
/** 单个会话的折叠状态；纯 JSON，可被投影缓存检查点保存。 */
interface State { seq: number; turn: number; step: number; ended: boolean; settled: boolean; active?: Chain }
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const ordinal = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** 从结构化失败元数据中识别模型预算耗尽，而不检查助手消息内容。 */
function budgetFailure(value: unknown): boolean {
  const failure = record(value)
  if (!failure) return false
  if ([401, 403, 429].includes(Number(failure.status)) || typeof failure.code === 'string' && /AUTH|RATE_LIMIT|CONTEXT|TOKEN_LIMIT/i.test(failure.code)) return false
  if (failure.type === 'budget_exceeded' || failure.code === 'budget_exceeded') return true
  if (typeof failure.message !== 'string') return false
  const message = failure.message.slice(0, 8192)
  try {
    const body = record(JSON.parse(message.slice(message.indexOf('{'))))
    const error = record(body?.error) ?? body
    if (error?.type === 'budget_exceeded' || error?.code === 'budget_exceeded') return true
  } catch { /* 部分提供方仅暴露已知的纯文本预算错误。 */ }
  return /\bBudget has been exceeded(?:!|[.:]|$)/i.test(message)
}

/**
 * 单会话的纯折叠：一个已提交事件 + 当前状态 → 下一状态；与该单元无关的事件返回同一引用。
 * `sessionId` 只是状态内部的标签（`BudgetRetryStatus.sessionId`），由 `init` 从会话头固化。
 */
function foldRetryEvent(state: State, sessionId: string, event: RetryHealthEvent): State {
  if (!ordinal(event.seq) || !Number.isFinite(event.time) || event.time < 0 || event.time > 8.64e15) return state
  if (event.seq <= state.seq) return state
  const data = record(event.data)
  if (!data) return { ...state, seq: event.seq }
  const next: State = { ...state, seq: event.seq }
  if (event.type === 'turn/start' || event.type === 'turn/end') {
    if (!ordinal(data.turn) || data.turn < next.turn) return next
    if (data.turn > next.turn) Object.assign(next, { turn: data.turn, step: -1, ended: false, settled: false, active: undefined })
    if (event.type === 'turn/end') { next.active = undefined; next.ended = true }
    return next
  }
  if (event.type === 'llm/retry-started') return next // 重试尝试开始并不意味着预算失败已恢复。
  if (!['step/start', 'llm/retry', 'assistant/message'].includes(event.type)) return next
  if (!ordinal(data.turn) || !ordinal(data.step)) return next
  if (data.turn < next.turn || data.turn === next.turn && (next.ended || data.step < next.step)) return next
  if (event.type === 'assistant/message') {
    const source = record(record(data.message)?.source)
    if (next.active && data.turn === next.turn && data.step === next.step && data.interrupted !== true && source?.kind === 'model' && source.provider === next.active.provider) {
      next.active = undefined; next.settled = true
    }
    return next
  }
  if (data.turn > next.turn || data.step > next.step) Object.assign(next, { turn: data.turn, step: data.step, ended: false, settled: false, active: undefined })
  if (event.type === 'step/start' || next.settled) return next
  if (typeof data.retryId !== 'string' || !data.retryId || typeof data.provider !== 'string' || typeof data.retry !== 'number' || !Number.isInteger(data.retry) || data.retry < 1) return next
  if (!budgetFailure(data.failure)) { next.active = undefined; return next }
  const attempts = Math.min(data.retry, Number.MAX_SAFE_INTEGER)
  const previous = next.active?.id === data.retryId && next.active.provider === data.provider ? next.active.status : undefined
  if (previous && attempts <= previous.attempts) return next
  const at = new Date(event.time).toISOString()
  next.active = { id: data.retryId, provider: data.provider, status: {
    sessionId, provider: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(data.provider) ? data.provider : 'unknown', attempts,
    since: previous?.since ?? at, lastAt: at,
  } }
  return next
}

/** 投影状态的 zod 校验：持久化检查点回种前验证形状，未知字段放行。 */
const RetryProjectionStateSchema = z.object({
  seq: z.number(), turn: z.number(), step: z.number(), ended: z.boolean(), settled: z.boolean(),
  active: z.object({ id: z.string(), provider: z.string(),
    status: z.object({ sessionId: z.string(), provider: z.string(), attempts: z.number(), since: z.string(), lastAt: z.string() }) }).optional(),
}).passthrough()

/** 投影键：宿主专用（无 wire 块），客户端不读取。 */
export const MODEL_RETRY_PROJECTION_KEY = 'dshSuperagentModelRetry'

/**
 * 模型预算重试等待的会话投影单元：框架驱动（注册表随已提交事件推进），本单元只计算。
 * 无关事件返回同一引用（零下游开销）；状态为纯 JSON，可被投影缓存检查点。
 */
export const modelRetryProjectionDefinition: ProjectionDefinition<typeof MODEL_RETRY_PROJECTION_KEY, State> = {
  key: MODEL_RETRY_PROJECTION_KEY,
  stateSchema: RetryProjectionStateSchema as unknown as z.ZodType<State>,
  stateVersion: 1,
  init: (_header, _inheritedEventCount) => ({ seq: -1, turn: -1, step: -1, ended: false, settled: false }),
  apply: (state, event) => foldRetryEvent(state, state.active?.status.sessionId ?? '', event as SessionEvent as RetryHealthEvent),
}

/**
 * 通过观察会话生命周期和重试事件，跟踪当前哪些受管会话因模型预算重试而阻塞。
 * 注册了投影单元的部署由 `ctx.sessionProjections` 驱动（`Sessions` 读取 `handle.stateOf`）；
 * 该类保留为同一折叠的内存投影，供未注册投影的部署（可选服务缺失）与单测使用。
 * 聚合后的重试状态镜像到 `models` 健康条目，而 `resources` 和视图会把每个会话的重试状态附加到工单卡片上。
 */
export class RetryHealth {
  private readonly sessions = new Map<string, State>()

  /** 重放有序的原生事件快照；调用方随后必须清理空闲或已处置的智能体。 */
  restore(sessionId: string, events: readonly RetryHealthEvent[]): void {
    this.sessions.delete(sessionId)
    for (const event of events) this.observe(sessionId, event)
  }

  /** 清除活跃重试状态，同时保留序号水位以应对乱序事件。 */
  clear(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state) { state.active = undefined; state.settled = true }
  }

  get(sessionId: string): BudgetRetryStatus | undefined {
    const status = this.sessions.get(sessionId)?.active?.status
    return status ? { ...status } : undefined
  }

  list(): BudgetRetryStatus[] {
    return [...this.sessions.values()].flatMap(state => state.active ? [{ ...state.active.status }] : [])
  }

  observe(sessionId: string, event: RetryHealthEvent): void {
    const state = this.sessions.get(sessionId) ?? { seq: -1, turn: -1, step: -1, ended: false, settled: false }
    const next = foldRetryEvent(state, sessionId, event)
    if (next === state) return
    this.sessions.set(sessionId, next)
  }
}
