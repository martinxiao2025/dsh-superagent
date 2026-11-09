/** 协调周期性及按需的编排轮次，驱动到期的副作用和引擎评估。 */
import type { Engine, ReceiveResult, Trigger } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Effects } from './effects.ts'

export interface PassesHost {
  readonly engine: Pick<Engine, 'receive' | 'evaluateDue'>
  readonly effects: Pick<Effects, 'kick' | 'idle'>
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  configured(): boolean
  closing(): boolean
}

const now = (): string => new Date().toISOString()

/**
 * 调度并串行化编排轮次，触发到期的 `Effects` 并推进 `Engine` 评估。
 * `Runtime` 管理其生命周期，而来源、工具、`Settings` 和 HTTP 路由在新工作到达或状态变化时触发即时轮次。
 * 当轮次失败时更新运行时 `HealthEntry`，并在后续轮次成功后清除错误。
 */
export class Passes {
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private pumping?: Promise<void>
  private pumpAgain?: Promise<void>
  constructor(private readonly host: PassesHost) {}
  start(): void { if (!this.stopped) this.timer = setInterval(() => { this.request() }, 2000) }
  stop(): Promise<unknown> {
    this.stopped = true
    clearInterval(this.timer)
    return Promise.allSettled([this.pumping, this.pumpAgain])
  }
  receive(trigger: Trigger): ReceiveResult {
    if (this.host.closing()) throw new Error('Orchestrator is stopping')
    const result = this.host.engine.receive(trigger)
    if (result === 'stored') this.request()
    return result
  }
  request(): void {
    const { health } = this.host
    this.pump().then(() => {
      if (health.get()?.state !== 'error' || this.host.lifetime.aborted) return
      health.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    }, (error: unknown) => { health.set({ state: 'error', detail: `A pass failed: ${String(error)}`, at: now() }) })
  }
  /** 等待直到没有可立即启动的轮次或副作用在运行。 */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.pumpAgain])
      await this.host.effects.idle()
      if (!this.pumping && !this.pumpAgain) return
    }
  }
  /** 运行一个轮次，将并发调用者合并为单个后续轮次。 */
  async pump(): Promise<void> {
    // 等待初始化期间不进行评估、分发或发送；排队的工作会等到完成初始化的重启之后。
    if (!this.host.configured() || this.host.closing()) return
    if (!this.pumping) return this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined })
    const next = () => { this.pumpAgain = undefined; return this.pump() }
    return this.pumpAgain ??= this.pumping.then(next, next)
  }
  private async pumpOnce(): Promise<void> {
    this.host.effects.kick()
    if (this.host.closing()) return
    // 处理暂停期间，引擎仅在活跃评估上记录暂停，以免它们过期。
    this.host.engine.evaluateDue()
  }
}
