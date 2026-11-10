/** 领域引擎：核心的唯一入口，以及调用方获得的各角色接口。 */
import { UserError } from './errors.ts'
import { isoTime, liveTicket } from './model.ts'
import type { ChannelRef, Decision, PolicyEffect, ThreadRef, Ticket, Trigger } from './model.ts'
import type { Candidate, Repositories } from './ports.ts'
import type { EngineOptions } from './part.ts'
import { Assignments, type WorkerReport } from './assignments.ts'
import { Evals, type Outcome } from './evals.ts'
import { Intake, type ReceiveResult } from './intake.ts'
import { Replies, type Reply, type ReplyRequest } from './replies.ts'
import { Tickets } from './tickets.ts'

export type { EngineOptions } from './part.ts'
export type { WorkerReport } from './assignments.ts'
export type { Outcome } from './evals.ts'
export type { ReceiveResult } from './intake.ts'
export type { Reply, ReplyRequest } from './replies.ts'

/**
 * 变更触发器、线程、决策、工单和任务分配的唯一事务性入口。
 * 在同步仓储事务中协调 Intake、Evals、Tickets、Assignments 和 Replies，并通过端口排队副作用。
 * 调用方获得的是按角色限定的 `Pick` 接口，而非完整引擎。
 */
export class Engine {
  private readonly repo: Repositories
  private readonly replies: Replies
  private readonly tickets: Tickets
  private readonly assignments: Assignments
  private readonly evals: Evals
  private readonly intake: Intake
  constructor(private readonly options: EngineOptions) {
    this.repo = options.repo
    this.replies = new Replies(options)
    this.tickets = new Tickets(options, this.replies)
    this.assignments = new Assignments(options, this.tickets, this.replies)
    this.evals = new Evals(options, this.tickets)
    this.intake = new Intake(options, this.tickets)
  }

  // 来源

  /**
   * 某个来源请求接收一个触发器：只存储一次，再把它分发给订阅其线程的工单（对已结束的工单只投递人发的消息，
   * 除非处理已暂停，否则立即恢复它；被人停止的工单则不投递任何内容），
   * 并把它在其主线程上排队等待评估，除非该工单的工作单元会自行决定它（见 `followupOwners`）。
   * 在该线程的评估运行期间到达的触发器会一起等待下一次评估。
   */
  receive(trigger: Trigger): ReceiveResult { return this.repo.atomic(() => this.intake.receive(trigger)) }
  /**
   * 某个来源请求让一个未结束的工单关注其某个线程，例如其拉取请求的线程；`own` 表示该工单打开了该线程：
   * 工单订阅它，而 ready 报告只有在其 `followsDone` 成立时才结束工单（见 `Tickets.followsDone`）。
   * @throws 当工单未知或已结束时抛出 UserError。
   */
  bindThread(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    return this.repo.atomic(() => this.tickets.bind(ticketId, thread, own))
  }
  /**
   * 某个来源提供的事实：线程在发生时已关闭，例如其拉取请求已合并。关注它的未结束工单，
   * 在它完成所关注的线程后结束；除非关闭后恢复的工作尚未完成，
   * 或它的工作单元承接了人的消息且该工单在其最新报告之后仍要对此作决定。
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    // 把来源时间戳（例如 GitHub 的整秒时间）规范化为标准 ISO 形式。
    this.repo.atomic(() => { this.tickets.threadClosed(thread, outcome, isoTime(at)) })
  }

  // 时钟

  /**
   * 把逾期未处理的评估重新排队，最多 `REQUEUES` 次，之后记录为 `unavailable`（未投递的评估永不过期）；
   * 启动那些已排队触发器在等待的线程的评估，并恢复处理暂停期间人的消息到达的已结束工单。
   * 处理暂停期间不会有过期：每个进行中的评估会记下暂停开始的时间，恢复后其截止时间按暂停时长顺延。
   * 每次评估和每次工单更新各用一个事务。
   */
  evaluateDue(): void {
    const policy = this.options.policy()
    for (const thread of this.repo.threads.active()) if (thread.evaluating) this.repo.atomic(() => { this.evals.due(thread, policy) })
    if (policy.paused) return
    for (const ticket of this.repo.tickets.active()) {
      if (!liveTicket(ticket) && ticket.undelivered.length) this.repo.atomic(() => { this.tickets.wake(ticket.id) })
    }
    for (const thread of this.repo.threads.active()) {
      if (thread.pending.length && !thread.evaluating) this.repo.atomic(() => { this.evals.start(thread.key, policy) })
    }
  }

  // 主会话

  /** 持有某个触发器的评估所产生的候选，以评估者的视角呈现；没有评估持有时为 undefined。 */
  candidate(triggerId: string): Candidate | undefined { return this.evals.candidate(triggerId) }
  /**
   * 决定一个触发器：由持有它的评估决定；若没有评估持有，则单独对它做一次直接评估，例如主会话路由的人的明确请求。
   * 主动候选只有在 `auto` 模式下、且其评估匹配了已启用规则时才可被接受；若触发器已启动过工单，则返回该工单的决策。
   * 无效的停止会记录为 `ignore`；在旧版策略下判定的会记录为 `unavailable`。
   * @throws 当触发器未知或不可准入、`outcome.evalId` 指向已完成的评估、工单的工作单元仍决定该触发器且结果不是停止，
   * 或在 `auto` 模式之外接受推断出的候选、或没有已启用的匹配规则时抛出 UserError。
   */
  decide(triggerId: string, outcome: Outcome): Decision { return this.repo.atomic(() => this.evals.decide(triggerId, outcome)) }
  /**
   * 把触发器附加到消息所指向的工单：工单关注该触发器的线程，并连同路由说明把它作为输入接收，
   * 持有该触发器的评估随之结束，因为工单现在拥有它；同批次的其他触发器等待新的评估。
   * 对工作单元已收到的输入追加的说明会作为新输入发出；工单已放手的消息、仅为上下文读取的消息、
   * 或工单结束前已有的消息也是如此。已结束的工单会在其授权下恢复，除非处理已暂停，否则立即恢复。
   * @throws 对于被人停止（其授权已撤回）的工单，或策略不再持有其授权的工单，抛出 UserError。
   */
  attach(ticketId: string, triggerId: string, note?: string): Ticket {
    return this.repo.atomic(() => {
      // 该工单的工作单元交还的消息不属于它的工作：若在此附加，没有工作单元会决定它，且无法再次交还。
      const handedBack = this.repo.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === ticketId)
      if (handedBack) throw new UserError('handedBackHere')
      const trigger = this.tickets.attachable(ticketId, triggerId)
      this.evals.withdraw(trigger)
      this.tickets.attach(ticketId, trigger, note)
      this.evals.routed(triggerId, ticketId)
      this.tickets.wake(ticketId)
      return this.repo.tickets.get(ticketId)!
    })
  }
  /**
   * 向处于 `waiting` 状态的运行中工作单元询问其状态；其他状态的工作单元不受影响。
   * @returns 是否询问了该工作单元。
   * @throws 当工单未知时抛出 UserError。
   */
  requestStatus(ticketId: string): boolean { return this.repo.atomic(() => this.tickets.requestStatus(ticketId)) }
  /**
   * 为用途所指定的渠道排队一条消息：确认或回答发到人的消息所在处，attention 发到引发提问的消息所在处，
   * 否则（与结果一样）发到工单启动时所在的会话。已经排队的消息不会再次排队（见 `Replies.reply`）。
   * @throws 当工单或触发器未知，或该用途的规则拒绝它时抛出 UserError，例如工单尚未 ready、完成、合并或放弃时发送结果。
   */
  reply(request: ReplyRequest): Reply { return this.repo.atomic(() => this.replies.reply(request)) }

  // 人，通过面板或主会话

  /** 评估者已把评估的候选投递给其会话：评估的截止时间从此刻开始计算。 */
  candidateDelivered(evalId: string): void { this.repo.atomic(() => { this.evals.delivered(evalId, this.options.policy()) }) }
  /**
   * 把已存储的触发器排队等待新的评估，例如人的重放；当有评估持有它时返回 false。
   * @throws 当触发器未知时抛出 UserError。
   */
  reevaluate(triggerId: string): boolean { return this.repo.atomic(() => this.evals.reevaluate(triggerId)) }
  /**
   * 人忽略 `unavailable` 决策所显示的问题：概览不再列出它。
   * @throws 当决策未知或不是 `unavailable` 时抛出 UserError。
   */
  dismiss(decisionId: string): Decision { return this.repo.atomic(() => this.evals.dismiss(decisionId)) }
  /**
   * 丢弃每个工单对某个线程的订阅，直到新的决策再次订阅它。
   * @returns 是否丢弃了订阅。
   */
  unsubscribe(thread: string): boolean { return this.repo.atomic(() => this.tickets.dropSubscriptions(thread, 'person')) }
  /**
   * 人停止一个工单，其授权随之撤回：工单结束，不再接收任何内容。
   * @throws 当工单未知时抛出 UserError。
   */
  stopTicket(ticketId: string, reason?: string): Ticket { return this.repo.atomic(() => this.tickets.stop(ticketId, reason)) }
  /**
   * 人重试一个其工作单元报告为 failed 或 blocked（或输入投递失败）的工单：
   * 停滞的任务分配结束，并在同一授权下启动新的任务分配。
   * @throws 当工单未知、已结束或不可重试时抛出 UserError。
   */
  retryTicket(ticketId: string): Ticket { return this.repo.atomic(() => this.tickets.retry(ticketId)) }

  // 执行器

  /**
   * 执行器提供的事实：某个任务分配正在运行；等待它的输入会被发出。
   * @throws 当工单未知时抛出 UserError。
   */
  assignmentStarted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.started(ticketId, assignmentId) })
  }
  /**
   * 执行器提供的事实：输入已到达运行该工单的任务分配，这会清除投递失败的记录。
   * 关于已不再运行的任务分配的事实会被丢弃。其工作单元会在会话把每个输入纳入步骤时读取它（`inputsRead`）。
   */
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.delivered(ticketId, assignmentId, inputIds) })
  }
  /**
   * 执行器提供的事实：未结束工单的工作单元会话已把携带输入的消息纳入某个步骤，模型由此读取它们：
   * 此后的报告或回合结束都会在工单结束时把它们视为已读。
   * @throws 当工单未知时抛出 UserError。
   */
  inputsRead(ticketId: string, inputIds: string[]): void {
    this.repo.atomic(() => { this.assignments.read(ticketId, inputIds) })
  }
  /** 执行器提供的事实：运行该工单的任务分配的工作单元的一个回合已结束，报告之后也算。 */
  turnEnded(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.turnEnded(ticketId, assignmentId) })
  }
  /** 执行器提供的事实：向运行该工单的任务分配投递输入失败；工单会一直显示该失败，直到某次投递成功。 */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    this.repo.atomic(() => { this.assignments.deliveryFailed(ticketId, assignmentId, error) })
  }
  /**
   * 工作单元经其执行器提出的请求：把附加到其工单的某个线程标记为无关，理由为 `reason`：只会丢弃该工单的订阅，
   * 直到新的决策再次订阅它。
   * @throws 当工单未知，或针对工单启动时所在的线程、来源绑定到它的线程（例如其拉取请求的线程），
   * 或它未关注的线程时抛出 UserError。
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    this.repo.atomic(() => { this.tickets.markUnrelated(ticketId, thread, reason) })
  }
  /**
   * 执行器为上下文而订阅一个它认为相关的线程：见 `Tickets.followForContext` 和 `Thread.context`。
   * @returns 当工单已关注该线程时返回 false。
   * @throws 当工单未知或已结束时抛出 UserError。
   */
  followForContext(ticketId: string, thread: ThreadRef): boolean {
    return this.repo.atomic(() => this.tickets.followForContext(ticketId, thread))
  }
  /**
   * 主会话给未结束工单的执行器的一条事实：见 `Tickets.note`。
   * @throws 当工单未知或已结束时抛出 UserError。
   */
  note(ticketId: string, text: string): Ticket { return this.repo.atomic(() => this.tickets.note(ticketId, text)) }
  /**
   * 执行器交还一条已到达其工单、但要求的范围超出它的消息：见 `Evals.handback`。
   * @returns 是否已排队等待评估：当另一个工单仍决定它、或该工单并未决定它（见 `Evals.handback`）时为 false。
   * @throws 当工单或触发器未知、触发器未到达该工单，或该工单已交还过它时抛出 UserError。
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    return this.repo.atomic(() => this.evals.handback(ticketId, triggerId, reason))
  }
  /**
   * 在未结束工单的当前任务分配上记录报告。其向人提出的问题（`attention`）会被提出、保留或清除
   * （`null` 或 `ready` 报告），被替换且回答尚未发送的 attention 问题会从发件箱撤回。
   * `blocked` 或 `failed` 报告会暂扣自动输入，直到人的消息到达。`dropped` 报告结束工单，
   * `ready` 报告也会结束它：没有关注的线程时为 `completed`，否则在 `followsDone` 成立时采用其 `followsDone` 结果。
   * @throws 对于未知或已结束的工单、已结束的任务分配、与 ready 结果或回答同时出现的提问，
   * 或指向非人消息或未到达工单的消息的提问/回答，抛出 UserError。
   */
  report(ticketId: string, report: WorkerReport): Ticket { return this.repo.atomic(() => this.assignments.report(ticketId, report)) }
  /**
   * 处理主机停止时仍在运行的任务分配：带恢复说明重启它；除非其最新报告为 `waiting`、`ready`、`blocked` 或 `failed`
   * 且该报告之后没有输入到达其工作单元，此时保留其会话和状态，并接收等待它的输入。
   */
  assignmentInterrupted(ticketId: string, assignmentId: string): void {
    this.repo.atomic(() => { this.assignments.interrupted(ticketId, assignmentId) })
  }

  // 设置

  /**
   * 策略发生变化：`effects` 中的每个未结束工单都会被告知该变化对它的影响，进行中的评估会在新版本下重新开始。
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect> = new Map()): void {
    this.repo.atomic(() => { this.tickets.policyChanged(from, to, effects); this.evals.policyChanged(from, to) })
  }
}

/** 来源向引擎询问和告知的内容。 */
export type EngineForSources = Pick<Engine, 'receive' | 'bindThread' | 'threadClosed'>
/** 主会话向引擎询问的内容。 */
export type EngineForMainSession = Pick<Engine, 'candidate' | 'candidateDelivered' | 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'>
/** 人通过面板或主会话向引擎询问的内容。 */
export type EngineForPeople = Pick<Engine, 'stopTicket' | 'retryTicket' | 'reevaluate' | 'unsubscribe' | 'dismiss'>
/** 设置告知引擎的内容。 */
export type EngineForSettings = Pick<Engine, 'policyChanged' | 'stopTicket'>
/** 执行器告知引擎的内容，以及其工作单元向引擎询问的内容。 */
export type EngineForExecutor = Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed'
  | 'assignmentInterrupted' | 'report' | 'markUnrelated' | 'handback' | 'followForContext' | 'reply'>
