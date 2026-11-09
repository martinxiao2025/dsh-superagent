/** 评估：对排队触发器在线程层面的评估，以及它们最终形成的决策。 */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { liveTicket, threadKey } from './model.ts'
import type { Decision, DecisionKind, Evaluation, Mandate, MandateBasis, Strength, Thread, Trigger } from './model.ts'
import type { AssessmentOutcome, Candidate, Policy } from './ports.ts'
import { said, type Reason } from './reasons.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Tickets } from './tickets.ts'

/** 持有某个触发器的评估的结果；`evalId` 指明该结果是为哪次评估判定的，因此后来的评估会拒绝它。 */
export type Outcome = AssessmentOutcome & { evalId?: string }
/** 评估结束时记录到决策中的内容。 */
interface Finished { kind: DecisionKind; reason: Reason[]; audit?: Record<string, unknown>; ticketId?: string; mandate?: Mandate }
/** 结果的原因：优先使用其携带的代码，否则使用评估者或人写下的文字。 */
const reasonOf = (reason: string | Reason): Reason[] => [typeof reason === 'string' ? said(reason) : reason]
const stronger = (a: Strength, b: Strength): Strength => a === 'explicit' || b === 'explicit' ? 'explicit' : 'inferred'
/** 过期的评估在记为 unavailable 之前会连续把其触发器重新排队多少次。 */
const REQUEUES = 2

/**
 * Evals 运行各线程的评估：把一个线程上排队的触发器合成一次评估，从门禁取得其强度、操作者和依据，
 * 询问评估者，在暂停期间保留其截止时间，并记录它最终形成的决策：接受、停止、忽略或 unavailable。
 * 它依赖 Tickets 创建接受决策所决定的工单、结束停止决策所指的工单；Engine 把主会话的决策、人的重放、
 * 工作单元的交还以及处理轮的评估工作都路由到这里。
 */
export class Evals extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets) { super(options) }

  /**
   * 让线程的评估在超过截止时间后过期（见 `expire`），除非处理已暂停：此时评估会记下处理暂停开始的时间，
   * 恢复后其截止时间按暂停时长顺延。候选尚未送达评估者会话的评估不会过期。
   */
  due(thread: Thread, policy: Policy): void {
    const evaluation = thread.evaluating
    if (!evaluation || (policy.paused && evaluation.pausedAt)) return
    const now = this.now()
    if (policy.paused) evaluation.pausedAt = now
    else if (evaluation.pausedAt) {
      evaluation.deadline = new Date(Date.parse(evaluation.deadline) + Date.parse(now) - Date.parse(evaluation.pausedAt)).toISOString()
      delete evaluation.pausedAt
    } else if (evaluation.delivered && evaluation.deadline <= now) { this.expire(thread); return }
    else return
    this.repo.threads.save(thread)
  }
  /** 评估的候选已送达评估者会话：其截止时间从此刻开始计算。 */
  delivered(evalId: string, policy: Policy): void {
    const thread = this.repo.threads.active().find(item => item.evaluating?.id === evalId)
    if (!thread?.evaluating || thread.evaluating.delivered) return
    const now = this.now()
    thread.evaluating.delivered = now
    thread.evaluating.deadline = new Date(Date.parse(now) + policy.evalTimeoutMs).toISOString()
    this.repo.threads.save(thread)
  }
  /**
   * 超过截止时间的评估会把其触发器重新排队等待新的评估，最多连续 `REQUEUES` 次，
   * 以免繁忙的评估者丢弃请求；超过次数后记为 unavailable。
   */
  private expire(thread: Thread): void {
    const expired = (thread.expired ?? 0) + 1
    if (expired > REQUEUES) { this.finish(thread, thread.evaluating!, { kind: 'unavailable', reason: [{ code: 'timeout' }] }); return }
    const { id, triggerIds } = thread.evaluating!
    delete thread.evaluating
    thread.expired = expired
    thread.pending = [...triggerIds, ...thread.pending.filter(item => !triggerIds.includes(item))]
    this.repo.threads.save(thread)
    this.options.assessor.release?.(id)
  }
  /** 启动一次对线程上排队触发器的评估，由门禁判定，并向评估者请求评估结果。 */
  start(threadKeyValue: string, policy: Policy): void {
    const thread = this.repo.threads.get(threadKeyValue)!
    const at = this.now()
    // 仍由工单决定的人的后续消息属于该工单：旧版本排队的这类消息会离开队列且不产生决策。
    const delivered = (id: string) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger && this.owners(trigger).length > 0
    }
    if (thread.pending.some(delivered)) {
      const followups = thread.pending.filter(delivered)
      thread.pending = thread.pending.filter(id => !followups.includes(id))
      this.repo.threads.save(thread)
      for (const triggerId of followups) this.emit('trigger.followup', { triggerId })
      if (!thread.pending.length) return
    }
    // 已经产生过工单的触发器不能再为新评估提供授权，也不能再生成重复的工单。
    const accepted = this.accepted(thread.key)
    const started = thread.pending.filter(id => accepted.has(id))
    const startedTicket = (id: string): Reason => ({ code: 'startedTicket', triggerId: id, values: { ticket: accepted.get(id)!.ticketId! } })
    if (started.length) this.ignore(thread, started, started.map(startedTicket), policy, at)
    const triggers = thread.pending.flatMap(id => { const trigger = this.repo.triggers.get(id); return trigger ? [trigger] : [] })
    const tickets = this.ticketsOnThread(thread)
    const reasons: Reason[] = []
    let strongest: { trigger: Trigger; strength: Strength; basis: MandateBasis } | undefined
    for (const trigger of triggers) {
      const gate = policy.gate(trigger, thread, tickets)
      if (!gate.admissible) { reasons.push({ code: gate.reason, triggerId: trigger.id }); continue }
      const later = gate.strength === strongest?.strength && trigger.at >= strongest.trigger.at
      const weaker = !strongest || stronger(strongest.strength, gate.strength) !== strongest.strength
      if (weaker || later) strongest = { trigger, strength: gate.strength, basis: gate.basis }
    }
    if (!strongest) {
      if (thread.pending.length) this.ignore(thread, [...thread.pending], reasons.length ? reasons : [{ code: 'noAdmissible' }], policy, at)
      this.repo.threads.save(thread)
      return
    }
    const evalId = key('eval', thread.key, policy.version, at, ...thread.pending)
    const deadline = new Date(Date.parse(at) + policy.evalTimeoutMs).toISOString()
    const { strength, trigger: { actor }, basis } = strongest
    thread.evaluating = { id: evalId, threadKey: thread.key, triggerIds: thread.pending, primary: strongest.trigger.id, strength, actor, basis,
      policyVersion: policy.version, startedAt: at, deadline }
    thread.pending = []
    this.repo.threads.save(thread)
    for (const trigger of triggers) {
      this.repo.triggers.saveDisposition(trigger.id, { ...(this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at }), evalId })
    }
    this.emit('eval.started', { evalId, threadKey: thread.key, triggerIds: thread.evaluating.triggerIds, strength: strongest.strength })
    this.options.assessor.request(this.candidateOf(thread))
  }
  /** 持有 `triggerId` 的评估所产生的候选；没有评估持有时为 undefined。 */
  candidate(triggerId: string): Candidate | undefined {
    const thread = this.holding(triggerId)
    return thread && this.candidateOf(thread)
  }
  /**
   * 决定一个触发器：由持有它的评估决定；若无评估持有，则对它单独做一次直接评估。
   * @throws 当触发器未知或不可准入、`outcome.evalId` 指向已完成的评估、工单的工作单元仍决定该触发器且结果不是停止，
   * 或在 `auto` 模式之外接受推断候选、或没有已启用的匹配规则时抛出 UserError。
   */
  decide(triggerId: string, outcome: Outcome): Decision {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    const held = this.holding(triggerId)
    if (outcome.evalId && held?.evaluating?.id !== outcome.evalId) throw new UserError('evalFinished', { eval: outcome.evalId })
    // 防止已重放且已创建过工单的触发器再生成第二个工单。
    const earlier = outcome.kind === 'accept' ? this.accepted(threadKey(trigger.threads[0]!)).get(triggerId) : undefined
    if (earlier) {
      // 只有旧版本启动的评估才可能仍持有它；在不含它的情况下重新评估剩余触发器，若只剩它则忽略它。
      const others = held?.evaluating?.triggerIds.filter(id => id !== triggerId) ?? []
      if (held && others.length) this.reassess(held, { code: 'acceptedBefore', values: { trigger: triggerId } }, [triggerId])
      else if (held) {
        this.finish(held, held.evaluating!, { kind: 'ignore', reason: [{ code: 'startedTicket', triggerId, values: { ticket: earlier.ticketId! } }] })
      }
      return earlier
    }
    // 到达某工单的后续消息应由其工作单元判定：主会话只能停止其上的工作。
    if (outcome.kind !== 'stop') this.leftToWorkers(trigger)
    const thread = held ?? this.thread(trigger.threads[0]!)
    const evaluation = held?.evaluating ?? this.directEval(thread, trigger, outcome.kind, outcome.kind === 'stop' ? outcome.ticketId : undefined)
    // 推断候选只有在评估匹配到的已启用规则下才被接受，而评估本身可以接受。
    if (outcome.kind === 'accept' && evaluation.strength !== 'explicit' && !this.policy().admitsInferred(outcome.rules ?? [])) {
      throw new UserError('notExplicit')
    }
    return this.decideEval(thread, evaluation, outcome)
  }
  /**
   * 把已存储的触发器排队到其主线程等待新的评估，并发出 `trigger.requeued`；有评估持有它时返回 false。
   * @throws 当触发器未知时抛出 UserError。
   */
  reevaluate(triggerId: string): boolean {
    if (!this.requeue(triggerId)) return false
    this.emit('trigger.requeued', { triggerId })
    return true
  }
  /** 把触发器排队到其主线程等待新的评估；有评估持有它时为 false。 */
  private requeue(triggerId: string): boolean {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    if (this.holding(triggerId)) return false
    this.queueForEval(trigger)
    const disposition = this.repo.triggers.disposition(triggerId) ?? { fanout: [], at: this.now() }
    this.repo.triggers.saveDisposition(triggerId, { ...disposition, requeued: true })
    return true
  }
  /**
   * 记录工单的执行器以超出工单范围为由交还了一个已到达它的触发器，并在该工单曾决定它、且没有其他工单仍决定它时
   * 排队等待新的评估（见 `handBack`）：门禁会像判定其线程上的任何消息一样判定它，其候选中带有原因，
   * 因此不会先出现重新排队通知。工单保留其订阅，且每个触发器只交还一次。
   * @returns 是否已排队：另一个工单仍决定它、或工单未曾决定它时为 false。
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    const ticket = this.require(ticketId)
    if (!ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === triggerId)) throw new UserError('notReached')
    if (this.repo.triggers.disposition(triggerId)?.handbacks?.some(item => item.ticketId === ticketId)) throw new UserError('handedBack')
    return this.handBack(ticketId, this.repo.triggers.get(triggerId)!, reason)
  }
  /**
   * 把人已忽略的 `unavailable` 决策标记为已忽略，使概览不再列出它。
   * @throws 当决策未知或不是 `unavailable` 时抛出 UserError。
   */
  dismiss(decisionId: string): Decision {
    const decision = this.repo.decisions.get(decisionId)
    if (decision?.kind !== 'unavailable') throw new UserError('unknownProblem')
    decision.dismissed = true
    this.repo.decisions.save(decision)
    return decision
  }
  /** 把一个已被手动路由的触发器从其线程队列中取出。 */
  withdraw(trigger: Trigger): void {
    const thread = this.repo.threads.get(threadKey(trigger.threads[0]!))
    if (!thread?.pending.includes(trigger.id)) return
    thread.pending = thread.pending.filter(id => id !== trigger.id)
    this.repo.threads.save(thread)
  }
  /**
   * 结束持有被路由到某工单的触发器的那次评估，因为工单现在拥有它：若该评估还持有其他触发器，
   * 则在不含它的情况下把它们重新排队等待新的评估。
   */
  routed(triggerId: string, ticketId: string): void {
    const held = this.holding(triggerId)
    const reason: Reason = { code: 'routed', values: { ticket: ticketId } }
    if (held?.evaluating?.triggerIds.length === 1) this.finish(held, held.evaluating, { kind: 'ignore', reason: [reason] })
    else if (held) this.reassess(held, { ...reason, triggerId }, [triggerId])
  }
  /** 在新版策略下重新开始进行中的评估，并通知策略已变化。 */
  policyChanged(from: string, to: string): void {
    for (const thread of this.repo.threads.active()) if (thread.evaluating) this.reassess(thread, { code: 'policyChanged' })
    this.emit('policy.changed', { from, to })
  }
  /** 以 `reason` 把线程的评估记为 unavailable 结束，并把除 `without` 外的触发器插到其他触发器之前排队等待新评估。 */
  private reassess(thread: Thread, reason: Reason, without: string[] = []): Decision {
    const ids = thread.evaluating!.triggerIds.filter(id => !without.includes(id))
    const decision = this.finish(thread, thread.evaluating!, { kind: 'unavailable', reason: [reason] })
    const current = this.repo.threads.get(thread.key)!
    current.pending = [...ids, ...current.pending.filter(id => !ids.includes(id))]
    this.repo.threads.save(current)
    return decision
  }
  /** 其评估持有某个触发器的线程：评估在其持有的每个触发器的主线程上运行。 */
  private holding(triggerId: string): Thread | undefined {
    const trigger = this.repo.triggers.get(triggerId)
    const thread = trigger && this.repo.threads.get(threadKey(trigger.threads[0]!))
    return thread?.evaluating?.triggerIds.includes(triggerId) ? thread : undefined
  }
  private candidateOf(thread: Thread): Candidate {
    const evaluation = thread.evaluating!
    const triggers = evaluation.triggerIds.flatMap(id => { const trigger = this.repo.triggers.get(id); return trigger ? [trigger] : [] })
    const { id: evalId, strength, policyVersion } = evaluation
    return { evalId, thread, triggers, strength, policyVersion, tickets: this.ticketsOnThread(thread) }
  }
  /**
   * 记录线程上排队的触发器 `ids` 未启动任何评估，原因为 `reason`，并把它们移出队列。
   * 其 id 与评估的 id 不同，因此永远不会替换同一批触发器先前评估的决策。
   */
  private ignore(thread: Thread, ids: string[], reason: Reason[], policy: Policy, at: string): void {
    const evaluation = { id: key('eval', thread.key, 'ignored', policy.version, at, ...ids), threadKey: thread.key, triggerIds: ids, strength: 'inferred' as const,
      actor: { source: thread.ref.source, id: '' }, basis: { via: 'followup' as const }, policyVersion: policy.version, startedAt: at, deadline: at }
    this.record(thread, evaluation, { kind: 'ignore', reason })
    thread.pending = thread.pending.filter(id => !ids.includes(id))
    delete thread.expired
  }
  /**
   * 主线程为 `threadKey` 的那些触发器的接受决策，按触发器索引：每个决策各启动了哪个工单。
   * 评估及其决策在其触发器的主线程上运行，因此按索引读取该线程的决策即可得到全部结果。
   */
  private accepted(threadKey: string): Map<string, Decision> {
    const accepted = new Map<string, Decision>()
    for (const decision of this.repo.decisions.byThread(threadKey)) {
      if (decision.kind !== 'accept' || !decision.ticketId) continue
      for (const id of decision.triggerIds) if (!accepted.has(id)) accepted.set(id, decision)
    }
    return accepted
  }
  /**
   * 对单个触发器只做门禁判定的评估，用于没有排队评估时作出的结果，例如针对到达某工单的后续消息。
   * 它会立即判定，与其线程可能进行中的评估并存，并把该触发器移出队列。
   * 其 id 中包含结果的类型，因此同一时刻对同一条消息的停止和接受会形成两个决策。
   */
  private directEval(thread: Thread, trigger: Trigger, kind: AssessmentOutcome['kind'], ticketId?: string): Evaluation {
    const policy = this.policy()
    const gate = policy.gate(trigger, thread, this.ticketsOnThread(thread))
    if (!gate.admissible) throw new UserError('notAdmissible', { reason: gate.reason })
    const at = this.now()
    if (thread.pending.includes(trigger.id)) { thread.pending = thread.pending.filter(id => id !== trigger.id); this.repo.threads.save(thread) }
    const id = key('eval', thread.key, 'direct', trigger.id, kind, ...ticketId ? [ticketId] : [], at)
    return { id, threadKey: thread.key, triggerIds: [trigger.id], primary: trigger.id,
      strength: gate.strength, actor: trigger.actor, basis: gate.basis, policyVersion: policy.version, startedAt: at, deadline: at }
  }
  /** 把结果应用到线程的评估上：进行中的那个，或仅做门禁判定的那个。 */
  private decideEval(thread: Thread, evaluation: Evaluation, outcome: AssessmentOutcome): Decision {
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    // 若策略变化没有触发 policyChanged 调用（如跨升级或重启），则重新排队。
    if (this.policy().version !== evaluation.policyVersion) {
      if (thread.evaluating?.id === evaluation.id) return this.reassess(thread, { code: 'policyChanged' })
      return this.finish(thread, evaluation, { kind: 'unavailable', reason: [{ code: 'policyChanged' }], ...audit })
    }
    // 从卡片上忽略且未经评估的推断候选，会在给定原因之外注明这一点。
    const unassessed = outcome.kind === 'ignore' && evaluation.strength !== 'explicit' && !outcome.audit ? [{ code: 'ignoredFromCard' }] : []
    if (outcome.kind === 'ignore' || outcome.kind === 'unavailable') return this.finish(thread, evaluation, { kind: outcome.kind,
      reason: [...unassessed, ...reasonOf(outcome.reason)], ...audit })
    if (outcome.kind === 'stop') {
      const ticket = this.repo.tickets.get(outcome.ticketId)
      if (!ticket || !liveTicket(ticket)) return this.finish(thread, evaluation, { kind: 'ignore', reason: [{ code: 'stopUnknown' }],
        ...audit })
      if (evaluation.strength !== 'explicit') return this.finish(thread, evaluation, { kind: 'ignore',
        reason: [{ code: 'stopNotExplicit' }], ...audit })
      const decision = this.finish(thread, evaluation, { kind: 'stop', reason: reasonOf(outcome.reason), ticketId: ticket.id, ...audit })
      this.tickets.end(ticket.id, 'human', 'stopped', this.now(), typeof outcome.reason === 'string' ? outcome.reason : undefined)
      return decision
    }
    return this.accept(thread, evaluation, outcome)
  }
  /** 以该评估给出的授权记录一次接受，并由 Tickets 创建其工单。 */
  private accept(thread: Thread, evaluation: Evaluation, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Decision {
    const at = this.now()
    const basis = { ...evaluation.basis, ...(outcome.rules ? { rules: outcome.rules } : {}) }
    const { strength, policyVersion, actor } = evaluation
    const mandate: Mandate = { strength, policyVersion, basis, actor, scope: outcome.scope }
    const ticketId = key('ticket', evaluation.id)
    const audit = outcome.audit ? { audit: outcome.audit } : {}
    const decision = this.finish(thread, evaluation, { kind: 'accept', reason: reasonOf(outcome.reason), ...audit, mandate, ticketId })
    this.tickets.create(ticketId, decision.id, mandate, evaluation, outcome, at)
    return decision
  }
  /** 记录评估的决策；线程自身的评估随之结束，而仅做门禁判定的评估不影响线程上进行中的评估。 */
  private finish(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const decision = this.record(thread, evaluation, outcome)
    // 直接（仅门禁）评估不会清除线程上进行中的评估。
    if (thread.evaluating?.id !== evaluation.id) return decision
    delete thread.evaluating; delete thread.expired
    this.repo.threads.save(thread)
    this.options.assessor.release?.(evaluation.id)
    return decision
  }
  private record(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const at = this.now()
    const decision: Decision = { id: key('decision', evaluation.id), evalId: evaluation.id, threadKey: thread.key, triggerIds: evaluation.triggerIds,
      policyVersion: evaluation.policyVersion, at, kind: outcome.kind, reason: outcome.reason, strength: evaluation.strength,
      ...(outcome.ticketId ? { ticketId: outcome.ticketId } : {}), ...(outcome.mandate ? { mandate: outcome.mandate } : {}), ...(outcome.audit ? { audit: outcome.audit } : {}) }
    this.repo.decisions.save(decision)
    for (const id of evaluation.triggerIds) {
      const disposition = this.repo.triggers.disposition(id) ?? { fanout: [], at }
      this.repo.triggers.saveDisposition(id, { ...disposition, evalId: evaluation.id, decisionId: decision.id })
    }
    this.emit('decision.recorded', { decisionId: decision.id, kind: decision.kind, threadKey: thread.key })
    return decision
  }
}
