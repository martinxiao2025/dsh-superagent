/** 核心所依赖的端口。来源、策略、评估者、执行器和渠道均与具体项目相关。 */
import type { Assignment, ChannelRef, Decision, DecisionKind, Mandate, MandateBasis, Strength, Thread, Ticket, TicketEndBy, TicketOutcome, Trigger }
  from './model.ts'
import type { Reason } from './reasons.ts'

/** 门禁准入结果：要么不可准入并附原因代码，要么可准入并附强度和 MandateBasis。 */
export type GateResult = { admissible: false; reason: string } | { admissible: true; strength: Strength; basis: MandateBasis }

/** 某个来源是否接收一个触发器；当它也接收未面向智能体的消息时为 `observed`，`row` 是策略准入表指定的接收范围，例如某个聊天。 */
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }
/** 领域视角下的来源配置：按触发器或按已记录的授权依据确定监听范围。 */
export interface SourceScope {
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult
}

/** 带版本的规则；`gate` 决定谁可以发起工作。来源范围不属于策略。 */
export interface Policy {
  version: string
  paused: boolean
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** 在该策略下重新检查授权在门禁层的依据，例如在已结束工单恢复之前。 */
  revalidate(mandate: Mandate): boolean
  /** 推断候选是否可以按其评估匹配到的规则被接受：评估接受，且每条规则都已启用。 */
  admitsInferred(rules: readonly string[]): boolean
  /** 评估在被记录为 unavailable 之前，评估者可以花费多长时间。 */
  evalTimeoutMs: number
}

/** 评估者收到的内容：有限的事实，绝不包含权限。 */
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** 该线程上的所有工单（含已结束的），用于判断是否重复。 */
  tickets: Ticket[]
}

export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }
  /** 一次接受：`rules` 是评估匹配到的规则，`name` 是工单请求的短名称，`note` 是给其工作单元的路由说明。 */
  | { kind: 'accept'; title: string; scope: string; reason: string | Reason; acknowledgement?: string; rules?: string[]; audit?: Record<string, unknown>;
    name?: string; note?: string }
  | { kind: 'stop'; ticketId: string; reason: string | Reason; audit?: Record<string, unknown> }

/** 语义判断。`request` 把评估排队，按 `evalId` 幂等；结果通过 `Engine.decide` 返回。 */
export interface Assessor {
  request(candidate: Candidate): void
  /** 每当一次评估结束（无论是否已决定）时调用，以便评估者丢弃它为这次评估保留的内容。 */
  release?(evalId: string): void
}

/**
 * 执行任务分配；并发与工作区管理由它自行负责。Engine 在其命令内部调用它，
 * 因此每个方法只负责排队工作，工作完成后通过 Engine 的回调汇报。
 */
export interface Executor {
  /** 把待处理的任务分配排队以启动；通过 `Engine.assignmentStarted` 或 `failed` 报告汇报结果。 */
  start(ticket: Ticket, assignment: Assignment): void
  /**
   * 把工单等待中的输入排队投递给其运行中的任务分配；通过 `Engine.inputsDelivered` 或 `Engine.deliveryFailed` 汇报，
   * 并在其工作单元的会话把输入纳入步骤后通过 `Engine.inputsRead` 汇报。
   */
  deliver(ticket: Ticket, assignment: Assignment): void
  /** 结束任务分配的工作，例如取消其会话的回合；在工单或任务分配于领域中结束之后调用。 */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
}

/** 发往某个渠道的消息；存在对应工单时，`ticketId` 指明它。 */
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; kind: 'acknowledgement' | 'reply' | 'notice'; ticketId?: string }
/** 已排队的消息处于等待（`pending`）、已发出（`sent`），或因所在会话永远无法收到而被丢弃（`dropped`）。 */
export type ReplyStatus = 'pending' | 'sent' | 'dropped'
/** 为渠道排队的消息；Engine 在其命令内部排队，发送方稍后投递。 */
export interface Outbox {
  /** 幂等地排队一条消息；此前已排队的 id 保留其第一条消息。 */
  send(message: OutboundMessage): void
  /** 某条消息是否已排队，以及它的结果。 */
  status(id: string): ReplyStatus | undefined
  /** 撤回一条尚未发出的消息。 */
  withdraw(id: string): void
}

/** 变更之后引擎按事件类型汇报的内容。 */
export interface DomainEvents {
  'trigger.received': { triggerId: string; threads: string[] }
  'eval.started': { evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  'decision.recorded': { decisionId: string; kind: DecisionKind; threadKey: string }
  'ticket.created': { ticketId: string; decisionId: string; strength: Strength }
  'ticket.resumed': { ticketId: string; triggerId: string }
  'ticket.ended': { ticketId: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  'assignment.started': { ticketId: string; assignmentId: string }
  'assignment.ended': { ticketId: string; assignmentId: string; reason: string }
  'thread.subscribed': { threadKey: string; ticketId: string }
  /** 人丢弃了每个工单的订阅，或某工单的执行器丢弃了自己的订阅，理由为 `reason`。 */
  'thread.unsubscribed': { threadKey: string; ticketId: string; by: 'person' | 'executor'; reason?: string }
  'trigger.requeued': { triggerId: string }
  /** 人的后续消息已到达某些工单，旧版本同时把它排入评估，现已离开队列。 */
  'trigger.followup': { triggerId: string }
  'policy.changed': { from: string; to: string }
}
export type DomainEvent = { [K in keyof DomainEvents]: { type: K; at: string; data: DomainEvents[K] } }[keyof DomainEvents]

/** 持久化状态。所有方法都是同步的，以便 `atomic` 能包裹一个工作单元。 */
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    disposition(id: string): import('./model.ts').TriggerDisposition | undefined
    saveDisposition(id: string, value: import('./model.ts').TriggerDisposition): void
  }
  threads: {
    get(key: string): Thread | undefined
    save(thread: Thread): void
    list(): Thread[]
    /** 有触发器排队等待评估或有评估进行中的线程。 */
    active(): Thread[]
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    list(): Ticket[]
    open(): Ticket[]
    /** 有未投递输入或存在待处理、运行中（总是最新的那个）任务分配的工单。 */
    active(): Ticket[]
  }
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(key: string): Decision[]
  }
}
