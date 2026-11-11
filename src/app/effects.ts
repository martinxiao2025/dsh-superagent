/**
 * 表示某个副作用当前无法运行，例如处理已暂停或所有执行器槽位已满。
 * Effects 会在初始重试延迟后重新调度该行且不增加失败计数，DshExecutor 会在启动和投递处理器中抛出它。
 */
export class Later extends Error {}
/** 某类副作用报告错误前允许的连续失败次数，与来源轮询的失败阈值一致。 */
export const FAILURES_BEFORE_ERROR = 3
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { Store } from './store.ts'

export interface EffectPayloads {
  /** 构建评估的候选卡片并转发到主会话；键为评估 ID。 */
  assessment: { triggerId: string }
  /** 启动待处理的分配；键为分配 ID。 */
  launch: { ticketId: string; assignmentId: string }
  /** 将工单中等待的输入交给其运行中的分配；键为工单 ID。 */
  delivery: { ticketId: string }
  /** 将报告或候选引导注入主会话；键为请求 ID。 */
  relay: { text: string }
  /** 在不唤醒主会话的情况下向其注入通知；键用于标识通知内容，例如 `prompts`。 */
  notice: { value: Record<string, unknown>; summary: string }
  /** 通过渠道的来源发送消息；键为消息 ID，其回执由发件箱保存。 */
  reply: Record<string, never>
  /** 把任务结果写回外部清单；键由队列条目、状态与尝试次数决定，重复投递幂等。 */
  writeback: { project: string; task: string; taskTitle: string; status: string }
}
export type EffectKind = keyof EffectPayloads
interface Handler<K extends EffectKind> {
  run: (payload: EffectPayloads[K], key: string) => Promise<void>
  /** 当前可同时运行的数量；为 0 时暂缓该类副作用，例如处理暂停期间。 */
  limit: () => number
  /** 重试退避的初始延迟和最大延迟，单位为毫秒。 */
  retry: readonly [number, number]
  /** 副作用按队列顺序逐个运行，失败的一项会阻塞同类后续行。 */
  ordered: boolean
  /** 为 true 时，反复失败不会把该类副作用的健康条目标记为 `error`（用于失败已在工单上暴露的情况）。 */
  quiet: boolean
}
type Options<K extends EffectKind> = Partial<Pick<Handler<K>, 'limit' | 'retry' | 'ordered' | 'quiet'>>
/** `seq` 保留该行的队列位置；`generation` 在载荷更新时递增，使运行中的尝试不会删除更新的载荷。 */
interface Row { key: string; value: string; seq: number; generation: number; attempts: number; due: number }
type Task = { kind: EffectKind; key: string; done: Promise<void> }

/**
 * 基于 SQLite 的持久化队列，在命令事务内持久化副作用，并在提交后分发。
 * 为 MasterAssessor、DshExecutor、Sessions 和 Outbox 协调各类处理器、并发限制、指数退避和健康上报。
 */
export class Effects {
  private readonly handlers = new Map<EffectKind, Handler<never>>()
  private readonly health = new Map<EffectKind, HealthEntry>()
  private readonly tasks = new Set<Task>()
  /** 上次分发失败的类别；下一次成功的分发会刷新其健康状态。 */
  private readonly broken = new Set<EffectKind>()
  private seq: number
  private scheduled = false
  /** 副作用仅在 `start` 与 `drain` 之间运行；在 `start` 之前入队的行会等待，例如初始化尚未完成时。 */
  private started = false
  private stopped = false
  constructor(private readonly store: Store, private readonly board: Pick<HealthBoard, 'claim'>, private readonly now = () => Date.now()) {
    this.seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  }
  /** 在调用方的事务中 upsert 一个副作用，与同类同键的等待行合并，同时保留其队列位置。 */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
      .run(kind, key, JSON.stringify(payload), ++this.seq, this.now(), new Date(this.now()).toISOString())
    this.kick()
  }
  handle<K extends EffectKind>(kind: K, run: Handler<K>['run'], options: Options<K> = {}): void {
    if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`)
    this.health.set(kind, this.board.claim(kind))
    const { limit = () => 1, retry = [2000, 60_000], ordered = false, quiet = false } = options
    this.handlers.set(kind, { run, limit: ordered ? () => Math.min(1, limit()) : limit, retry, ordered, quiet } as unknown as Handler<never>)
    this.report(kind)
    this.kick()
  }
  pending(kind: EffectKind, key?: string): boolean {
    return key === undefined ? !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? LIMIT 1').get(kind) : !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? AND key = ?').get(kind, key)
  }
  /** 按类别和键删除排队的行；如果它已在运行，则该次尝试会正常完成。 */
  cancel(kind: EffectKind, key: string): void {
    this.store.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key)
    this.store.afterCommit(() => { this.report(kind) })
  }
  start(): void { this.started = true; this.kick() }
  kick(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.dispatch() })
  }
  /** 当 `kind`（或任意类别）没有副作用在运行，且没有可启动的副作用（未到期或 `limit()` 无余量）时完成。 */
  async idle(kind?: EffectKind): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.tasks].filter(task => kind === undefined || task.kind === kind).map(task => task.done)
      if (!running.length) return
      await Promise.allSettled(running)
    }
  }
  /** 停止启动新的副作用并等待运行中的完成；等待中的行保留在 SQLite 中供下次启动使用。 */
  async drain(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.tasks].map(task => task.done))
  }
  private dispatch(): void {
    if (!this.started || this.stopped) return
    for (const [kind, handler] of this.handlers) {
      try {
        const running = new Set([...this.tasks].filter(task => task.kind === kind).map(task => task.key))
        // 有序类别会阻塞在其最旧的行之后，即使该行尚未到期；仅在存在就绪行后才查询 limit()。
        const rows = (handler.ordered
          ? this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1').all(kind)
          : this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?')
            .all(kind, this.now(), 16 + running.size)) as unknown as Row[]
        const ready = handler.ordered && running.size ? [] : rows.filter(row => row.due <= this.now() && !running.has(row.key))
        let room = ready.length ? handler.limit() - running.size : 0
        for (const row of ready) {
          if (room-- <= 0) break
          this.run(kind, handler, row)
        }
        if (this.broken.delete(kind)) this.report(kind)
      } catch (error) { this.failed(kind, error) }
    }
  }
  private run(kind: EffectKind, handler: Handler<never>, row: Row): void {
    const task: Task = { kind, key: row.key, done: Promise.resolve() }
    task.done = this.attempt(kind, handler, row)
      .catch((error: unknown) => { this.failed(kind, error) })
      .finally(() => { this.tasks.delete(task); this.kick() })
    this.tasks.add(task)
  }
  private async attempt(kind: EffectKind, handler: Handler<never>, row: Row): Promise<void> {
    let failure: { error: unknown } | undefined
    try { await handler.run(JSON.parse(row.value) as never, row.key) } catch (error) { failure = { error } }
    // 匹配 seq 和 generation，避免覆盖运行期间被替换或重新入队的行。
    const own = 'kind = ? AND key = ? AND seq = ? AND generation = ?', ownRow = [kind, row.key, row.seq, row.generation] as const
    if (!failure) this.store.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownRow)
    // 关闭时不改动运行中的行，使其在下次启动时重试。
    else if (this.stopped) return
    else if (failure.error instanceof Later) {
      this.store.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownRow)
    } else {
      const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16))
      this.store.db.prepare(`UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE ${own}`)
        .run(String(failure.error).slice(0, 1000), this.now() + delay, ...ownRow)
    }
    if (!this.stopped) this.report(kind)
  }
  private failed(kind: EffectKind, error: unknown): void {
    this.broken.add(kind)
    this.health.get(kind)?.set({ state: 'error', detail: `The effect queue failed: ${String(error)}`, at: new Date(this.now()).toISOString() })
  }
  private report(kind: EffectKind): void {
    const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind)
    const waiting = Number(row?.waiting ?? 0)
    const failing = Number(row?.attempts ?? 0) >= FAILURES_BEFORE_ERROR && !this.handlers.get(kind)?.quiet
    const detail = waiting ? `${waiting} waiting since ${String(row?.since)}` : 'Nothing waiting'
    this.health.get(kind)?.set(failing
      ? { state: 'error', detail: `${detail}; the last failure: ${String(row?.error)}`, at: new Date(this.now()).toISOString() }
      : { state: 'ready', detail, at: new Date(this.now()).toISOString() })
  }
}
