/** 用于测试和临时引擎实例的内存仓储实现。 */
import { latestAssignment, type Decision, type Thread, type Ticket, type Trigger, type TriggerDisposition } from './model.ts'
import type { Repositories } from './ports.ts'

const clone = <T>(value: T): T => structuredClone(value)
/**
 * Repositories 端口的内存实现，底层存储的是克隆后的 Map 条目，因此调用方的修改不会影响已存储的状态。
 * 提供基于快照的原子回滚，并与 SQLite 存储为引擎测试保持一致的排序语义。
 */
export class MemoryRepositories implements Repositories {
  private readonly triggerRows = new Map<string, Trigger>()
  private readonly dispositions = new Map<string, TriggerDisposition>()
  private readonly threadRows = new Map<string, Thread>()
  private readonly ticketRows = new Map<string, Ticket>()
  private readonly decisionRows = new Map<string, Decision>()
  private depth = 0
  /** 在最外层提交后运行的回调，按保存点层级索引；回滚某一层级会丢弃其回调。 */
  private readonly committed: (() => void)[][] = []
  atomic<T>(work: () => T): T {
    const maps: Map<string, unknown>[] = [this.triggerRows, this.dispositions, this.threadRows, this.ticketRows, this.decisionRows]
    const snapshot = maps.map(map => new Map(map))
    const level = this.depth++
    this.committed[level] = []
    let value: T
    try { value = work() }
    catch (error) {
      maps.forEach((map, index) => { map.clear(); for (const [id, value] of snapshot[index]!) map.set(id, value) })
      throw error
    }
    finally { this.depth-- }
    // 与 SQLite 存储一致：嵌套事务把回调上交其父级，仅最外层提交后执行。
    const actions = this.committed.splice(level)[0]!
    if (level) this.committed[level - 1]!.push(...actions)
    else for (const action of actions) action()
    return value
  }
  /** 回调错误会向上抛出（内存实现没有健康上报通道），但状态已提交，不随之回滚。 */
  afterCommit(action: () => void): void {
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    else action()
  }
  readonly triggers = {
    get: (id: string) => clone(this.triggerRows.get(id)),
    save: (trigger: Trigger) => { this.triggerRows.set(trigger.id, clone(trigger)) },
    disposition: (id: string) => clone(this.dispositions.get(id)),
    saveDisposition: (id: string, value: TriggerDisposition) => { this.dispositions.set(id, clone(value)) },
  }
  readonly threads = {
    get: (key: string) => clone(this.threadRows.get(key)),
    save: (thread: Thread) => { this.threadRows.set(thread.key, clone(thread)) },
    list: () => [...this.threadRows.values()].map(clone),
    active: () => this.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
  }
  readonly tickets = {
    get: (id: string) => clone(this.ticketRows.get(id)),
    save: (ticket: Ticket) => { this.ticketRows.set(ticket.id, clone(ticket)) },
    /** 最新的在前，与 SQLite 存储的顺序一致。 */
    list: () => [...this.ticketRows.values()].reverse().map(clone),
    open: () => this.tickets.list().filter(ticket => !ticket.ended),
    active: () => this.tickets.list().filter(ticket => ticket.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')),
  }
  readonly decisions = {
    get: (id: string) => clone(this.decisionRows.get(id)),
    save: (decision: Decision) => { this.decisionRows.set(decision.id, clone(decision)) },
    byThread: (key: string) => [...this.decisionRows.values()].filter(decision => decision.threadKey === key).map(clone),
  }
}
