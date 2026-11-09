/** DSH 执行器：为每个工单管理一个持久的工作单元会话和工作区目录。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { key, latestAssignment, latestReport, liveTicket, runningAssignment, threadKey, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, Executor, Mandate, PolicyEffect, Ticket, TicketInput, Trigger }
  from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, shellArgv, verifyDirectory } from '../infra/environment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import { executionRoot, type Variable } from '../app/execution-environment.ts'
import type { Sessions } from '../app/sessions.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'
import { cancelled, collectJob, killJobs, runningJobs, stopBackground, stopSubagents, until, untilQuiet } from './background.ts'

const now = (): string => new Date().toISOString()
/** 返回工单的工作单元会话 ID（`worker-<ticketId>`）。 */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** 从工作单元会话 ID（`worker-<ticketId>`）返回工单 ID；非工作单元会话返回 undefined。 */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/** 工作区准备命令的最大运行时长。 */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** 启动或工作单元回合的最大瞬时重试次数，以及恢复回合前的初始退避时长。 */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** 工作单元回合结束后其后台工作还能继续运行多久，超过后就停止并报告工作单元等待中。 */
const BACKGROUND_LIMIT_MS = 30 * 60_000
/** 宿主停止时等待各工作单元后台工作停止的时长。 */
const SHUTDOWN_STOP_MS = 10_000
/** 通过瞬态失败后继续的工作单元在两次查看之间等待工作单元槽位或等待处理恢复的时长。 */
const SLOT_WAIT_MS = 5000
/** 当输入来自人时为 true（非上下文的真人触发器，或状态请求之类的直接文本输入）。 */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/**
 * 启动期间工单的工作区准备命令失败时抛出的内部错误。
 * DshExecutor 捕获它并立即把工单标记为失败，而不是自动重试，因为已存在的目录会被视为已准备，
 * 而自动重试会把失败的准备命令在该目录中留下的内容当作已准备的工作区。
 */
class PrepareFailed extends Error {}
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/**
 * 当错误表示瞬时的网络或模型提供方失败时为 true：HTTP 408、429 或 5xx 状态，
 * 或被拒绝、重置、超时、无法解析主机的连接。
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** 在已校验的英文工作树名称后附加稳定的 12 字符工单 ID 后缀。 */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** `DshExecutor` 使用的宿主依赖。 */
export interface ExecutorHost {
  /** DSH Cordis 上下文：agent 及其事件，以及用于运行准备命令的子进程服务。 */
  readonly context: Context
  /** 执行器向引擎报告任务分配和输入的进展。 */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** 持久的效果队列，启动和输入投递经由它运行。 */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** `worker` 健康条目，报告后台工作单元事件处理是否失败。 */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** 工作单元会话的会话管理器，以及把工作单元报告转发到主会话的通道。 */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'relay' | 'holds'>
  closing(): boolean
  /** 处理是否已暂停；暂停会搁置启动和输入投递。 */
  paused(): boolean
  /** 为 `ticket` 准备执行环境变量，传给其工作区准备命令。 */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** 消息 `trigger` 所回复的存储触发器（当其回复了某条消息时）。 */
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** 在 Store 中查找工单的来源触发器。 */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * 返回工作单元在请求之外的额外系统提示词授权说明：对于按规则主动承接的工作（`strength === 'inferred'`），
 * 把授权限制为规则范围内的少量内部改动；显式请求返回 `''`。
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** 构建新接受工单的执行元数据：其工作树名称、工作区目录和任务分配文本。 */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const source = ticket.origin.triggerId
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // 来源触发器与任务分配一同投递，因此 `assignment` 省略触发器文本。
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  return { name, directory: join(executionRoot(settings, stateDir), name), assignment }
}
/** 工作单元消息中内联任务分配和触发器文本的字符上限；更长的文本通过其资源读取。 */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** 返回最多 `limit` 个字符的 `text`，或返回带截断预览、总字符数和读取全文资源路径的对象。 */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * 格式化用于投递给工作单元的触发器：作者、线程、时间戳、最多 `TRIGGER_CHARS` 个字符的文本、来源消息链接、
 * 可选的路由备注，以及工作单元尚未见过的被回复消息预览。
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** 格式化工单接受批次中的同批触发器：作者、时间戳、160 字符预览和读取资源路径。 */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** 返回工单来源批次中的其他触发器（排除主 `origin.triggerId`），按时间从旧到新排列。 */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** 格式化策略变更输入供工作单元使用；在 `effect` 出现之前记录的输入回退为一条通用通知。 */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** 工作单元会话读取工单输入全文所使用的资源路径。 */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * 格式化用于投递给工作单元的工单输入：通过 `trigger` 渲染的 `trigger`（缺失时按其 ID 和读取路径）、
 * `policy-changed` 通知、`resumed` 通知、编排器的 `note`，或按原文的 `text` 输入。
 * 对遗留的 `reopen` 输入返回 `undefined`，它们只是历史数据，因为 schema 11 迁移已把待处理的 reopen 输入转换为文本输入。
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // 标记经由仅上下文订阅到达的触发器，让工作单元知道它们并非针对该工单。
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/**
 * 依据配置的并发上限跟踪活动中的和正在启动的工作单元会话：工单在其工作单元的回合运行时、
 * 在回合结束后其 shell 作业或子智能体仍运行时，以及在启动或唤醒该工作单元时占用一个槽位。
 * DshExecutor 在等待启动或唤醒工作之前同步预留槽位，以确保两次启动不会抢走最后一个槽位，
 * 并在上限之外为人工跟进（`by === 'person'`）额外允许一个槽位，使它们永远不必排在新启动之后。
 */
export class WorkerSlots {
  /** 当前持有启动槽位的工单，映射到该启动是启动、唤醒，还是因人的消息而唤醒。 */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - 返回其工作单元持有槽位的工单 ID（参见 `DshExecutor.running`）。
   * @param max - 返回配置的并发工作单元槽位上限。
   */
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  /** 当前在运行的工作单元和启动预留中已使用的槽位数量。 */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** 可并发运行的启动数量：未被运行中的工作单元或唤醒预留占用的槽位。 */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * 为 `ticketId` 预留启动槽位；若 `ticketId` 已持有启动槽位则幂等。
   * 因人的消息而唤醒（`by === 'person'`）可使用 `max()` 之外的一个额外槽位。
   * 在工作单元回合开始运行或启动/唤醒尝试结束时调用 `free(ticketId)`。
   * @throws 当没有空闲槽位时抛出 Later。
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  /** 在工作单元会话开始运行或启动/唤醒尝试结束后，释放 `ticketId` 的启动槽位。 */
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/**
 * 在每工单持久的 DSH 工作单元会话和隔离的工作区目录中执行工单任务分配。
 * 通过 Effects 排队启动和输入投递，用 WorkerSlots 管理并发，监听 Cordis 上下文上的 `agent/status`、
 * `agent/inbox/claimed`、`session/event` 和 `agent/error` 事件，并把状态变迁报告回引擎。
 * Runtime、Engine、工作单元工具和管理路由使用此类来准备、启动、投递到、停止和恢复工单任务分配。
 */
export class DshExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  /** 迄今已尝试的瞬时失败次数：工作单元回合以 `assignment.id` 为键，启动以 `launch:<assignment.id>` 为键。 */
  private readonly transient = new Map<string, number>()
  /** 当前正在等待瞬时失败退避计时器以恢复其工作单元回合的任务分配 ID。 */
  private readonly resuming = new Set<string>()
  /**
   * 按工单记录对进入空闲的工作单元后台工作的查看，这些查看会占用其槽位；查看在该工作单元重新运行
   * 或任务分配结束时结束。
   */
  private readonly settling = new Map<string, AbortController>()
  /** 按工单记录正在进行的后台工作停止操作；该工单的启动或投递会等待它。 */
  private readonly stopping = new Map<string, Promise<void>>()
  /** 按工单记录工作单元交接时留给人的作业及其结束的收集。 */
  private readonly left = new Map<string, { jobs: Set<string>; collect: AbortController }>()
  /** 按工单记录人直接输入工作单元会话的消息最近一次启动回合的时间。 */
  private readonly personal = new Map<string, string>()
  /** 通过瞬态失败后继续的工作单元的计时器，`dispose` 会清除它们。 */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** 注册 `launch` 和 `delivery` 效果处理器；处理暂停时两者都被搁置（并发上限为 0）。 */
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    // 每次启动都预留一个工作单元槽位，使启动在槽位空闲时并发运行。
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // 失败的输入投递记录在工单本身上，而不通过 `delivery` 效果的健康条目报告（`quiet: true`）。
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** 填充新接受工单的 `execution` 属性（工作树名称、工作区目录和任务分配文本）。 */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /**
   * 以工单的执行环境变量，在其父目录中为新工单工作区运行配置的 `executor.prepare` 命令，
   * 然后按工作单元的视角校验该目录。
   * 准备命令失败会抛出 `PrepareFailed`，不会自动重试；它留下的空目录会被删除，非空目录则保留。
   * @throws 当准备命令失败时抛出带命令输出的 PrepareFailed。
   */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    // 强制超时，使挂起的准备命令（例如在凭据提示上）让工单失败，而不是无限占用工作单元槽位。
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(this.host.context.subprocess, shellArgv(command), dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // 删除失败的准备命令留下的空目录，以免后续重试把它当作已准备。
        await rmdir(directory).catch(() => { /* 目录不存在，或保留了命令写入的内容，输出中会说明。 */ })
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
  }
  /** 为已接受或已恢复的任务分配排队一个 `launch` 效果；启动按队列顺序在工作单元槽位释放时开始。 */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** 排队一个 `delivery` 效果，把待处理的输入注入到 `ticket` 正在运行的工作单元会话中。 */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** 启动排队的任务分配，除非其工单已结束或期间被更新的任务分配取代。 */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      // 关闭或暂停会把启动重新排队以便恢复，瞬时的网络/提供方错误会退避重试。
      // 失败的准备命令不会自动重试，因为已存在的目录会被视为已准备，重试
      // 会把失败的准备命令在该目录中留下的内容当作已准备的工作区；因此
      // 工单被标记为失败，并等待新的人工输入或显式重试到达。
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  /**
   * 逐个把排队的输入投递给正在运行的任务分配，并在每次投递前重新读取工单状态，
   * 以便工单结束或另一个任务分配接管时立即停止投递。
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    // 工作单元后台工作的停止以取消收尾，这会丢弃在此期间投递的内容。
    await this.stopped(ticketId)
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        // 唤醒空闲工作单元会预留一个槽位（包括为人工跟进预留的额外槽位）。
        const sessionId = workerSessionId(ticketId)
        if (!woken && !this.running(ticket)) {
          // 人的消息会在新启动之前唤醒其工作单元，使用为其保留的槽位。
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          // 若工作单元会话被外部删除，则重新创建它。
          if (!this.host.context.agents.get(sessionId as SessionId)) {
            await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', ticket.title, 'worker')
          }
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // 在交付给会话之前重新检查，因为工单可能在等待 `sourceLink` 期间已结束。
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      // 期间开始的工作单元后台工作停止会以取消收尾，这会丢弃本轮输入。
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', live)
  }
  /** 格式化 `ticket` 上用于工作单元的触发器，包括工作单元尚未见过的被回复消息预览。 */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * 在结束的事务提交之后（因此回滚会让工作单元继续工作，同一事务排队的启动则在其后开始）：结束对其后台工作的查看，
   * 取消其回合（除非其最后一句话是无后续输入投递的 `ready` 或 `dropped` 报告），并停止其 shell 作业和子智能体，
   * 包括它留给人的作业。
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const sessionId = workerSessionId(ticket.id)
    this.host.store.afterCommit(() => {
      this.settling.get(ticket.id)?.abort()
      if (!ownTurn) this.host.context.agents.get(sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
      // 其 shell 作业和子智能体随之停止，自行结束回合的工作单元也是如此。
      this.stopWork(ticket.id, reason)
      this.left.get(ticket.id)?.collect.abort(); this.left.delete(ticket.id); this.personal.delete(ticket.id)
    })
  }
  /** 停止工单的工作单元在后台运行的内容（参见 `stopBackground`）。 */
  private stopWork(ticketId: string, reason: string, keepInbox = false): void {
    this.track(ticketId, stopBackground(this.host.context, workerSessionId(ticketId), reason, keepInbox))
  }
  /** 工单后台工作的一次停止；该工单的启动或投递会在其运行期间等待它。 */
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    void this.background(stop)
  }
  /** 等待正在运行的工单后台工作停止，除非宿主先停止。 */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
  /**
   * 宿主停止时，在限定时间内：停止每个已加载工作单元的后台工作并保留其收件箱；然后结束对被终止的、留给人的作业的收集，
   * 并取消期间启动的工作单元回合，保留其收件箱。
   */
  async shutdown(): Promise<void> {
    const agents = this.host.store.tickets.list().map(ticket => this.host.context.agents.get(workerSessionId(ticket.id) as SessionId))
      .filter((agent): agent is Agent => agent !== undefined)
    const stop = async () => {
      await Promise.allSettled(agents.map(agent => stopBackground(this.host.context, agent.id, 'dsh-superagent stopped', true)))
      for (const { collect } of this.left.values()) collect.abort()
      const running = agents.filter(agent => agent.status !== 'idle')
      for (const agent of running) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled(running.map(agent => agent.whenIdle()))
    }
    await until(stop(), undefined, SHUTDOWN_STOP_MS)
  }
  /** 其工作单元持有槽位的未结束工单数量：回合正在运行，或回合结束后 shell 作业或子智能体仍在运行。 */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** 工单的工作单元是否持有槽位：回合正在运行，或回合结束后其 shell 作业或子智能体仍在运行。 */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.status === 'running' || this.settling.has(ticket.id)
  }
  /** 启动失败后把工单标记为失败；工单会等待新的人工输入或显式重试到达。 */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  /** 在一个事务中记录工单上的 `failed` 报告并把失败转发到主会话。 */
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('dsh-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    // 工作区目录只准备一次；已存在的目录视为已准备，包括在 `prepare` 命令出现之前创建的工作树。
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    if (!current()) return
    const sessionId = workerSessionId(ticket.id)
    const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')
    if (!current()) return
    // 被本任务分配取代的那个任务分配的后台工作先停止，以免其结束清除本任务分配的消息。
    await this.stopped(ticket.id)
    if (!current()) return
    // 为本任务分配放回的消息可能仍等待在会话中，由重启的取消保留，或跨崩溃持久化；
    // 此时本次启动的消息会把它带入下一步，与随后投递的副本并存：只保留那一个副本。
    for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id))
    // 第一条消息承载任务分配和来源触发器；后续任务分配的消息只说明新增内容，除非
    // 会话丢失了第一条，例如有人删除了它。
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && await this.host.sessions.holds(sessionId, first)
    if (!current()) return
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    await this.host.sessions.prompt(sessionId, requestId, text, 'queue',
      () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
      () => { this.host.engine.assignmentStarted(ticket.id, assignment.id) })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** 当 `agent` 是工作单元会话时返回其对应的存储工单，否则返回 undefined。 */
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /** 订阅工作单元会话的宿主 `agent/status`、`agent/inbox/claimed`、`session/event` 和 `agent/error` 事件。启动时调用一次。 */
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // 开始的回合会结束对其工作单元后台工作的查看；该回合自己的空闲会重新查看。
      if (status === 'running') { this.settling.get(ticketOfSession(agent.id) ?? '')?.abort(); return }
      // 由停止工作单元子智能体唤醒并取消的回合不是该工作单元的回合。
      if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerIdle(ticket, assignment, agent))
    }))
    // 人直接输入工作单元会话的消息，工单不会记录它。
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const ticketId = ticketOfSession(agent.id)
      if (ticketId !== undefined && message.source.kind === 'user') this.personal.set(ticketId, now())
    }))
    // dsh-superagent 消息所携带的输入，工作单元会在会话把该消息收入历史后读取：
    // 在此之前认领它的步骤可能被取消或失败，从而丢弃它。
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const ticketId = ticketOfSession(session.id)
      if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent' || this.host.closing()) return
      const message = event.data
      void this.background(Promise.resolve().then(() => {
        const read = this.host.store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'trigger' && !input.readAt
          && this.host.sessions.promptedId(input.id) === message.id).map(input => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      }))
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing()) return
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
      void this.background(Promise.resolve().then(() => { this.failed(ticket.id, String(error)) }))
    }))
  }
  /** 取消订阅宿主 agent 事件，并清除所有待处理的瞬时重试计时器。 */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
  /**
   * 宿主重启后，对未结束工单中的运行中和待处理任务分配进行对账：通知引擎有运行中的任务分配被中断，
   * 并重新排队待处理的启动（早期版本可能把它们放在效果队列之外），
   * 而失败的启动（`waitsForPerson`）会等待人的消息或重试。
   */
  resume(): void {
    // 按接受顺序（从旧到新）启动待处理的工单。
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) {
        // 本进程内的重启保留了 DSH 的会话、作业和子智能体在运行：它们先停止。收件箱会保留
        // 已交接但尚未被取走的输入。
        this.host.context.agents.get(workerSessionId(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
        this.stopWork(ticket.id, 'dsh-superagent restarted', true)
        this.host.engine.assignmentInterrupted(ticket.id, running.id)
      }
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** 运行后台工作单元事件处理，并在失败或恢复时更新 `worker` 健康条目。 */
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * 检查 `error` 是否是在 `key` 下仍有重试次数的瞬时失败，并修改 `this.transient`：
   * 重试时递增尝试计数并返回 `true`；非瞬时或次数用尽时从 `this.transient` 删除 `key` 并返回 `false`。
   */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** 在瞬时提供方或网络错误之后，以指数退避安排一次工作单元回合重试。 */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      // 在处理暂停或没有空闲唤醒槽位时等待。
      if (this.host.paused()) { this.after(SLOT_WAIT_MS, go); return }
      const sessionId = workerSessionId(ticketId)
      const waking = !this.running(ticket)
      try { if (waking) this.slots.reserve(ticketId, 'wake') } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        this.after(SLOT_WAIT_MS, go); return
      }
      const sent = this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, 'queue')
      void this.background(sent.finally(() => { if (waking) this.slots.free(ticketId); this.resuming.delete(assignmentId) })
        .catch(failure => { this.failed(ticketId, String(failure)) }))
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  /** 安排 `then` 在 `ms` 毫秒后运行，除非先调用了 `dispose()`。 */
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /**
   * 交接给人的工作单元会释放其槽位：其子智能体停止，其 shell 作业（例如为这个人运行的服务）留给人直到任务分配结束。
   * 它们不占槽位，也不受任何时限约束；它们的结束会被收集，因此不会在槽位之外唤醒工作单元，
   * 而工作单元会在下一个回合读取每一个的结束。
   */
  private handOff(ticketId: string, agent: Agent): void {
    this.track(ticketId, stopSubagents(this.host.context, agent, true))
    const left = this.left.get(ticketId) ?? { jobs: new Set<string>(), collect: new AbortController() }
    this.left.set(ticketId, left)
    for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
      left.jobs.add(job.id)
      void this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async ended => {
        if (!ended) return
        const note = `Your background job ${ended.name} ended: ${ended.status}.`
        await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' })
      }))
    }
  }
  private async workerIdle(ticket: Ticket, idle: Assignment, agent: Agent): Promise<void> {
    await agent.whenIdle()
    // 因瞬时原因失败的回合会在退避后继续，这不算回合结束。
    if (this.resuming.has(idle.id) || agent.status !== 'idle') return
    // 正常结束的回合会重新开始统计瞬时失败次数。
    this.transient.delete(idle.id)
    // 在进入空闲的任务分配仍在运行该工单期间的工单。
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // 最后一句话是结果、给人的问题，或 blocked/failed 报告的工作单元已交接给人；
    // 在其结果或问题之后投递的输入属于新工作。
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    // 人在会话中启动的回合属于这个人的工作，它会像任何回合一样在后台继续。
    const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id)
    // 工作单元读取了在已结束回合之前到达的内容：它交接时所在的回合，或后台工作已结束的回合。
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      this.handOff(ticket.id, agent)
      return
    }
    // 其回合要在后台再无任何运行时才结束，期间会占用其槽位：至多从本次空闲起算到时限，
    // 以及直到工作单元重新运行或任务分配结束。
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController(), limit = new AbortController()
    this.settling.set(ticket.id, look)
    const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    let quiet: boolean
    const left = this.left.get(ticket.id)?.jobs
    try { quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([this.host.lifetime, look.signal, limit.signal]), left) }
    finally { clearTimeout(timer); if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id) }
    const current = live()
    if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || this.resuming.has(idle.id)) return
    if (quiet) this.host.engine.turnEnded(ticket.id, idle.id)
    let stopped = ''
    if (!quiet) {
      // 超过时限仍在运行的 shell 作业会被终止，并在其下一个回合被告知；其子智能体则会继续运行，
      // 因为停止它们会唤醒工作单元。
      const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 60_000
      const jobs = runningJobs(this.host.context, sessionId, left).map(job => job.name)
      if (jobs.length) {
        void this.background(killJobs(this.host.context, sessionId, 'The job ran past its limit', left))
        const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(', ')}.`
        void this.background(this.host.sessions.prompt(sessionId, `killed:${jobs.join(',')}`, note, { inject: 'Background jobs killed' }))
      }
      stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(', ')}.`
        : `Subagents still ran ${minutes} minutes after the worker's turn ended.`
    }
    // 工作单元可能在其回合结束时已提交报告；被人的消息解除的 blocked 或 failed 报告是过时的。
    if (handedOff(current)) return
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    const said = [text, stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // orchestrator_report 之后的静默收尾既不是新状态，也不是空交接。
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
      }
    })
  }
}
