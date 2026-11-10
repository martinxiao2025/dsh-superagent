/**
 * 在单个事务中将模式 10 的数据库迁移到模式 11，使运行时读取方无需转换旧结构。
 * 早于模式 10 的数据库会被拒绝：此版本无法迁移它们。
 */
import { basename } from 'node:path'
import { z } from 'zod'
import { isoTime, said, type AcceptMode, type AdmissionCell, type ChannelRef, type Decision, type Execution, type Follow, type MandateBasis,
  type Reason, type Thread, type Ticket, type TicketInput, type TriggerDisposition } from '../core/index.ts'
import { feishuChatLink } from '../sources/feishu-channel.ts'
import { POLL_HORIZON_MS } from '../sources/poll.ts'
import { SettingsSchema, policyVersion, type SettingsOrigin } from '../policy.ts'
import { autoMergeThreshold, teamDefaults } from './context.ts'
import { PromptConfigSchema, type PromptConfig, type PromptVersion } from './prompts.ts'
import type { EffectKind, EffectPayloads } from './effects.ts'
import { promptsNotice, settingsNotice, subscriptionNotice } from './notices.ts'
import type { SettingsVersion, Store } from './store.ts'
import { Versions } from './versions.ts'
import { KV, record, type Key } from '../kv.ts'

export const SCHEMA_VERSION = 11
/** 此构建可直接打开并迁移的最旧数据库模式版本。 */
export const OLDEST_SCHEMA = 10
/** 返回说明为何无法打开 `version` 的错误消息：更旧的模式需要新的状态目录。 */
export const tooOld = (version: number): string =>
  `Orchestrator database schema ${version} predates schema ${OLDEST_SCHEMA}, which this version cannot migrate; start with a new state directory`

type Stored = Record<string, unknown>
const isObject = (value: unknown): value is Stored => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

/** 运行单个迁移步骤，并为抛出的错误加上失败记录的名称前缀。 */
function step<T>(record: string, work: () => T): T {
  try { return work() } catch (error) { throw new Error(`${record}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
}
/** 就地重写所有模式 10 记录为模式 11 结构。 */
export function migrateTo11(store: Store): void {
  step('the prompt versions', () => { migratePrompts(store) })
  const answers = new Map<string, string[]>()
  for (const name of store.keys('answer-ready:')) {
    const [, ticketId, triggerId] = name.split(':')
    if (store.get(name) === true && ticketId && triggerId) answers.set(ticketId, [...answers.get(ticketId) ?? [], triggerId])
  }
  const human = (triggerId: string) => store.triggers.get(triggerId)?.human === true
  const closed = (number: number) => pullEnd(store.get<unknown>(`github-ended:${number}`))
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    step(`ticket ${String(row.id)}`, () => { store.tickets.save(ticketOf(JSON.parse(String(row.value)) as Stored, answers, human, closed)) })
  }
  for (const row of store.db.prepare("SELECT id, value FROM decision WHERE json_type(value, '$.mandate') = 'object'").all()) {
    step(`decision ${String(row.id)}`, () => {
      const decision = JSON.parse(String(row.value)) as Decision
      store.decisions.save({ ...decision, mandate: { ...decision.mandate!, basis: basisOf(decision.mandate!.basis as unknown) } })
    })
  }
  for (const thread of store.threads.list()) {
    const evaluating = thread.evaluating
    if (evaluating) step(`thread ${thread.key}`, () => { store.threads.save({ ...thread, evaluating: { ...evaluating, basis: basisOf(evaluating.basis as unknown) } }) })
  }
  step('the Threads\' activity times', () => { backfillThreadTimes(store) })
  // 执行器可读的输入键现在以 `ticket/` 为前缀而非 `task/`；保留任何已写入 `ticket/` 下的键。
  for (const name of store.keys('task/')) {
    const renamed = `ticket/${name.slice('task/'.length)}`
    if (store.get(renamed) === undefined) store.set(renamed, store.get(name))
    store.delete(name)
  }
  for (const name of DEAD_KEYS.flatMap(prefix => prefix.endsWith(':') ? store.keys(prefix) : [prefix])) store.delete(name)
  // 来源读取分页、提示词预览和飞书消息链接现在缓存在内存中，而不再存于 SQLite。
  store.db.exec(`DELETE FROM kv WHERE key LIKE 'feishu-read:%' OR key LIKE 'github-read:%' OR key LIKE 'feishu-source-link:%'
    OR key LIKE '%:prompt-preview/%'`)
  queueEarlierWork(store)
  // 将丢弃消息的文字原因转换为面板本地化的原因代码。
  store.db.exec(`UPDATE outbox SET value = json_set(value, '$.dropped.reason', CASE value ->> '$.dropped.reason'
    WHEN 'The conversation can no longer receive messages' THEN 'channelGone'
    WHEN 'The Source no longer listens to this conversation' THEN 'channelIgnored'
    ELSE value ->> '$.dropped.reason' END) WHERE value -> '$.dropped' IS NOT NULL`)
  step('the outbox', () => { outboxReceipts(store) })
  step('the current settings', () => { settingsAsVersions(store) })
  // 会话在 `KV.sessions.prompts`（`session-prompts:`）中持久记录每个会话运行过的提示词修订，用于授权读取；删除旧的 `prompt-version-read:` 标记。
  store.db.exec("DELETE FROM kv WHERE key LIKE 'prompt-version-read:%'")
  // 模式 6 的表保留在原位：模式 7 导入了它们，但并未导入每一行。
  step('the Sources\' records', () => { migrateSourceRecords(store) })
  // 执行器会话现在直接从工单记录渲染输入，因此独立的输入正文键已过时。
  step('the Inputs\' bodies', () => { store.db.exec("DELETE FROM kv WHERE key LIKE 'ticket/%/input/%'") })
  step('the pull request ends', () => { dropPullEnds(store) })
  step('the dismissed problems', () => { moveDismissals(store) })
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    step(`ticket ${String(row.id)}`, () => { store.tickets.save(withoutCopies(JSON.parse(String(row.value)) as Stored)) })
  }
  step('the reasons', () => { reasonsAsCodes(store) })
  step('the Triggers\' times', () => { triggerTimes(store) })
}
/**
 * 将触发器和线程时间戳规范化为固定宽度的毫秒 ISO 字符串，使字典序文本顺序与
 * 时间顺序一致（GitHub 曾写入整秒如 `…:00Z`，其排序在 `…:00.001Z` 之后）。
 */
function triggerTimes(store: Store): void {
  for (const row of store.db.prepare('SELECT id, at FROM trigger').all()) {
    const at = isoTime(String(row.at))
    if (at !== row.at) store.db.prepare("UPDATE trigger SET at = ?, value = json_set(value, '$.at', ?) WHERE id = ?").run(at, at, String(row.id))
  }
  store.db.exec(`UPDATE trigger_thread SET at = (SELECT at FROM trigger WHERE trigger.id = trigger_thread.id)
    WHERE at <> (SELECT at FROM trigger WHERE trigger.id = trigger_thread.id)`)
  for (const thread of store.threads.list()) {
    const createdAt = isoTime(thread.createdAt), lastAt = thread.lastAt === undefined ? undefined : isoTime(thread.lastAt)
    if (createdAt === thread.createdAt && lastAt === thread.lastAt) continue
    store.threads.save({ ...thread, createdAt, ...lastAt === undefined ? {} : { lastAt } })
  }
}
/**
 * 来自已移除的 `github-issue` 资格检查、早期迁移以及
 * 模式 11 之前的维护和订阅跟踪的过时 KV 键和前缀（以 `:` 结尾）。
 */
const DEAD_KEYS = ['github-object-state:', 'github-issue-eligibility:', 'github-auto-merge:',
  'source-labels-at:', 'legacy-migrated-at', 'thread-times-backfilled', 'settings-before-9', 'answer-ready:', 'prompt-sections', 'prompt-settings-text',
  'prompt-vocabulary', 'subscriptions', 'subscriptions-initialized', 'subscription-seen:', 'subscription-initialized:', 'subscription-since:',
  'observation-since:', 'task-threads:', 'maintenance-recovery:', 'maintenance-progress-report-recovery:', 'maintenance-thread-followup:',
  'master-recovery:', 'github-issue-candidates']

/**
 * 按顺序将旧版主会话队列移入统一的副作用队列（先引导转发，再是已移除订阅、已保存提示词
 * 和已保存设置的通知），然后删除旧键。
 */
function queueEarlierWork(store: Store): void {
  const queue = effectQueue(store)
  const { relays, unsubscribed, prompts, settings } = KV.queues
  for (const { id, text } of store.get(relays) ?? []) queue('relay', id, { text })
  const prompt = store.get(prompts), saved = store.get(settings)
  const notices = [...(store.get(unsubscribed) ?? []).map(thread => subscriptionNotice(thread)),
    ...prompt == null ? [] : [promptsNotice(prompt)], ...saved == null ? [] : [settingsNotice()]]
  for (const [name, value, summary] of notices) queue('notice', name, { value, summary })
  for (const name of [relays, unsubscribed, prompts, settings]) store.delete(name)
}

/**
 * 在迁移期间、`Effects` 尚不存在时直接向数据库插入副作用，保留此前的失败计数；
 * 与 `Effects.enqueue`（upsert 载荷、递增 generation 并重置 attempts）不同，`INSERT OR IGNORE` 不会改动该 `kind` 和 `key` 已排队的行。
 */
function effectQueue(store: Store) {
  let seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  return <K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K], failed = { attempts: 0, error: '' }) =>
    store.db.prepare('INSERT OR IGNORE INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(kind, key, JSON.stringify(payload), ++seq, failed.attempts, failed.error, Date.now(), new Date().toISOString())
}
/**
 * 将发件箱行转换为状态回执（`pending`、`sent` 或 `dropped`），并按行顺序把待处理消息入队为 `reply`
 * 副作用，将其先前的 `attempts` 和 `error` 移到副作用上。
 */
function outboxReceipts(store: Store): void {
  const columns = store.db.prepare("SELECT name FROM pragma_table_xinfo('outbox')").all().map(row => String(row.name))
  if (!columns.includes('sent')) return
  const queue = effectQueue(store)
  for (const row of store.db.prepare('SELECT id, value, sent FROM outbox ORDER BY rowid').all()) {
    const { attempts, error, nextAttemptAt: _next, ...message } = JSON.parse(String(row.value)) as Stored
    const status = message.dropped ? 'dropped' : row.sent ? 'sent' : 'pending'
    store.db.prepare('UPDATE outbox SET value = ? WHERE id = ?').run(JSON.stringify({ ...message, status }), String(row.id))
    if (status === 'pending') queue('reply', String(row.id), {}, { attempts: Number(attempts ?? 0) || 0, error: typeof error === 'string' ? error : '' })
  }
  store.db.exec('DROP INDEX IF EXISTS outbox_waiting; ALTER TABLE outbox DROP COLUMN sent')
}

/**
 * 确保最新的设置修订快照持有当前设置（若缺失或早期迁移步骤剥离了已移除的来源，则保存新修订），
 * 然后删除独立的 `settings` 键。
 */
function settingsAsVersions(store: Store): void {
  const current = store.get<unknown>('settings')
  if (current === undefined) return
  const versions = new Versions<SettingsVersion>(store, KV.settings.revision, KV.settings.version)
  const newest = Math.max(versions.revision(), ...versions.list().map(version => version.revision))
  if (newest) store.set(KV.settings.revision, newest)
  if (JSON.stringify(versions.current()?.settings) !== JSON.stringify(current)) {
    const settings = SettingsSchema.parse(current)
    versions.save(revision => ({ revision, savedAt: new Date().toISOString(), source: 'internal', policyVersion: policyVersion(settings),
      policyChanged: false, notified: [], settings }))
  }
  store.delete('settings')
}

interface Member { name?: string; feishuId?: string; github?: string }
/** 团队部分出现之前保存的提示词配置结构，当时所有部分（包括固定部分）都可编辑。 */
const LegacyPromptConfigSchema = z.object({ shared: z.string(), orchestrator: z.string(), worker: z.string(), guides: z.record(z.string(), z.string()) })
/** 旧版提示词配置中的引导名称，它们现在是固定的内置提示词部分或技能。 */
const LEGACY_FIXED = new Set(['cli', 'subscriptions', 'replies', 'reviews', 'dispatch', 'work', 'feishu', 'github'])
/** 领域词汇重命名之前已保存提示词中使用的工具名，及其现在对应的替代项。 */
const RENAMED_TOOLS: readonly (readonly [string, string])[] = [
  ['orchestrator_subscription_remove', 'orchestrator_thread_unsubscribe'], ['orchestrator_subscriptions', 'orchestrator_threads'],
  ['orchestrator_create_task', 'orchestrator_route (kind accept)'], ['orchestrator_send_task', 'orchestrator_route (kind attach)'],
  ['orchestrator_reopen_task', 'orchestrator_route (kind attach)'], ['orchestrator_ticket_reopen', 'orchestrator_route (kind attach)'],
  ['orchestrator_stop_task', 'orchestrator_route (kind stop)'], ['orchestrator_ignore_event', 'orchestrator_route (kind ignore)'],
  ['orchestrator_request_status', 'orchestrator_ticket_request_status'], ['orchestrator_inspect_task', 'orchestrator_ticket_inspect'],
  ['orchestrator_observations', 'orchestrator_decisions'], ['orchestrator_event_replay', 'orchestrator_trigger_requeue'],
  ['orchestrator_tasks', 'orchestrator_tickets'], ['orchestrator_assess', 'orchestrator_eval'], ['admission_read', 'orchestrator_eval_read'],
  ['admission_decide', 'orchestrator_eval_decide'],
]
/** 被 `orchestrator_read <resource>` 取代的只读工具，映射到其资源路径。 */
const READ_TOOLS: Readonly<Record<string, string>> = { orchestrator_tickets: 'tickets', orchestrator_threads: 'threads', orchestrator_decisions: 'decisions',
  orchestrator_settings_read: 'settings', orchestrator_prompts_read: 'prompts', orchestrator_models: 'models', orchestrator_ticket_inspect: 'ticket/<id>' }
/**
 * 重写技能和变量中来自项目早期名称的前缀（`dsh-tag`、`dsh-go`、`dsh-freelancer`），用 `orchestrator_read`
 * 替换已弃用的读取工具，并用 `orchestrator_route` 及其类型替换四个路由工具。
 */
const currentNames = (value: string): string => value.replace(/\bdsh-(?:tag|go|freelancer)-/g, 'dsh-superagent-').replace(/\bDSH_(?:TAG|GO|FREELANCER)_/g, 'DSH_SUPERAGENT_')
  .replace(/\borchestrator_(?:tickets|threads|decisions|settings_read|prompts_read|models|ticket_inspect)\b/g, name => `orchestrator_read ${READ_TOOLS[name]}`)
  .replace(/\borchestrator_(?:ticket_(accept|attach|stop)|trigger_(ignore))\b/g, (_name, ticket?: string, trigger?: string) =>
    `orchestrator_route (kind ${ticket ?? trigger ?? ''})`)
/** 将旧版技能正文重写为当前的工具、参数、资源、部分、技能和变量名称。 */
function legacyText(value: string): string {
  let result = value
  for (const [from, to] of RENAMED_TOOLS) result = result.replace(new RegExp(`\\b${from}\\b`, 'g'), to)
  return currentNames(result.replaceAll('reply_to_event_id', 'reply_to_trigger_id').replace(/\bevent_id\b/g, 'trigger_id').replace(/\btask_id\b/g, 'ticket_id')
    .replaceAll('related_tasks', 'related_tickets').replace(/(?<![\w/-])event\//g, 'trigger/').replace(/(?<![\w/-])task\//g, 'ticket/').replaceAll('<event-id>', '<trigger-id>')
    .replace(/\bguide\/([a-z][a-z0-9-]*)\b/g, (_match, name: string) => LEGACY_FIXED.has(name) ? `the ${name} section` : `skill dsh-superagent-${name}`))
}
/**
 * 将存储的提示词配置升级为当前部分、工具名称和技能引用；旧版配置采用
 * 内置团队部分，把自定义引导保留为技能，并把任何自动合并行阈值带入 `delivery`。
 */
function normalize(config: unknown): PromptConfig {
  const legacy = LegacyPromptConfigSchema.safeParse(config)
  const limit = legacy.success ? /fewer than (\d+) lines \(additions plus deletions\)/.exec(legacy.data.guides.work ?? '')?.[1] : undefined
  const current = legacy.success ? { ...teamDefaults, delivery: limit ? teamDefaults.delivery.replace(autoMergeThreshold(200), autoMergeThreshold(Number(limit))) : teamDefaults.delivery,
    skills: Object.fromEntries(Object.entries(legacy.data.guides).filter(([name]) => !LEGACY_FIXED.has(name)).map(([name, body]) => [name, legacyText(body)])) }
    : PromptConfigSchema.parse(config)
  return { communication: currentNames(current.communication), scope: currentNames(current.scope), delivery: currentNames(current.delivery),
    skills: Object.fromEntries(Object.entries(current.skills).map(([name, body]) => [name, currentNames(body)])) }
}
/**
 * 将存储的提示词修订规范化为当前部分和名称（对在团队部分出现之前保存或无法解析的配置，在 `legacy` 下记录原始配置），
 * 并为已移除的设置字段（自动合并阈值和跨来源成员身份）合成新修订，
 * 除非更早的迁移已创建它。
 */
function migratePrompts(store: Store): void {
  // 在旧版或无法解析的修订上保留原始配置，回退到最后一个可读配置，使会话始终拥有有效提示词。
  const versions = store.keys('prompt-version:').map(name => store.get<PromptVersion & { config: unknown }>(name)!).sort((a, b) => a.revision - b.revision)
  let readable: PromptConfig = { ...teamDefaults, skills: {} }
  for (const version of versions) {
    const legacy = LegacyPromptConfigSchema.safeParse(version.config).success
    let config: PromptConfig
    try { config = normalize(version.config) } catch { config = readable }
    const kept = legacy || config === readable ? { legacy: version.legacy ?? { config: version.config } } : {}
    store.set(`prompt-version:${version.revision}`, { ...version, config, ...kept })
    readable = config
  }
  if (store.get('prompt-settings-text') === 1) return
  const before = store.get<unknown>('settings-before-9')
  const policy = (isObject(before) ? before.policy : undefined) as { autoMergeLineLimit?: unknown; members?: unknown } | undefined
  const limit = typeof policy?.autoMergeLineLimit === 'number' ? policy.autoMergeLineLimit : 200
  const mapped = ((Array.isArray(policy?.members) ? policy.members : []) as Member[]).filter(person => person.feishuId && person.github)
  const revision = store.get<number>('prompt-revision')
  const current = revision === undefined ? undefined : store.get<PromptVersion>(`prompt-version:${revision}`)
  const config = current?.config ?? { ...teamDefaults, skills: {} }
  const delivery = config.delivery.includes(autoMergeThreshold(200)) ? config.delivery.replace(autoMergeThreshold(200), autoMergeThreshold(limit))
    : limit === 200 ? config.delivery : `${config.delivery}\nEnable auto-merge only on a PR that changes fewer than ${limit} lines (additions plus deletions).`
  const identities = mapped.length && !config.skills.identities ? { identities: ['The same colleague may use a different account on each Source. When you mention, assign or request a review from someone you met on another Source, use their account on this one:',
    ...mapped.map(person => `- ${person.name ?? person.feishuId} (Feishu ${person.feishuId}) is @${person.github} on GitHub`)].join('\n') } : {}
  const next = { ...config, delivery, skills: { ...config.skills, ...identities } }
  if (JSON.stringify(next) === JSON.stringify(config)) return
  const previous = current?.revision ?? 0
  if (!current) store.set('prompt-version:0', { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config })
  store.set(`prompt-version:${previous + 1}`, { revision: previous + 1, previousRevision: previous, savedAt: new Date().toISOString(), source: 'settings-migration', config: next })
  store.set('prompt-revision', previous + 1)
}

const CELLS: readonly string[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
/**
 * 将旧版 mandate 基础对象升级为当前带标签的联合结构。
 * 当前基础记录 `source` 和 `scope`；较旧的基础直接记录飞书会话（`chatId`）或模式 6 的 `legacyAuthority`。
 * 既无准入表单元也无 `followup` 的基础来自列出的发送者（若记录了 `addressed`、`sender` 和 `source` 则为 `addressed`，否则为 `listed`），
 * 只要发送者仍在列表中，该基础就成立。
 */
export function basisOf(stored: unknown): MandateBasis {
  // 缺失或非对象的基础默认为列出发送者基础（`via: 'listed'`）。
  const old = isObject(stored) ? stored : {}
  if (typeof old.via === 'string') return old as unknown as MandateBasis
  // 较旧的飞书基础在顶层记录 `chatId` 和 `direct`，而不是在 `scope` 内。
  const chat = text(old.chatId) ? { source: 'feishu', scope: { chatId: old.chatId, direct: old.direct === true } } : {}
  const received = text(old.source) ? { source: old.source as string, ...isObject(old.scope) ? { scope: old.scope } : {}, ...text(old.row) ? { row: old.row as string } : {} } : chat
  const sender = text(old.sender) ?? text(old.member)
  const common = { ...received, ...sender ? { sender } : {}, ...Array.isArray(old.rules) ? { rules: old.rules as string[] } : {} }
  const addressed = old.addressed === 'mention' || old.addressed === 'direct' ? old.addressed
    : old.direct === true ? 'direct' as const : old.mention === true ? 'mention' as const : undefined
  const mode = text(old.mode) as AcceptMode | undefined
  // 模式 6 的导入记录了 `legacyAuthority`。
  const authority = text(old.legacyAuthority) ? { authority: old.legacyAuthority as string } : {}
  if (old.followup === true) return { via: 'followup', ...common, ...authority }
  if (CELLS.includes(String(old.admission))) {
    return { via: 'admission', ...common, cell: old.admission as AdmissionCell, ...addressed ? { addressed } : {}, ...old.observation === true ? { observation: { mode: mode ?? 'auto' } } : {} }
  }
  if (addressed && sender && text(old.source)) return { via: 'addressed', ...common, addressed }
  // 任何既无表单元也无 `followup` 的基础都来自列出的发送者。
  return { via: 'listed', ...common, ...addressed ? { addressed } : {}, ...old.observation === true ? { observation: mode ? { mode } : {} } : {}, ...authority }
}
/**
 * 将模式 10 工单记录升级到模式 11：从 `meta` 和 GitHub 开立渠道中提取 `origin`、`execution`、`delivery`
 * 以及关注的 PR 线程（`follows`），合并已报告的 `answers`，标记人类触发器输入（`human: true`），
 * 并把待处理的 `reopen` 输入转换为供执行器使用的 `text` 输入。
 */
export function ticketOf(old: Stored, answers = new Map<string, string[]>(), human: (triggerId: string) => boolean = () => false,
  closed: (number: number) => Follow['closed'] = () => undefined): Ticket {
  const { meta: storedMeta, ...rest } = old as Stored & { meta?: Stored }
  const ticket = rest as unknown as Ticket
  const meta = storedMeta ?? {}
  const triggerId = text(meta.sourceTriggerId) ?? ''
  const triggerIds = Array.isArray(meta.triggerIds) ? meta.triggerIds as string[] : triggerId ? [triggerId] : []
  const directory = text(meta.workspace)
  // 其余 `meta` 字段已过时：模式 6 的任务状态保留在 `task` 表中，accept 字段位于 `execution` 和 `mandate` 上。
  const execution: Execution | undefined = directory ? { name: text(meta.name) ?? basename(directory), directory,
    assignment: text(meta.assignment) ?? text(meta.legacyPrompt) ?? '' } : undefined
  const inputs = ticket.inputs.map((input): TicketInput => input.kind === 'trigger' ? { ...input, ...human(input.triggerId) ? { human: true } : {} }
    : input.kind !== 'reopen' || !ticket.undelivered.includes(input.id) ? input
    : { id: input.id, kind: 'text', at: input.at, text: JSON.stringify({ resumed: true, decision_id: input.decisionId, read: `ticket/${ticket.id}/assignment`,
      note: 'This ticket ended earlier and a follow-up resumed it under the same mandate. Inspect the worktree, git history and PR state before continuing; do not repeat completed external operations.' }) })
  const reported = [...new Set([...ticket.answers ?? [], ...answers.get(ticket.id) ?? []])]
  const ended = ticket.ended && { ...ticket.ended, outcome: ticket.ended.outcome ?? outcomeOf(ticket.ended) }
  const mandate = { ...ticket.mandate, basis: basisOf(ticket.mandate.basis as unknown) }
  const delivery = ticket.delivery ?? (text(meta.deliveryError) ? { error: meta.deliveryError as string, at: ticket.updatedAt } : undefined)
  const kept = execution ?? ticket.execution
  const follows = ticket.follows ?? followsOf(meta, ticket.channels, closed)
  return { ...ticket, inputs, ...ended ? { ended } : {}, mandate, origin: ticket.origin ?? { triggerId, triggerIds },
    // 被人停止的工单不会获得更多工作，因此清除任何未投递的输入。
    ...ended?.by === 'human' ? { undelivered: [] } : {},
    ...kept ? { execution: kept } : {}, ...delivery ? { delivery } : {},
    channels: ticket.channels.filter(channel => !opener(channel)), ...follows.length ? { follows } : {},
    ...reported.length ? { answers: reported } : {} }
}
/** 模式 10 将工单打开的 PR 记录为不带评论 URL（`address.url`）的 GitHub 渠道。 */
const opener = (channel: ChannelRef): boolean => channel.source === 'github' && !channel.address.url && !!Number(channel.address.number)
/**
 * 从旧版工单元数据（`meta.prNumber` 最后，在通过 GitHub 开立渠道打开的 PR 之后）重建关注的 PR 线程，
 * 把已打开的 PR 标记为 `own: true`，并附加已记录的关闭结果。
 */
function followsOf(meta: Stored, channels: ChannelRef[], closed: (number: number) => Follow['closed']): Follow[] {
  const opened = channels.filter(opener).map(channel => Number(channel.address.number))
  const bound = typeof meta.prNumber === 'number' ? [meta.prNumber] : []
  return [...new Set([...opened.filter(number => !bound.includes(number)), ...bound])].map(number => {
    const end = closed(number)
    return { thread: `github:${number}`, own: opened.includes(number), ...end ? { closed: end } : {} }
  })
}
/** 将模式 10 的 `github-ended:<number>` 记录解析为关注 PR 的 `closed` 状态（若有效）。 */
function pullEnd(stored: unknown): Follow['closed'] {
  if (!isObject(stored) || typeof stored.at !== 'string' || (stored.reason !== 'merged' && stored.reason !== 'closed')) return undefined
  return { at: stored.at, outcome: stored.reason }
}
/**
 * 剥离旧版工单上重复存储的冗余字段：移除 `state`（由 `ended` 派生），在没有分配包含报告时把顶层 `summary`
 * 移到最新分配上作为 `progress` 报告，并移除 `execution.session` 以及
 * 各分配的 `ticketId` 和 `ref`（由 `ticket.id` 派生）。
 */
export function withoutCopies(old: Stored): Ticket {
  const { state, summary, ...ticket } = old as Stored & Ticket & { state?: string; summary?: unknown }
  const assignments = ticket.assignments.map(item => {
    const { ticketId: _ticket, ref: _ref, ...rest } = item as typeof item & { ticketId?: string; ref?: string }
    return rest
  })
  const latest = assignments.at(-1)
  if (latest && typeof summary === 'string' && summary && !assignments.some(item => item.report)) {
    latest.report = { state: 'progress', summary, at: ticket.updatedAt }
  }
  const { session: _session, ...execution } = (ticket.execution ?? {}) as Partial<Execution> & { session?: string }
  // 未结束的工单没有 `ended` 记录；标记为 `ended` 但无记录的工单默认为 `closed`。
  const closed = { at: ticket.updatedAt, by: 'executor' as const, reason: 'closed', outcome: 'closed' as const }
  const ended = state === 'open' ? undefined : ticket.ended ?? (state === 'ended' ? closed : undefined)
  const { ended: _ended, ...rest } = ticket
  // 仅当 `ended.reason` 不同于 `ended.outcome` 时保留它，并从被该结束终止的分配中删除重复的结束原因。
  const { reason, ...end } = ended ?? {} as NonNullable<Ticket['ended']>
  const once = ended && { ...end, ...reason && reason !== ended.outcome ? { reason } : {} } as NonNullable<Ticket['ended']>
  for (const item of assignments) if (ended && item.endedReason === reason && item.endedAt === ended.at) delete item.endedReason
  return { ...rest, ...once ? { ended: once } : {}, assignments, ...ticket.execution ? { execution: execution as Execution } : {} }
}
/** 模式 11 之前版本写入的固定英文原因句子，映射到当前原因代码。 */
const SENTENCES: Readonly<Record<string, string>> = {
  'Assessment timed out': 'timeout', 'Assessment interrupted or timed out': 'timeout',
  'Assessment interrupted, timed out or ended without a decision': 'timeout',
  'Policy changed during assessment': 'policyChanged', 'Access or rule version changed': 'policyChanged',
  'No admissible trigger': 'noAdmissible', 'Explicit member request routed by the orchestrator': 'explicitRouted',
  'Explicit request from an allowed sender routed by the orchestrator': 'explicitRouted',
  'Imported from the pre-domain-model task record': 'legacyImport', 'host restarted': 'hostRestarted', 'Human asked to stop': 'humanStop',
  'Forwarded to the existing topic worker': 'forwarded', 'Sender is not an authorized human member': 'senderNotMember',
  'Retried by a person': 'retried', 'Stop target is unknown or already ended': 'stopUnknown',
  'Stop requires an explicit instruction from an authorized member': 'stopNotExplicit',
  'Implementation intent or target direction is not established, or a product/design decision is still required': 'directionUnsettled',
  'No enabled admission rule matched': 'noRuleMatched',
}
/** 当旧版原因字符串匹配 `SENTENCES` 中的固定句子、参数化句子（`routed`、`startedTicket`、`observed`）或 snake_case 门/来源代码时，将其解析为 `Reason`。 */
function knownReason(text: string): Reason | undefined {
  if (SENTENCES[text]) return { code: SENTENCES[text] }
  const routed = /^Routed to ticket (\S+)$/.exec(text) ?? /^Already accepted as ticket (\S+)$/.exec(text)
  if (routed) return { code: text.startsWith('Routed') ? 'routed' : 'startedTicket', values: { ticket: routed[1]! } }
  const observed = /^Observe mode: would accept \((.*)\)$/s.exec(text)
  if (observed) return { code: 'observed', values: { text: observed[1]! } }
  return /^[a-z]+(?:_[a-z]+)+$/.test(text) ? { code: text } : undefined
}
/**
 * 将存储的决策原因解析为结构化 `Reason` 代码：把以 `; ` 连接的 `<triggerId>: <reason>` 批次
 * 拆分为各触发器原因，通过 `knownReason` 映射已知句子/代码，并用 `said` 包裹
 * 任何其他自由形式的评估器或人类文本。
 */
export function reasonsOf(stored: unknown): Reason[] {
  if (Array.isArray(stored)) return stored as Reason[]
  const text = typeof stored === 'string' ? stored : ''
  const parts = text.split('; ').map(part => /^([^:\s]+): (.+)$/s.exec(part))
  if (parts.every(match => match && knownReason(match[2]!))) return parts.map(match => ({ ...knownReason(match![2]!)!, triggerId: match![1]! }))
  return [knownReason(text) ?? said(text)]
}
/** 将存储的决策、处置和分配结束原因从自由形式字符串转换为原因代码。 */
function reasonsAsCodes(store: Store): void {
  for (const row of store.db.prepare('SELECT value FROM decision').all()) {
    const decision = JSON.parse(String(row.value)) as Decision & { reason: unknown }
    store.decisions.save({ ...decision, reason: reasonsOf(decision.reason) })
  }
  for (const row of store.db.prepare("SELECT id, value FROM disposition WHERE json_type(value, '$.filtered') = 'text'").all()) {
    const disposition = JSON.parse(String(row.value)) as TriggerDisposition & { filtered: string }
    store.triggers.saveDisposition(String(row.id), { ...disposition, filtered: { code: SENTENCES[disposition.filtered] ?? disposition.filtered } })
  }
  for (const ticket of store.tickets.list()) {
    const ended = (reason?: string) => reason && SENTENCES[reason] === 'retried' ? 'retried' : reason && SENTENCES[reason] === 'hostRestarted' ? 'hostRestarted' : reason
    if (!ticket.assignments.some(item => item.endedReason !== ended(item.endedReason))) continue
    const assignments = ticket.assignments.map(item => item.endedReason ? { ...item, endedReason: ended(item.endedReason) } : item)
    store.tickets.save({ ...ticket, assignments })
  }
}
/** 将 `problem-dismissed:<decisionId>` KV 标志移到对应的 `Decision.dismissed` 字段上，并删除这些 KV 键。 */
function moveDismissals(store: Store): void {
  for (const name of store.keys('problem-dismissed:')) {
    const decision = store.decisions.get(name.slice('problem-dismissed:'.length))
    if (decision && store.get<unknown>(name) === true) store.decisions.save({ ...decision, dismissed: true })
    store.delete(name)
  }
}
/** 在将关闭结果复制到 `Ticket.follows` 后，删除 `github-ended:<number>` KV 记录。 */
function dropPullEnds(store: Store): void {
  for (const name of store.keys('github-ended:')) store.delete(name)
}
/** 在早于已记录结果时推断工单的 `ended.outcome`（人类停止为 `stopped`，否则匹配 `reason` 或默认为 `closed`）。 */
function outcomeOf(ended: Pick<NonNullable<Ticket['ended']>, 'by' | 'reason'>): NonNullable<Ticket['ended']>['outcome'] {
  if (ended.by === 'human') return 'stopped'
  return (['completed', 'merged', 'closed', 'dropped'] as const).find(outcome => outcome === ended.reason) ?? 'closed'
}
/** 根据最早和最晚的触发器回填线程创建和活动时间戳。 */
function backfillThreadTimes(store: Store): void {
  if (store.get('thread-times-backfilled')) return
  for (const thread of store.threads.list()) {
    const first = store.read.firstTrigger(thread.key), last = store.read.threadTriggers(thread.key, 1)[0]
    if (!first || !last) continue
    const times: Pick<Thread, 'createdAt' | 'lastAt'> = { createdAt: first.at < thread.createdAt ? first.at : thread.createdAt,
      lastAt: !thread.lastAt || last.at > thread.lastAt ? last.at : thread.lastAt }
    store.threads.save({ ...thread, ...times })
  }
}

/** 将存储的来源状态（飞书话题、私聊标志、线程链接、GitHub 游标和待处理评估）升级到模式 11。 */
function migrateSourceRecords(store: Store): void {
  feishuTopics(store)
  feishuDirectAddresses(store)
  feishuThreadLinks(store)
  issueSourceRecords(store)
  githubCursors(store)
  assessmentTriggers(store)
}
/** 模式 10 的飞书键没有记录段；迁移只读写这些旧键，运行时的新键由来源按记录写入。 */
const legacyFeishuTopics = 'feishu-history-threads:'
const legacyFeishuHistory = (chat: string): Key<string> => record<string>(`feishu-history:${chat}`)
const legacyFeishuChats = (): Key<Record<string, boolean>> => record<Record<string, boolean>>('feishu-chats')
/** 将旧版飞书话题 ID 数组转换为以话题 ID 为键、包含会话最后恢复时间戳的映射。 */
function feishuTopics(store: Store): void {
  for (const name of store.keys(legacyFeishuTopics)) {
    const topics: unknown = store.get(name)
    if (!Array.isArray(topics)) continue
    const seen = store.get(legacyFeishuHistory(name.slice(legacyFeishuTopics.length))) ?? new Date().toISOString()
    store.set(name, Object.fromEntries(topics.map(id => [String(id), seen])))
  }
}
/**
 * 从旧版 `feishu-chats` 向飞书渠道地址回填 `direct: 'true'`，因为飞书 `oc_` 会话 ID
 * 自身无法区分私聊与群聊。
 */
function feishuDirectAddresses(store: Store): void {
  const chats = store.get(legacyFeishuChats()) ?? {}
  const direct = (channel: unknown): channel is ChannelRef => isObject(channel) && channel.source === 'feishu' && isObject(channel.address)
    && chats[String(channel.address.chatId)] === true && channel.address.direct === undefined
  const marked = (channel: ChannelRef): ChannelRef => direct(channel)
    ? { ...channel, address: { ...channel.address, direct: 'true' } } : channel
  for (const table of ['trigger', 'outbox'] as const) {
    for (const row of store.db.prepare(`SELECT id, value FROM ${table} WHERE value ->> '$.channel.source' = 'feishu'`).all()) {
      const value = JSON.parse(String(row.value)) as Stored
      if (!direct(value.channel)) continue
      const rewritten = JSON.stringify({ ...value, channel: marked(value.channel) })
      store.db.prepare(`UPDATE ${table} SET value = ? WHERE id = ?`).run(rewritten, row.id!)
    }
  }
  for (const row of store.db.prepare('SELECT id, value FROM ticket').all()) {
    const ticket = JSON.parse(String(row.value)) as Ticket
    if (ticket.channels.some(direct)) store.tickets.save({ ...ticket, channels: ticket.channels.map(marked) })
  }
}
/** 向在线程存储自身 URL 之前创建的飞书线程回填会话 URL，并从现有触发器 URL 推断品牌。 */
function feishuThreadLinks(store: Store): void {
  const lark = store.db.prepare(`SELECT 1 FROM trigger WHERE value ->> '$.source' = 'feishu'
    AND value ->> '$.url' LIKE '%larksuite.com%' LIMIT 1`).get()
  for (const thread of store.threads.list()) {
    if (thread.ref.source !== 'feishu' || typeof thread.meta.url === 'string' || store.read.firstTrigger(thread.key)?.url) continue
    const chatId = thread.ref.id.split(':')[0]
    if (chatId) store.threads.save({ ...thread, meta: { ...thread.meta, url: feishuChatLink(lark ? 'lark' : 'feishu', chatId) } })
  }
}
/**
 * 将触发器从已移除的 `github-issue` 来源重新分配到 `github`，在每个曾有 pending 消息的 issue 上、
 * `POLL_HORIZON_MS` 内从最早的等待消息安排重试，并删除过时的 `github-issue` KV 键。
 */
function issueSourceRecords(store: Store): void {
  store.db.exec(`UPDATE trigger SET value = json_set(value, '$.source', 'github') WHERE value ->> '$.source' = 'github-issue'`)
  const pending = store.get('github-issue-pending' as Key<Record<string, { number: number; at: string }>>) ?? {}
  const retries = { ...store.get(KV.github.retries('github')) }
  for (const { number, at } of Object.values(pending)) {
    if (!(Date.now() - Date.parse(at) < POLL_HORIZON_MS)) continue
    const retry = retries[number]
    retries[number] = { ...retry, since: retry && retry.since < at ? retry.since : at, pr: retry?.pr ?? false }
  }
  if (Object.keys(retries).length) store.set(KV.github.retries('github'), retries)
  const kept = ['github-issue-pending', 'github-issues-since', 'github-issues-started-at', ...store.keys('github-issue-eligibility:')]
  for (const name of kept) store.delete(name)
}
/** 将每个 issue/PR 的通知和线程订阅游标合并为单个持有较晚时间戳的游标。 */
function githubCursors(store: Store): void {
  for (const name of [...store.keys('github-thread:'), ...store.keys('thread-since:github:')]) {
    const at = store.get<string>(name as Key<string>)
    const cursor = KV.github.cursor('github', Number(name.slice(name.lastIndexOf(':') + 1)))
    const current = store.get(cursor)
    if (at && !(current && current >= at)) store.set(cursor, at)
    store.delete(name)
  }
}
/** 为待处理评估副作用附加触发器 ID，并重新入队未投递的活跃评估，使其超时截止开始计时。 */
function assessmentTriggers(store: Store): void {
  const triggers = new Map(store.threads.active()
    .flatMap(thread => thread.evaluating ? [[thread.evaluating.id, thread.evaluating.triggerIds[0]] as const] : []))
  for (const row of store.db.prepare("SELECT key FROM effect WHERE kind = 'assessment' AND value ->> '$.triggerId' IS NULL").all()) {
    const triggerId = triggers.get(String(row.key))
    const named = JSON.stringify({ triggerId })
    if (triggerId) store.db.prepare("UPDATE effect SET value = ? WHERE kind = 'assessment' AND key = ?").run(named, row.key!)
    else store.db.prepare("DELETE FROM effect WHERE kind = 'assessment' AND key = ?").run(row.key!)
  }
  // 重新入队早于投递跟踪的活跃评估，使投递启动其超时截止，而不是让线程卡住。
  let seq = Number(store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  for (const thread of store.threads.active()) {
    const evaluation = thread.evaluating
    if (!evaluation || evaluation.delivered || !evaluation.triggerIds[0]) continue
    store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES ('assessment', ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING`)
      .run(evaluation.id, JSON.stringify({ triggerId: evaluation.triggerIds[0] }), ++seq, Date.now(), new Date().toISOString())
  }
}
