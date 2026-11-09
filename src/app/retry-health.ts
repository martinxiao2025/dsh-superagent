/** 从会话事件流中投影出活跃的模型预算重试等待，而不修改重试策略或日志。 */
export interface RetryHealthEvent { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }
export interface BudgetRetryStatus { sessionId: string; provider: string; attempts: number; since: string; lastAt: string }
type Chain = { id: string; provider: string; status: BudgetRetryStatus }
type State = { seq: number; turn: number; step: number; ended: boolean; settled: boolean; active?: Chain }
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
 * 通过观察会话生命周期和重试事件，跟踪当前哪些受管会话因模型预算重试而阻塞。
 * `Sessions` 将会话事件送入其中，并把聚合后的重试状态镜像到 `models` 健康条目，而 `resources` 和视图会把每个会话的重试状态附加到工单卡片上。
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
    if (!ordinal(event.seq) || !Number.isFinite(event.time) || event.time < 0 || event.time > 8.64e15) return
    let state = this.sessions.get(sessionId)
    if (!state) { state = { seq: -1, turn: -1, step: -1, ended: false, settled: false }; this.sessions.set(sessionId, state) }
    if (event.seq <= state.seq) return
    state.seq = event.seq
    const data = record(event.data)
    if (!data) return
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      if (!ordinal(data.turn) || data.turn < state.turn) return
      if (data.turn > state.turn) Object.assign(state, { turn: data.turn, step: -1, ended: false, settled: false, active: undefined })
      if (event.type === 'turn/end') { state.active = undefined; state.ended = true }
      return
    }
    if (event.type === 'llm/retry-started') return // 重试尝试开始并不意味着预算失败已恢复。
    if (!['step/start', 'llm/retry', 'assistant/message'].includes(event.type)) return
    if (!ordinal(data.turn) || !ordinal(data.step)) return
    if (data.turn < state.turn || data.turn === state.turn && (state.ended || data.step < state.step)) return
    if (event.type === 'assistant/message') {
      const source = record(record(data.message)?.source)
      if (state.active && data.turn === state.turn && data.step === state.step && data.interrupted !== true && source?.kind === 'model' && source.provider === state.active.provider) {
        state.active = undefined; state.settled = true
      }
      return
    }
    if (data.turn > state.turn || data.step > state.step) Object.assign(state, { turn: data.turn, step: data.step, ended: false, settled: false, active: undefined })
    if (event.type === 'step/start' || state.settled) return
    if (typeof data.retryId !== 'string' || !data.retryId || typeof data.provider !== 'string' || typeof data.retry !== 'number' || !Number.isInteger(data.retry) || data.retry < 1) return
    if (!budgetFailure(data.failure)) { state.active = undefined; return }
    const attempts = Math.min(data.retry, Number.MAX_SAFE_INTEGER)
    const previous = state.active?.id === data.retryId && state.active.provider === data.provider ? state.active.status : undefined
    if (previous && attempts <= previous.attempts) return
    const at = new Date(event.time).toISOString()
    state.active = { id: data.retryId, provider: data.provider, status: {
      sessionId, provider: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(data.provider) ? data.provider : 'unknown', attempts,
      since: previous?.since ?? at, lastAt: at,
    } }
  }
}
