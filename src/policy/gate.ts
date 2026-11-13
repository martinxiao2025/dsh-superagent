/**
 * 策略门禁与影响：构建活动策略以 gate 进入的触发器并重新校验既有工单的授权，
 * 计算设置变更对每个未结束工单的授权或匹配规则的影响，以及授权版本哈希。
 * 从 policy.ts 拆出的独立层；设置 schema 见 settings/schema.ts。
 */
import { z } from 'zod'
import { key, type ActorRef, type GateResult, type Mandate, type Policy, type PolicyEffect, type SourceScope, type Thread, type Ticket,
  type Trigger } from '../core/index.ts'
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell } from '../admission.ts'
import { sameName } from '../infra/text.ts'
import { AllowedSchema, RuleSchema, type Rule, type Settings } from '../settings/schema.ts'

export const POLICY_REVISION = 'mandate-v3'
/**
 * 为影响工作授权的设置计算版本哈希。
 * 模型、并发数、暂停状态或轮询间隔的变化不会使已有决策失效。
 */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources }))
}
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** 在该来源的 `bots` 策略列表中查找 `actor`（由该来源的类型校验），其消息至多按推断候选受理。 */
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const bots = z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** 检查线程是否有自己的工单（不包括仅上下文的订阅）。 */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** 规则是否发生变化：两侧经 `RuleSchema` 规范化后比较，键序不再敏感；旧设置缺失该规则视为变更。 */
const ruleChanged = (was: Rule | undefined, is: Rule): boolean =>
  was === undefined || JSON.stringify(RuleSchema.parse(was)) !== JSON.stringify(RuleSchema.parse(is))

/** 计算设置从 `old` 变为 `now` 时，对每个未结束工单的授权或匹配规则的影响。 */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return ruleChanged(was, is) ? [{ id, name: is.name, change: 'changed', instruction: is.instruction }] : []
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // 使用先前的受理模式和规则时，除非发送者或接收范围失去授权，否则授权仍然有效。
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** 构建活动策略，用于门禁进入的触发器并重新校验既有工单的授权。 */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  /** 门禁非人工触发器：只有列表内的机器人（作为推断候选）和无发送者的系统/CI 事件可以通过；其他机器人被拒绝。 */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    gate(trigger: Trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // 只有当来源观察到该范围内的全部消息时，未点名消息才使用受理表。
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // 先检查显式受理单元，再检查线程跟进，使线程中的工单永远不会把显式请求弱化为跟进。
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // 私聊线程只属于一个发送者（其他人不构成跟进），而推断的跟进要求受理模式不是 off（为 off 时由受理表决定）。
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate) {
      // 重新校验规则遵循 docs/002（Eval 路径；Resume 会重新校验）。
      const { basis } = mandate
      // 项目调度的授权：项目仍启用并带有任务时有效；仓库与来源已随项目保存。
      if (basis.via === 'scheduled') {
        const project = settings.projects[basis.project]
        return !!project?.enabled && !!basis.task
      }
      const { source } = basis
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
      // 显式跟进保持有效；推断的跟进要求 auto 模式且匹配的规则仍启用。
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // 机器人的候选只有在机器人仍位于其来源的机器人列表中，并通过下面的观察检查时才有效。
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // 受理表授权只有在发送者当前单元仍授予不低于原有强度的级别时才有效。
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!allowedSender(settings, mandate.actor)
        // 点名智能体的名单内发送者始终是显式的，不使用受理表单元。
        if (cell === 'unlistedAddressed' && listed) return true
        // 受理后被加入允许名单的发送者会移到名单内单元，并且仍要通过下面的观察检查。
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
      // 观察/推断出的授权只有在 auto 模式生效且所有匹配规则仍启用时才有效。
      if ((basis.via === 'admission' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
  }
}
