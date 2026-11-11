/** 主动式智能体的领域模型：概念及其不变量，独立于任何来源、策略或执行器。 */
import type { Reason } from './reasons.ts'

/** 用来源自身词汇表示的操作者身份；策略决定哪些操作者可以在该来源上发起工作。 */
export interface ActorRef { source: string; id: string }
/** 线程身份；从原生事件推导出 `id` 的规则属于来源本身。 */
export interface ThreadRef { source: string; id: string }
/** 线程上的只写地址；地址格式属于来源本身。 */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

/** 整个领域中线程的稳定键。 */
export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`
/**
 * 把有效时间戳规范化为 `Date#toISOString` 形式，使已存储的时间戳在内存和 SQL 中可按字典序比较；
 * 无法解析为时间戳的值原样返回。
 */
export function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

/** 来源产生的一个不可变事件。`text` 和 `meta` 是不可信的外部数据。 */
export interface Trigger {
  id: string
  source: string
  /** 触发器所属的每个线程；第一个（`threads[0]`）是承载其评估的主线程。 */
  threads: ThreadRef[]
  actor: ActorRef
  /** 由来源声明：该事件由人写下，而非机器人、CI 或本智能体。 */
  human: boolean
  /** 由来源声明：发送方通过提及或在私信中直接面向智能体。 */
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  /** 供适配器使用的来源原生细节；核心从不解释它们。 */
  meta: Record<string, unknown>
}

/** 触发器摄入之后的去向；它不授予任何权限，但决定由谁来决定人的后续消息（见 `followupOwners`）。 */
export interface TriggerDisposition {
  /** 进入领域之前被来源范围过滤器拒绝，附带来源给出的原因。 */
  filtered?: Reason
  evalId?: string
  decisionId?: string
  /**
   * 它通过订阅分发或由主会话附加而到达的工单；已结束的工单、或工作单元未承接而无法恢复的工单不再计入。
   */
  fanout: string[]
  /** `fanout` 中仅在其执行器为上下文而关注的线程上到达的工单，这使该消息不属于它们。 */
  context?: string[]
  /** 人，或对没有工单决定的消息由主会话，再次把它送去评估；交还操作不会设置它。 */
  requeued?: true
  /** 其执行器以超出工单范围为由交还它的工单，每个工单一次，并附原因；当没有工单决定它时进入评估。 */
  handbacks?: { ticketId: string; reason: string; at: string }[]
  /** 其执行器确认或回答过它的工单，即作为工单内的工作承接。 */
  acked?: string[]
  at: string
}
/** 决定后续消息归属者时所读取的内容：已存储的工单、线程和处置状态，与存储层和核心所保存的一致。 */
export interface FollowupRecords {
  tickets: { get(id: string): Ticket | undefined }
  threads: { get(key: string): Thread | undefined }
  triggers: { disposition(id: string): TriggerDisposition | undefined }
}
/**
 * 由工作单元决定人的后续消息的工单：在其自有线程上到达它、仍能决定该消息且未交还的工单。
 * 工单在未结束时可以决定，即使人已丢弃其对线程的订阅；已结束但非被人结束、且触发器仍等待恢复它时也可以。
 * 人把它送去评估后，或某个（可能由旧版本排队的）评估持有它时，则没有归属者。
 * 当某工单拥有它时，该消息不进入任何评估，主会话只能停止其上的工作。
 */
export function followupOwners(trigger: Pick<Trigger, 'id' | 'human' | 'threads'>, records: FollowupRecords): string[] {
  if (!trigger.human) return []
  const disposition = records.triggers.disposition(trigger.id)
  if (!disposition || disposition.requeued) return []
  // 单凭处置状态就能排除大多数消息，因此只对可能有归属者的消息才去读取线程或工单。
  const returned = new Set(disposition.handbacks?.map(item => item.ticketId))
  const reached = disposition.fanout.filter(id => !returned.has(id) && !disposition.context?.includes(id))
  if (!reached.length || records.threads.get(threadKey(trigger.threads[0]!))?.evaluating?.triggerIds.includes(trigger.id)) return []
  return reached.filter(id => {
    const ticket = records.tickets.get(id)
    return !!ticket && (liveTicket(ticket) || (ticket.ended?.by !== 'human'
      && ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id && ticket.undelivered.includes(input.id))))
  })
}
/**
 * 决策是否解决了人的消息所要求的事：对其停止（被采纳或拒绝）只决定该工单的工作，
 * 把它路由到工单则留给该工单的工作单元，而 unavailable 决策什么也没决定。
 */
export const settled = (decision: Pick<Decision, 'kind' | 'reason'>): boolean => !['stop', 'unavailable'].includes(decision.kind)
  && !decision.reason.some(reason => ['stopNotExplicit', 'stopUnknown', 'routed'].includes(reason.code))

export type Strength = 'explicit' | 'inferred'
/** 接收范围内某一行在准入表中的单元格，取决于发送方是否在名单中以及是否直接面向智能体。 */
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
/**
 * 主动候选是否会被评估并接受（`auto`）、是否仍被评估以便决策记录它们将会接受什么（`would_accept`）但不实际接受（`observe`），
 * 或不予准入（`off`）。
 */
export type AcceptMode = 'off' | 'observe' | 'auto'
/** 授权的触发器在何处被接收：其来源、来源记录的接收范围，以及其准入行。 */
interface Received { source?: string; scope?: Record<string, unknown>; row?: string }
/**
 * 门禁如何准入授权所依据的触发器，`revalidate` 会重新检查（见 `docs/002`）：
 * - `addressed`：来源名单上的发送方直接面向智能体；
 * - `followup`：有工单的线程上的消息；
 * - `admission`：接收范围准入行中的单元格；在某种接受模式下产生推断候选时为 `observation`；
 * - `listed`：在授权记录依据之前被接受，来自仍必须在名单上的发送方；`authority` 是旧版本记录的内容。
 * `sender` 指接受时被允许的发送方，`rules` 指某次评估匹配到的规则。
 */
export type MandateBasis = Received & { sender?: string; rules?: string[] } & (
  | { via: 'addressed'; addressed: 'mention' | 'direct' }
  | { via: 'followup'; authority?: string }
  | { via: 'admission'; cell: AdmissionCell; addressed?: 'mention' | 'direct'; observation?: { mode: AcceptMode } }
  | { via: 'listed'; addressed?: 'mention' | 'direct'; observation?: { mode?: AcceptMode }; authority?: string }
  /** 来源机器人名单上的机器人的消息：最多只能是推断候选，永远不会是明确请求或停止。 */
  | { via: 'bot'; addressed?: 'mention' | 'direct'; observation: { mode: AcceptMode } }
  /**
   * 项目调度按配置直接准入：`project` 是项目记录，`task` 是任务项标识。
   * 授权不来自消息，因此重新校验只检查项目及其引用的仓库与任务来源是否仍然有效。
   */
  | { via: 'scheduled'; project: string; task: string }
)

/** 接受决策产生的不可变授权；执行受其约束，且它永不改变。 */
export interface Mandate {
  strength: Strength
  policyVersion: string
  /** 门禁如何准入它，用于重新校验和审计。 */
  basis: MandateBasis
  actor: ActorRef
  scope: string
}

/** 线程上进行中的触发器评估；每个线程至多一个。 */
export interface Evaluation {
  id: string
  threadKey: string
  triggerIds: string[]
  /** 给了该批次强度的可准入触发器，评估启动的工单会把它作为来源。 */
  primary?: string
  strength: Strength
  /** 最强可准入触发器的操作者与门禁依据；接受时它们会成为授权的初始值。 */
  actor: ActorRef
  basis: MandateBasis
  policyVersion: string
  startedAt: string
  /** 候选到达评估者会话的时间戳；在此之前不会过期，其截止时间自此计算。 */
  delivered?: string
  /** 过期时间戳，从投递时计算（未投递时从开始时计算）；处理暂停会使其按暂停时长顺延。 */
  deadline: string
  /** 处理暂停开始的时间戳；恢复时会把 `deadline` 按暂停时长顺延；恢复后清除。 */
  pausedAt?: string
}

/** 线程聚合：评估的一致性边界，订阅与决策历史的持有者。 */
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  /** 该线程上最新触发器的时间。 */
  lastAt?: string
  /** 订阅该线程的工单；未结束的工单会通过分发把每个触发器作为上下文接收。 */
  subscriptions: string[]
  /**
   * 其执行器为只读上下文而关注该线程的已订阅工单，例如某个 Issue 或它发现的另一个拉取请求：
   * 消息会到达它们，但不授予任何权限，且其中人的消息不会恢复任何已结束的工单。
   */
  context?: string[]
  /** 与该线程共享同一触发器的其他线程键；仅作上下文。 */
  correlated: string[]
  /** 等待下一次评估的触发器（防抖缓冲）。 */
  pending: string[]
  evaluating?: Evaluation
  /** 其排队触发器的评估连续过期了多少次，每次都会重新排队；某个决策会清除它。 */
  expired?: number
  /**
   * 渠道或读取方需要的来源原生属性（例如飞书线程 id）。其来源也可以为人们描述该线程：
   * `label`（显示名称）和 `facts`（一个 {@link ThreadFacts} 映射）。
   */
  meta: Record<string, unknown>
}
/** 两种界面语言下的文本，或两种语言相同的文本。 */
export type Text = string | { zh: string; en: string }
/** 来源就其线程陈述的一条事实，例如 issue 编号或 CI 结果；`problem` 标记需要人处理的事实。 */
export interface ThreadFact { label?: Text; value: Text; problem?: true }
/** 线程按 id 组织的事实，按显示顺序排列；每个写入方拥有自己的事实 id。 */
export type ThreadFacts = Record<string, ThreadFact>

export type DecisionKind = 'ignore' | 'accept' | 'reopen' | 'stop' | 'unavailable'
/** 一次评估的结果，记录在线程上。 */
export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  policyVersion: string
  at: string
  kind: DecisionKind
  /** 原因代码：一个原因，或其涉及的批次中每个触发器各一个。 */
  reason: Reason[]
  strength: Strength
  ticketId?: string
  mandate?: Mandate
  /** 评估者提供的审计数据（规则评估、方向、证据）。 */
  audit?: Record<string, unknown>
  /** 人已忽略 unavailable 决策所显示的问题。 */
  dismissed?: true
}

export type AssignmentState = 'pending' | 'running' | 'ended'
/**
 * 任务分配汇报的内容：工作正在进行（`progress`）、其工作单元在等待触发器（`waiting`）、结果已就绪（`ready`）、
 * 需要人操作才能解除阻塞或恢复（`blocked` 或 `failed`），或已无事可做（`dropped`）。
 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
/** 工单与某个执行器实例之间的绑定。 */
export interface Assignment {
  id: string
  state: AssignmentState
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: { state: ReportState; summary: string; at: string }
  /** 输入最后一次到达工作单元的时间；若不早于 `report.at`，表示该报告之后工作单元一直在处理输入。 */
  deliveredAt?: string
  /**
   * 其工作单元的一个回合最后一次结束时，已无待运行的内容且无等待它的内容：此前会话已纳入步骤的内容，
   * 工作单元已读取。
   */
  idleAt?: string
}

export type TicketInput =
  /** 其某个线程上的触发器，或附加到它的触发器；由人写下时为 `human`。 */
  | { id: string; kind: 'trigger'; triggerId: string; at: string; note?: string; human?: true
    /** 它仅在其执行器为上下文而关注的线程上到达该工单。 */
    context?: true
    /**
     * 工作单元的会话何时把携带它的消息纳入某个步骤，模型由此读取它；在会话中等待时为 `null`。
     * 在记录读取之前投递的输入没有该值，从 `deliveredAt` 起视为已读。
     */
    readAt?: string | null
    /** 它最后被投递到的任务分配。 */
    deliveredTo?: string
    /** 旧版本把它交给工作单元的时间。 */
    deliveredAt?: string }
  /** 策略以 `effect` 所述的方式发生变化并影响该工单；在效果出现之前写入的输入没有此字段。 */
  | { id: string; kind: 'policy-changed'; from: string; to: string; at: string; effect?: PolicyEffect }
  /** 某个决策重新打开了该工单；在已结束工单能自行恢复之前写入。 */
  | { id: string; kind: 'reopen'; decisionId: string; at: string }
  /** 其某个线程上人的消息，在其授权不变的情况下恢复了已结束的工单。 */
  | { id: string; kind: 'resumed'; triggerId: string; at: string }
  | { id: string; kind: 'text'; text: string; at: string }
  /** 主会话从其他工作给该工单的一条事实：仅作上下文，不要求也不授予任何权限。 */
  | { id: string; kind: 'note'; text: string; at: string }

/**
 * 策略变化如何影响某工单：它被接受时所依据的规则中发生变化、指令已更新或不再适用的那些；
 * 当推断的工作不再被接受时（例如接受模式离开 `auto`）为 `proactive: false`；
 * 当其针对的发送方 `requester`（人或机器人）可能不再能在该处发起工作时为 `requesterAllowed: false`。
 */
export interface PolicyEffect {
  rules?: { id: string; name: string; change: 'changed' | 'disabled'; instruction?: string }[]
  proactive?: false
  requesterAllowed?: false
  requester?: ActorRef
}

export type TicketEndBy = 'executor' | 'human'
/** 工单如何结束：带着结果、其拉取请求已合入或未合入即关闭、无事可做，或被人停止。 */
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
/** 向人提出的问题；`triggerId` 是提出它的人的消息，回答会回到该会话。 */
export interface Attention { id: string; question: string; triggerId?: string }
/** 工单聚合：一个已授权的工作项，含其任务分配、渠道、线程绑定和输入。 */
export interface Ticket {
  id: string
  title: string
  decisionId: string
  mandate: Mandate
  /** 接受它时那些消息的渠道，其回复会发往那里。 */
  channels: ChannelRef[]
  /** 工单何时、由谁、以何种方式结束，以及结果之外的人或主机给出的原因；未结束的工单没有此字段。 */
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  /** 向人提出的未解决问题；由执行器或工单结束时清除。 */
  attention?: Attention
  assignments: Assignment[]
  inputs: TicketInput[]
  /** 尚未交给运行中任务分配的输入。 */
  undelivered: string[]
  /**
   * 来源让工单关注的线程，例如其拉取请求的线程：`ready` 报告只有在 `followsDone` 成立时才结束工单；
   * 使其成立的那次关闭会以该结果结束工单，除非其工作尚未完成（见 `Tickets.unfinished`），
   * 此时由下一次 `ready` 或 `dropped` 报告结束它。
   */
  follows?: Follow[]
  /** 工作单元已回答的人的问题，其回答可由主会话发送。 */
  answers?: string[]
  createdAt: string
  updatedAt: string
  /** 接受它的那些触发器：启动它的那个，以及其评估持有的批次。 */
  origin: { triggerId: string; triggerIds: string[] }
  /** 其执行器所选的内容：短名称、目录和任务分配文本。 */
  execution?: Execution
  /** 最近一次向工作单元投递输入失败的信息，直到某次投递成功。 */
  delivery?: { error: string; at: string }
}
/**
 * 工单关注的线程，按线程键表示：`own` 表示工单打开了它（例如其自身的拉取请求），以及它何时、以何种方式关闭。
 * 当其自身没有处于打开状态的线程时，或当工单没有 `own` 线程而所有被关注的线程都已关闭时，`followsDone` 成立；
 * 此时工单会结束，除非其工作尚未完成（见 `Tickets.unfinished`）。
 */
export interface Follow { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }
export interface Execution { name: string; project?: string; directory: string; assignment: string }

/** 工单是否未结束：它尚未结束。 */
export const liveTicket = (ticket: Pick<Ticket, 'ended'>): boolean => !ticket.ended
/** 工单如何结束。 */
export const ticketOutcome = (ticket: Pick<Ticket, 'ended'>): TicketOutcome | undefined => ticket.ended?.outcome
export const runningAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.find(assignment => assignment.state === 'running')
/**
 * 触发器是否到达过某工单：它启动了该工单、作为输入来到该工单，或位于该工单订阅的线程上；
 * 当 `context` 为 false 时，不含工单仅为上下文而关注的线程——在那里其工作单元可以读取但不能写入。
 */
export function reached(ticket: Ticket, trigger: Trigger, thread: (key: string) => Thread | undefined, context = true): boolean {
  if (ticket.origin.triggerId === trigger.id) return true
  const input = ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === trigger.id)
  return trigger.threads.some(ref => {
    const current = thread(threadKey(ref))
    return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id))
  }) || (input && (context || !trigger.threads.every(ref => thread(threadKey(ref))?.context?.includes(ticket.id))))
}
export const latestAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.at(-1)
/** 工单的任一任务分配所作的最新报告，即工单最后所述的内容。 */
export const latestReport = (ticket: Pick<Ticket, 'assignments'>): Assignment['report'] => ticket.assignments.findLast(assignment => assignment.report)?.report
/**
 * 工单的工作单元在何时之前有机会读取到达它的内容：其最新报告，但当 `progress` 为 false 时的进度报告除外，
 * 或最新回合结束的时间，取较晚者。
 */
export function readUntil(ticket: Pick<Ticket, 'assignments'>, progress = true): string {
  const report = ticket.assignments.findLast(assignment => assignment.report && (progress || assignment.report.state !== 'progress'))?.report
  return [report?.at ?? '', ...ticket.assignments.map(assignment => assignment.idleAt ?? '')].reduce((a, b) => a > b ? a : b)
}
/**
 * 工单是否在等待人：其最新任务分配报告为 blocked 或 failed，且此后没有人的消息到达。
 * 之后非这两种状态的报告、人的消息，或（会启动新任务分配的）重试，都会解除等待。
 */
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false
  return !ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context && input.at > report.at)
}
