/** 引擎各领域部分共享的基类与配置。 */
import { UserError } from './errors.ts'
import { followupOwners, reached, threadKey } from './model.ts'
import type { Thread, ThreadRef, Ticket, Trigger } from './model.ts'
import type { Assessor, AssessmentOutcome, DomainEvent, DomainEvents, Executor, Outbox, Policy, Repositories, SourceScope } from './ports.ts'

export interface EngineOptions {
  repo: Repositories
  policy: () => Policy
  /** 决定某个来源是否监听一个触发器；不监听的触发器会以 `filtered` 处置状态存储。 */
  scope: SourceScope
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  prepareTicket?: (ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>) => Ticket
  now?: () => string
  emit?: (event: DomainEvent) => void
}

/**
 * Intake、Evals、Tickets、Follows、Inputs、Assignments 和 Replies 的基类，提供对仓储、策略、时钟和事件发送的共享访问。
 * 每个子类只变更自己的领域聚合，把跨聚合的协作交给构造注入的同级部分或 `Requeues`，且都在 Engine 开启的事务内进行。
 */
export abstract class EnginePart {
  protected readonly repo: Repositories
  constructor(protected readonly options: EngineOptions) { this.repo = options.repo }
  protected now(): string { return this.options.now?.() ?? new Date().toISOString() }
  protected policy(): Policy { return this.options.policy() }
  /** 把端口副作用推迟到最外层事务提交之后执行；回滚时丢弃（见 `Repositories.afterCommit`）。 */
  protected defer(action: () => void): void { this.repo.afterCommit(action) }
  /** 由工作单元决定某人后续消息的那些工单：见 `followupOwners`。 */
  protected owners(trigger: Trigger): string[] { return followupOwners(trigger, this.repo) }
  /** 拒绝主会话对仍由某工单工作单元决定的后续消息进行路由。 */
  protected leftToWorkers(trigger: Trigger): void {
    const owners = this.owners(trigger)
    if (owners.length) throw new UserError('workerDecides', { tickets: owners.join(', ') })
  }
  protected emit<K extends keyof DomainEvents>(type: K, data: DomainEvents[K]): void {
    this.options.emit?.({ type, at: this.now(), data } as DomainEvent)
  }
  protected require(ticketId: string): Ticket { const ticket = this.repo.tickets.get(ticketId); if (!ticket) throw new UserError('unknownTicket'); return ticket }
  /** 返回已存储的线程，或一个未保存的空线程聚合。 */
  protected thread(ref: ThreadRef): Thread { return touchThread(this.repo, ref, undefined, this.now()) }
  protected ticketsOnThread(thread: Thread): Ticket[] {
    return thread.subscriptions.flatMap(id => { const ticket = this.repo.tickets.get(id); return ticket ? [ticket] : [] })
  }
  protected source(ticket: Ticket): Trigger | undefined { return this.repo.triggers.get(ticket.origin.triggerId) }
  protected reaches(ticket: Ticket, trigger: Trigger, context = true): boolean {
    return reached(ticket, trigger, k => this.repo.threads.get(k), context)
  }
}

/**
 * 返回已存储的线程，或以 `createdAt` 新建一个空线程聚合；给出 `at` 时把其最新触发器时间推进到 `at`（仅向前）。
 * 是否持久化由调用方决定。这是 get-or-create 线程与 `lastAt` 推进的单一实现。
 */
export function touchThread(repo: Pick<Repositories, 'threads'>, ref: ThreadRef, at: string | undefined, createdAt: string): Thread {
  const k = threadKey(ref)
  const thread = repo.threads.get(k) ?? { key: k, ref: { source: ref.source, id: ref.id }, createdAt, subscriptions: [], correlated: [], pending: [], meta: {} }
  if (at && (!thread.lastAt || at > thread.lastAt)) thread.lastAt = at
  return thread
}

/** 工单、评估、任务分配与摄入之间的评估队列协作面：交还、承接与排队不再由基类隐式提供，依赖图据此可见。 */
export interface Requeues {
  /**
   * 记录某个工单的工作单元交还了一条已到达该工单的触发器，并说明原因；当该工单曾决定它且没有其他工单仍决定它时，
   * 把它排队等待评估。该工单未曾决定的触发器（例如机器人的消息、人发送去评估的消息，或它仅为上下文而关注的线程上的消息）
   * 本来就是在没有它的情况下进入评估的。
   * @returns 是否已排队。
   */
  handBack(ticketId: string, trigger: Trigger, reason: string): boolean
  /** 记录某个工单的工作单元已把人的消息作为工单内的工作承接，即确认或回答它。 */
  takeUp(ticketId: string, triggerId: string): void
  /** 把触发器排队到其主线程等待下一次评估，除非它已在那里等待或有评估持有它。 */
  queueForEval(trigger: Trigger): boolean
}

/** `Requeues` 的实现：处置记录与主线程排队队列的维护者。 */
export class EvaluationQueue extends EnginePart implements Requeues {
  handBack(ticketId: string, trigger: Trigger, reason: string): boolean {
    const decided = this.owners(trigger).includes(ticketId)
    const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const handbacks = [...disposition.handbacks ?? [], { ticketId, reason, at: this.now() }]
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, handbacks })
    return decided && !this.owners(trigger).length && this.queueForEval(trigger)
  }
  takeUp(ticketId: string, triggerId: string): void {
    const disposition = this.repo.triggers.disposition(triggerId)
    if (disposition && !disposition.acked?.includes(ticketId)) {
      this.repo.triggers.saveDisposition(triggerId, { ...disposition, acked: [...disposition.acked ?? [], ticketId] })
    }
  }
  queueForEval(trigger: Trigger): boolean {
    const primary = this.thread(trigger.threads[0]!)
    if (primary.pending.includes(trigger.id) || primary.evaluating?.triggerIds.includes(trigger.id)) return false
    primary.pending.push(trigger.id)
    this.repo.threads.save(primary)
    return true
  }
}
