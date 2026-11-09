/** 已订阅线程的共享轮询辅助函数、重叠安全的游标和适配定时器的延迟。 */
import { liveTicket, type Thread } from '../core/index.ts'
import { health, type Health, type SourceContext } from './host.ts'

/** 已订阅线程在没有存活工单时，最后一次触发器或工单结束后仍继续轮询的时长。 */
export const POLL_HORIZON_MS = 14 * 24 * 3600_000
/** 已订阅线程有存活工单，或在 `POLL_HORIZON_MS` 内有近期活动/完成时为 true。 */
export function polled(ctx: SourceContext, thread: Thread, now = Date.now()): boolean {
  const tickets = thread.subscriptions.map(id => ctx.tickets.get(id))
  if (tickets.some(ticket => !!ticket && liveTicket(ticket))) return true
  const times = [thread.lastAt ?? thread.createdAt, ...tickets.map(ticket => ticket?.ended?.at ?? '')]
    .map(Date.parse).filter(Number.isFinite)
  return now - Math.max(...times) < POLL_HORIZON_MS
}
/** 把轮询起始时间戳回退 5 秒，避免漏掉迟到的远端事件；确定性触发器 ID 会对重叠去重。 */
export const cursorAt = (started: string): string => new Date(Date.parse(started) - 5000).toISOString()
/** 在时间窗内独立轮询 `source` 的每个已订阅线程；把失败记录为线程上的 `pollError`（除非 `stopped()`），成功时清除 `pollError`。 */
export async function pollThreads(ctx: SourceContext, source: string, stopped: () => boolean, poll: (thread: Thread) => Promise<void>,
  skip: (thread: Thread) => boolean = () => false): Promise<void> {
  for (const thread of ctx.threads.subscribed(source)) {
    if (stopped()) return
    if (skip(thread) || !polled(ctx, thread)) continue
    try {
      await poll(thread)
      ctx.threads.patch(thread.key, { pollError: undefined })
    } catch (error) {
      if (stopped()) return
      ctx.threads.patch(thread.key, { pollError: String(error) })
    }
  }
}
/** 连续失败达到阈值时返回 error 健康，否则返回 undefined，让单次网络中断在下一次轮询时安静重试。 */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
/** 等待 `ms` 或直到 `signal` 中止，使用全局 `setTimeout` 以便测试的假定时器驱动轮询循环。 */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const stop = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}
