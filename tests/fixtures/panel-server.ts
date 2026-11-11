/**
 * 面板测试用的带类型伪管理 API 服务器。实现 `src/app/api.ts` 中的每个路由，并记录任何
 * 未声明的查询参数或请求体不匹配到 `server.misuse`，`usePanelServer` 会在每个测试后断言它为空。
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { z } from 'zod'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Api, ApiResponse, RouteParams } from '../../src/app/api.ts'
import { SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInPart, builtInParts, composePrompt, composeSkill, defaultPrompts,
  environmentSection, policySection, promptParts } from '../../src/app/prompts.ts'
import type { DroppedReply, HistoryView, Problem, ProjectTasksView, PromptsView, SetupView, SourceStatusRow, SourceView, StateView,
  ThreadPageView,
  ThreadRow, TicketPageView,
  TicketRow, TicketStage,
  TriggerRow } from '../../src/client/api.ts'
import { SETUP_FIELDS } from '../../src/deployment.ts'
import { CODE_REPO_TYPES, codeRepoType } from '../../src/code-repos/types.ts'
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema } from '../../src/policy.ts'
import { ProjectSchema } from '../../src/projects/kind.ts'
import type { GitCredentialInput, GitCredentialView } from '../../src/git-credentials/kind.ts'
import type { FeishuCredentialInput, FeishuCredentialView } from '../../src/feishu-credentials/kind.ts'
import type { CredentialCheck } from '../../src/secrets/check.ts'
import { SetupError, type SetupCode } from '../../src/setup.ts'
import { feishuChannel } from '../../src/sources/feishu-trigger.ts'
import { feishuKind } from '../../src/sources/feishu.ts'
import type { Health } from '../../src/sources/host.ts'
import type { SourceKind } from '../../src/sources/kind.ts'
import { testDeployment, testFeishu, testGithub, testGitlab } from './deployment.ts'

export const MEMBER = 'ou_alice'
const ALLOWED: Record<string, { id: string; name?: string }[]> = { feishu: [{ id: MEMBER, name: 'Alice' }], github: [{ id: 'alice' }] }
type Actor = TriggerRow['actor']
/** 使用夹具策略的允许名单或来源类型未命名回退来解析参与者显示标签。 */
export function actor(source: string, id: string, human = true): Actor {
  if (!id) return { source, id }
  const entry = ALLOWED[source]?.find(item => item.id.toLowerCase() === id.toLowerCase())
  const unnamed = source === 'feishu' ? feishuKind.policy?.unnamed : undefined
  const name = entry ? entry.name || entry.id : unnamed ? undefined : id
  return { source, id, name: name ? { zh: name, en: name } : human ? unnamed!.person : unnamed!.bot }
}
type TicketFields = Omit<TicketRow, 'stage' | 'action'>
const TICKET = {
  id: 't1', title: '修复回归', state: 'open', actions: { retry: false, stop: true }, strength: 'explicit', ended: undefined,
  attention: undefined, assignments: 1, inputs: 2, undelivered: 0, deliveryError: undefined, sessionId: 'worker-t1', directory: '/w/t1',
  project: undefined,
  summary: 'working on it', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
  threads: [{ key: 'github:42', source: 'github', title: '#42 Fix login', url: 'https://github.com/acme/widgets/pull/42',
    facts: { number: { value: '#42' }, ci: { label: { zh: 'CI 失败', en: 'CI failed' }, value: '1', problem: true } } }],
} satisfies TicketFields
export const ticketSummary = (fields: Partial<TicketFields> = {}, stage: TicketStage = { stage: 'working' }): TicketRow =>
  ({ ...TICKET, ...fields, ...stage })
export const threadSummary = (fields: Partial<ThreadRow> = {}): ThreadRow => ({
  key: 'feishu:oc_1:om_root', source: 'feishu', title: '这个文案好奇怪', stage: 'subscribed', latest: undefined, lastAt: '2026-09-23T00:00:00Z',
  createdAt: '2026-09-22T00:00:00Z', subscriptions: 1, tickets: [{ id: 't1', title: '修复回归', state: 'open' }], evaluating: undefined,
  pending: 0, pollError: undefined, url: undefined, facts: { chat: { value: '团队群' } }, ...fields,
})
type TriggerFields = Partial<Omit<TriggerRow, 'disposition' | 'actions'>> & { disposition?: Partial<TriggerRow['disposition']> }
/** 在默认线程上构建触发器行，并使用宿主的资格规则计算 `actions.requeue`。 */
export function trigger(id: string, at: string, { disposition, ...fields }: TriggerFields = {}): TriggerRow {
  const row = { id, source: 'feishu', actor: actor('feishu', MEMBER), human: true, at, text: `message ${id}`, preview: `message ${id}`,
    url: undefined, threads: ['feishu:oc_1:om_root'], ...fields,
    disposition: { queued: false, evaluating: false, delivered: false, filtered: undefined, fanout: [], handbacks: [], decision: undefined,
      ...disposition } }
  return { ...row, actions: { requeue: requeueable(row) } }
}
const requeueable = ({ human, disposition: d }: Pick<TriggerRow, 'human' | 'disposition'>) => human && !d.queued && !d.evaluating
  && (!!d.filtered || d.decision?.outcome === 'unavailable' || d.delivered || (d.fanout.length > 0 && !d.decision))
type SearchItem = ApiResponse<'GET search'>['items'][number]
export function found(id: string, at: string, { threadTitle, filtered,
  ...fields }: TriggerFields & { threadTitle?: string; filtered?: string } = {}): SearchItem {
  const { text: _text, ...result } = trigger(id, at, fields)
  return filtered === undefined ? { ...result, threadTitle } : { ...result, threadTitle: undefined, filtered }
}
export const promptVersion = (revision: number, config: PromptsView['current']['config']): PromptsView['current'] =>
  ({ revision, previousRevision: revision ? revision - 1 : null, savedAt: '', source: 'panel', config })
/** 构建一条被丢弃的出站回复夹具（`feishu` 回复 `oc_1`/`om_root`；`github` 在 PR #42 上评论）。 */
export const droppedReply = (id: string, hoursAgo: number, source: 'feishu' | 'github', reason: DroppedReply['dropped']['reason'],
  { ticket, thread }: { ticket?: DroppedReply['ticket']; thread?: false } = {}): DroppedReply => ({
  id, preview: `Reply ${id}`, kind: 'reply',
  channel: source === 'feishu' ? feishuChannel('feishu', 'oc_1', 'om_root')
    : { source: 'github', title: { zh: 'GitHub', en: 'GitHub' }, url: 'https://github.com/acme/widgets/pull/42' } as unknown as DroppedReply['channel'],
  dropped: { at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), reason }, ...ticket ? { ticket } : {},
  ...thread === false ? {} : { thread: source === 'feishu' ? 'feishu:oc_1:om_root' : 'github:42' },
})
const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString()
export const problemOf = (code: SetupCode, values: Record<string, string> = {}) => new SetupError(code, values).problem
// 这些类型的配置不同，伪实现只把它们当作视图所携带的记录来读取。
const KINDS = [feishuKind] as unknown as SourceKind[]
export const MACHINE = { stateDir: '/srv/dsh-superagent', promptMaxChars: 100000, admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000, commandTimeoutMs: 90000, workspaceRetentionDays: 14 }

type Settings = ReturnType<typeof SettingsSchema.parse>
export interface PanelServer {
  joined?: Record<string, string>; joining?: Record<string, string>
  joinError?: string
  settings: Settings; revisions: Record<string, number>
  /** 按记录 ID 索引的未结束工单数量；面板据此提示删除保护与停用后果。 */
  openTickets: Record<string, number>
  prompts: PromptsView
  tickets: { open: TicketRow[]; ended: TicketRow[] }; ticketDetails: Record<string, TicketPageView>
  threads: ThreadRow[]
  threadPages: (key: string, query: { before?: string; around?: string }) => ThreadPageView | undefined
  person: TicketRow[]; search: Pick<ApiResponse<'GET search'>, 'items' | 'threads'>; history: HistoryView
  requests: { path: string; method: string; body?: unknown }[]
  /** 带未声明查询参数或无效请求体存在性的请求；每个测试后断言为空。 */
  misuse: string[]
  queued: Set<string>
  /** 伪队列条目；项目页与概览按项目过滤后展示。 */
  queueItems: ProjectTasksView['items']
  /** 凭据与设置快照分开存放，模拟宿主的独立凭据表。 */
  gitCredentials: GitCredentialView[]
  feishuCredentials: FeishuCredentialView[]
  searching?: (query: string) => Promise<void>
  setup: SetupView
  health: Record<string, Health>
  /** 为 true 时，所有 API 请求返回空 404，以模拟宿主插件已停止。 */
  down: boolean
  /** 客户端尚未消费的响应数量。 */
  pending: number
  form?: ConfigForm<Record<string, unknown>> | undefined
  opened: string[]
  dropped: DroppedReply[]
  failing: Extract<Problem, { kind: 'outgoing' }>['outgoing'][]
}
export let server: PanelServer

function resolved() {
  const accounts = server.setup.accounts
  if (!accounts) return undefined
  return testDeployment({
    github: testGithub({ repository: accounts.repository, cli: '/bin/false', login: accounts.agent, noreply: '' }),
    feishu: accounts.feishu ? testFeishu({ cli: '/bin/false', ...accounts.feishu }) : undefined,
    ...accounts.gitlab ? { gitlab: testGitlab({ cli: '/bin/false', project: accounts.gitlab.project, login: accounts.gitlab.login }) } : {},
  })
}
/** 默认来源健康状态：设置期间暂停；除非被覆盖或被设置暂停，飞书默认为 `socket closed`。 */
function healthOf(name: string): Health {
  if (server.setup.problem) return { state: 'paused', detail: 'Waiting for setup', code: 'setupPending' }
  if (server.health[name]) return server.health[name]
  if (name !== 'feishu') return { state: 'ready', detail: '' }
  return server.setup.feishuProblem ? { state: 'paused', detail: server.setup.feishuProblem.detail } : { state: 'error',
    detail: 'socket closed' }
}
const problemOf_ = (id: string) => [server.setup.problem, server.setup.feishuProblem].find(item => item?.place === id) ?? undefined
function sourceSettings(): SourceView[] {
  // 与宿主一致：按记录 ID 排序，新增/删除会真实反映在面板上。
  return Object.entries(server.settings.sources).sort(([a], [b]) => a.localeCompare(b)).map(([id, record]) => {
    const kind = KINDS.find(item => item.kind === record.kind)!
    const config = kind.schema.parse(record.config ?? {})
    const problem = problemOf_(id)
    const { admission: _admission, ...part } = server.settings.policy.sources[id] ?? { allowed: [], admission: {} }
    const sync = kind.policy?.sync && { label: kind.policy.sync.label, ready: kind.policy.sync.ready(kind.policy.schema.parse(part)),
      health: server.health[`sync:${id}`] }
    const policy = kind.policy && { fields: kind.policy.fields, explicit: kind.policy.explicit, ...kind.policy.rows
      ? { rows: kind.policy.rows(config) } : {}, ...sync ? { sync } : {} }
    const title = { zh: record.name, en: record.name }
    return { id, kind: record.kind, name: record.name, title, description: kind.description, installed: true,
      value: { name: record.name, enabled: record.enabled, config }, revision: server.revisions[`source:${id}`] ?? 0,
      restarts: SETUP_FIELDS[record.kind] ?? [], fields: kind.fields, facts: kind.facts?.(resolved()?.sources[id]) ?? {},
      labels: record.kind === 'feishu' ? { oc_team: '团队群', oc_other: '另一个群', ...server.joined } : {}, openTickets: server.openTickets[id] ?? 0,
      ...problem ? { problem } : {}, ...policy ? { policy } : {} }
  })
}
function sourceStatuses(): SourceStatusRow[] {
  return Object.entries(server.settings.sources).sort(([a], [b]) => a.localeCompare(b)).map(([id, record]) => {
    const kind = KINDS.find(item => item.kind === record.kind)!
    const enabled = record.enabled
    const health = kind.health.map(name => ({ name, ...healthOf(name) }))
    const problem = problemOf_(id)
    const state = !enabled ? 'off' : problem || health.some(item => item.state === 'error') ? 'error' : server.setup.problem ? 'setup'
      : health.some(item => item.state === 'starting') ? 'starting' : health.some(item => item.state === 'paused') ? 'paused' : 'ready'
    const feishu = kind.kind === 'feishu'
    return { id, title: { zh: record.name, en: record.name }, installed: true, enabled, state, health,
      ...problem ? { problem } : {},
      stats: { received: feishu ? 12 : 0, filtered: feishu ? 2 : 0, lastAt: '2026-09-23T00:00:00Z' },
      filtered: feishu ? [{ id: 'e9', at: '2026-09-23T00:02:00Z', actor: actor('feishu', 'ou_someone'), preview: 'looks wrong',
        reason: { code: 'source_disabled' } }] : [],
      dropped: server.dropped.filter(item => item.channel.source === id && item.dropped.at >= dayAgo()) }
  })
}
const stateView = (): StateView => ({
  setup: server.setup, load: { running: server.setup.problem ? 0 : 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers },
  masterId: 'master', paused: server.settings.paused,
  // 面板不读取健康状态；服务脚本才会。
  health: {},
})
const settingsView = (): ApiResponse<'GET settings'> => ({
  policyVersion: 'abcdef1234567890',
  kinds: KINDS.map(kind => ({ kind: kind.kind, title: kind.title, description: kind.description, fields: kind.fields })),
  blocks: { policy: { value: server.settings.policy, revision: server.revisions.policy ?? 0 },
    eval: { value: server.settings.eval, revision: server.revisions.eval ?? 0 },
    executor: { value: server.settings.executor, revision: server.revisions.executor ?? 0 } },
  sources: sourceSettings(),
  codeRepos: Object.entries(server.settings.codeRepos).sort(([a], [b]) => a.localeCompare(b)).map(([id, record]) => ({ id, kind: record.kind,
    name: record.name, enabled: record.enabled, title: codeRepoType(record.kind)?.title, fields: codeRepoType(record.kind)?.fields ?? [],
    value: { name: record.name, enabled: record.enabled, config: record.config },
    revision: server.revisions[`codeRepo:${id}`] ?? 0 })),
  codeRepoKinds: CODE_REPO_TYPES.map(type => ({ kind: type.kind, title: type.title, description: type.description, fields: type.fields })),
  taskSources: Object.entries(server.settings.taskSources).map(([id, record]) => ({ id, kind: record.kind, name: record.name,
    enabled: record.enabled, title: { zh: record.name, en: record.name }, fields: [],
    value: { name: record.name, enabled: record.enabled, config: record.config }, revision: server.revisions[`taskSource:${id}`] ?? 0 })),
  projects: Object.entries(server.settings.projects).map(([id, project]) => ({ id, name: project.name, enabled: project.enabled,
    codeRepo: project.codeRepo, taskSource: project.taskSource, value: project, revision: server.revisions[`project:${id}`] ?? 0 })),
  taskSourceKinds: [
    { kind: 'excel', title: { zh: 'Excel 文件', en: 'Excel file' }, description: { zh: '仓库清单', en: 'Repository list' }, fields: [] },
    { kind: 'feishu-im', title: { zh: '飞书消息', en: 'Feishu messages' }, description: { zh: '群消息', en: 'Chat messages' }, fields: [] },
    { kind: 'feishu-wiki', title: { zh: '飞书知识库', en: 'Feishu wiki' }, description: { zh: '飞书文档', en: 'Feishu document' }, fields: [] },
  ],
  environment: { root: '/srv/dsh-superagent/work', variables: [
    { owner: 'executor', enabled: true, variables: [{ key: 'DSH_SUPERAGENT_DIR', description: { zh: '工单的执行目录',
      en: 'The ticket directory' } },
      { key: 'DSH_SUPERAGENT_NAME', description: { zh: '工单短名', en: 'Short name' } }] },
    { owner: 'github', enabled: false, variables: [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '仓库',
      en: 'Repository' } }] }] },
})
const overviewView = (): ApiResponse<'GET overview'> => {
  const { problem, feishuProblem } = server.setup
  const setup = problem ?? feishuProblem
  return {
    problems: [...setup ? [{ kind: 'setup' as const, ...setup }] : [],
      ...Object.values(server.settings.sources).some(record => record.enabled !== false) ? [] : [{ kind: 'no-source' as const }],
      ...feishuProblem || server.settings.sources.feishu?.enabled === false ? [] : [{ kind: 'source-error' as const, source: { id: 'feishu',
        title: { zh: '飞书', en: 'Feishu' },
        health: { name: 'feishu', state: 'error' as const, detail: 'socket closed' } } }],
      ...server.threads.filter(thread => thread.evaluating && thread.evaluating.deadline < new Date().toISOString())
        .map(thread => ({ kind: 'eval-overdue' as const, thread })),
      { kind: 'eval-unavailable' as const, decisionId: 'u1', thread: threadSummary(), reason: [{ code: 'timeout' }], triggerId: 'e3' },
      ...server.settings.paused ? [{ kind: 'executor-paused' as const }] : [],
      // 与宿主机上一样，错误中每个不是来源自身、策略同步或单独列出的不可用评估的条目都是运行时错误。
      ...Object.entries(server.health).filter(([name, item]) => item.state === 'error' && !KINDS.some(kind => kind.health.includes(name))
        && !name.startsWith('sync:') && name !== 'evals')
        .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail, category: item.category ?? 'runtime' })),
      ...Object.values(server.settings.policy.sources).some(part => part.allowed.length) ? [] : [{ kind: 'no-allowed' as const }],
      ...server.failing.map(outgoing => ({ kind: 'outgoing' as const, outgoing }))],
    person: server.person, executor: { running: 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers, idle: 1 },
    flow: { received: 12, filtered: 2, triggers: 10, judged: 5, accepted: 1, evaluating: 0,
      dropped: server.dropped.filter(item => item.dropped.at >= dayAgo()).length },
    policyVersion: 'abcdef1234567890',
  }
}
export const acceptDecision = (): NonNullable<TicketPageView['decision']> => ({ id: 'd1', kind: 'accept', outcome: 'accept',
  reason: [{ code: 'explicitRouted' }], at: '2026-09-22T00:00:00Z', strength: 'explicit', ticketId: undefined,
  triggerIds: ['e1'], thread: 'feishu:oc_1:om_root', rules: [], preview: '@bot 修一下', ticketTitle: undefined })
const ticketDetail = (): TicketPageView => ({
  ...ticketSummary(), paused: false, decision: acceptDecision(), threads: [threadSummary()],
  mandate: { strength: 'explicit', policyVersion: 'abcdef1234567890', basis: { via: 'addressed', sender: 'Alice', addressed: 'mention' },
    actor: actor('feishu', MEMBER), scope: '修复登录页回归' },
  basis: { facts: [{ name: 'sender', value: 'Alice' }, { name: 'addressed', value: 'mention' }], legacy: false },
  environment: [{ key: 'DSH_SUPERAGENT_DIR', value: '/w/t1', description: { zh: '执行目录', en: 'Directory' }, owner: 'executor' },
    { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', value: '', description: { zh: '编号', en: 'Number' }, owner: 'github' }],
  channels: [{ source: 'feishu', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', label: { zh: '飞书消息',
    en: 'Feishu message' } },
    { source: 'github', url: 'https://github.com/acme/widgets/issues/42', label: { zh: 'GitHub #42', en: 'GitHub #42' } }],
  assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-22T00:00:00Z',
    startedAt: '2026-09-22T00:01:00Z',
    report: { state: 'progress', summary: 'working', at: '2026-09-22T00:02:00Z' } }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: false,
    trigger: { id: 'e2', actor: actor('feishu', MEMBER), human: true, preview: '顺便改标题', thread: 'feishu:oc_1:om_root' } },
  { id: 'i2', kind: 'policy-changed', at: '2026-09-22T00:04:00Z', delivered: true, from: 'aaaaaaaaaaaaaaaa', to: 'bbbbbbbbbbbbbbbb' }],
})
function threadPage(key: string, { before, around }: { before?: string; around?: string }): ThreadPageView | undefined {
  if (key !== threadSummary().key) return undefined
  const base = { ...threadSummary(), tickets: [ticketSummary()], correlated: [{ key: 'github:42', title: 'PR 42' }], decisions: [],
    url: 'https://example.test/thread', context: [] }
  const decision = { id: 'd1', outcome: 'accept' as const, reason: [{ code: 'said', values: { text: 'x' } }], ticketId: 't1' }
  if (before === 'cursor-1' || around === 'e1') return { ...base, timeline: [trigger('e1', '2026-09-20T00:00:00Z',
    { disposition: { decision } })], earlier: null }
  return { ...base, earlier: 'cursor-1', timeline: [trigger('e3', '2026-09-23T00:00:00Z', { disposition: { fanout: ['t1'] } }),
    trigger('e4', '2026-09-23T00:01:00Z', { disposition: { filtered: { code: 'not_a_member' } } })] }
}
function initial(): PanelServer {
  const settings = SettingsSchema.parse({
    policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' } },
      rules: [{ id: 'copy', name: '文案修改', enabled: true, instruction: '修正明确的文案错误' }] },
    sources: { feishu: { kind: 'feishu', name: '飞书', enabled: true, config: { cli: 'lark-bot', chats: [{ chatId: 'oc_team', listen: 'mentions' }],
      directMessages: true } } },
    codeRepos: { github: { kind: 'github', name: 'GitHub', enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent' } } },
    executor: { blockedCommands: ['gh-personal'] },
  })
  const ended = ticketSummary({ id: 't0', title: '旧工单', state: 'ended', actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'human', reason: 'Human asked to stop', outcome: 'stopped' } }, { stage: 'ended' })
  const reply = { source: 'feishu', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', label: { zh: '飞书消息',
    en: 'Feishu message' } }
  const defaults = { revision: 0, previousRevision: null, savedAt: '', source: 'defaults' }
  return {
    health: {}, down: false, pending: 0, opened: [], requests: [], misuse: [], queued: new Set(), queueItems: [], dropped: [], failing: [],
    gitCredentials: [], feishuCredentials: [],
    openTickets: {},
    setup: { machine: MACHINE, problem: null, feishuProblem: null,
      accounts: { repository: 'acme/widgets', agent: 'agent-bot', feishu: { appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot',
        name: 'Widgets Bot' }, gitlab: null } },
    settings, revisions: { policy: 3, eval: 1, executor: 0 },
    prompts: { masterId: 'master', sections: TEAM_SECTIONS, skillName: SKILL_NAME.source, builtin: ['feishu', 'github'],
      skillPrefix: SKILL_PREFIX, revision: 0, current: { ...defaults, config: defaultPrompts() },
      defaults: defaultPrompts(), parts: Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) })),
      defaultChanged: [], revisions: [{ ...defaults, changed: [] }], sessions: [], notificationPending: false, next_offset: null },
    tickets: { open: [ticketSummary()], ended: [ended] }, ticketDetails: { t1: ticketDetail() },
    threads: [threadSummary()], threadPages: threadPage,
    person: [ticketSummary({ attention: { id: 'q1', question: '需要确认按钮颜色' }, note: { text: '需要确认按钮颜色', error: false }, reply },
      { stage: 'person', action: 'answer' }),
      ticketSummary({ id: 't4', title: '截图工具', actions: { retry: true, stop: true }, sessionId: 'worker-t4',
        summary: 'LlmError: no adapter registered for provider "provider-a"',
        note: { text: 'LlmError: no adapter registered for provider "provider-a"', error: true } }, { stage: 'person', action: 'failed' })],
    search: { items: [], threads: [] },
    history: { current: 3, policyVersion: 'abcdef1234567890', items: [
      { revision: 4, savedAt: '2026-09-23T00:00:00Z', source: 'panel', policyVersion: '9876543210fedcba', policyChanged: true, notified: [],
        block: 'source:feishu',
        changes: [{ code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_team'] }] },
      { revision: 3, savedAt: '2026-09-22T00:00:00Z', source: 'panel', policyVersion: 'abcdef1234567890', policyChanged: true,
        notified: [{ id: 't1', title: '修复回归' }], block: 'policy',
        changes: [{ code: 'mode', from: 'off', to: 'observe' }, { code: 'sourceField', source: 'feishu', field: 'directMessages',
          from: true, to: false },
          { code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_other', 'oc_new'] }] }] },
  }
}

/** 携带宿主 HTTP 状态码和 JSON 错误体的拒绝响应。请求被拒绝时由路由处理器返回。 */
class Refusal { constructor(readonly status: 400 | 404 | 409 | 500, readonly body: Record<string, unknown>) {} }
const refuse = (status: Refusal['status'], error: string, more: Record<string, unknown> = {}) => new Refusal(status, { error, ...more })
type Query<K extends keyof Api> = Api[K] extends { query?: infer Q } ? keyof NonNullable<Q> & string : never
type Body<K extends keyof Api> = Api[K] extends { body: infer B } ? B : undefined
interface Request<K extends keyof Api> { params: RouteParams<K>; query: Partial<Record<Query<K>, string>>; body: Body<K> }
type Answer<K extends keyof Api> = ApiResponse<K> | Refusal
type Route<K extends keyof Api> = { query?: readonly Query<K>[]; answer: (request: Request<K>) => Answer<K> | Promise<Answer<K>> }
  & (Api[K] extends { body: unknown } ? { body: true } : { body?: never })
const page = <T>(items: T[]) => ({ items, total: items.length, next_offset: null })
const credentialSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'credential'
const gitCredentialView = (id: string, value: GitCredentialInput, revision = 1): GitCredentialView => ({
  id, name: value.name, kind: value.kind, provider: value.provider, username: value.username ?? '', note: value.note ?? '',
  origin: value.keyPath ? 'file' : 'pasted', keyPath: value.keyPath ?? '', revision, updatedAt: '2026-09-23T00:00:00Z',
  lastVerifiedAt: '', configured: value.kind === 'ssh' ? Boolean(value.privateKey || value.keyPath) : Boolean(value.token),
  fingerprint: 'sha256:abcdef0123456789', hint: value.kind === 'ssh' ? 'private key' : '••••abcd',
})
const feishuCredentialView = (id: string, value: FeishuCredentialInput, revision = 1): FeishuCredentialView => ({
  id, name: value.name, mode: value.mode, appId: value.appId ?? '', cli: value.cli ?? '', note: value.note ?? '', revision,
  updatedAt: '2026-09-23T00:00:00Z', lastVerifiedAt: '',
  configured: value.mode === 'app' ? Boolean(value.appId && value.appSecret) : Boolean(value.cli),
  fingerprint: value.mode === 'app' ? 'sha256:fedcba9876543210' : '', hint: value.mode === 'app' ? '••••wxyz' : '',
})
const ticketOf = (id: string) =>
  [...server.tickets.open, ...server.person, ...server.tickets.ended].find(ticket => ticket.id === id) ?? server.ticketDetails[id]
const SourceSave = z.object({ name: z.string().trim().min(1), enabled: z.boolean(), config: z.unknown() })

const ROUTES: { [K in keyof Api]: Route<K> } = {
  'GET state': { answer: stateView },
  'GET overview': { answer: overviewView },
  'GET search': { query: ['q'], answer: async ({ query }) => {
    const q = query.q ?? ''
    await server.searching?.(q)
    return { tickets: [], threads: server.search.threads, items: server.search.items.filter(item => item.preview.includes(q)) }
  } },
  'GET sources': { answer: sourceStatuses },
  'GET queue': { answer: () => ({ at: '2026-09-23T00:00:00Z', maxWorkers: server.settings.executor.maxWorkers, used: 0,
    items: server.queueItems,
    projects: Object.entries(server.settings.projects).map(([id, project]) => ({ id, name: project.name, enabled: project.enabled })) }) },
  'POST queue/:id/retry': { answer: () => ({ retried: true }) },
  'POST queue/:id/cancel': { answer: () => ({ cancelled: true }) },
  'POST queue/clear': { query: ['project'], answer: () => ({ cancelled: 0 }) },
  'GET projects/:id/tasks': { answer: ({ params }) => {
    const project = server.settings.projects[params.id]
    if (!project) return refuse(404, 'Project not found')
    const items = server.queueItems.filter(item => item.project === params.id)
    return { project: { id: params.id, name: project.name, enabled: project.enabled,
      codeRepo: { id: project.codeRepo, name: server.settings.codeRepos[project.codeRepo]?.name ?? project.codeRepo },
      taskSource: { id: project.taskSource, name: server.settings.taskSources[project.taskSource]?.name ?? project.taskSource },
      execution: project.execution, schedule: project.schedule, retry: project.retry, taskPolicy: project.taskPolicy },
      at: '2026-09-23T00:00:00Z', maxWorkers: server.settings.executor.maxWorkers, used: 0,
      queued: items.filter(item => item.state === 'queued').length,
      running: items.filter(item => item.state === 'running' || item.state === 'starting').length, items,
      nextPollAt: '2026-09-23T01:00:00Z' }
  } },
  'POST sources': { body: true, answer: ({ body }) => {
    const kind = KINDS.find(item => item.kind === body.kind)
    if (!kind) return refuse(404, `Unknown Source kind: ${body.kind}`, { code: 'sourceKindUnknown', values: { kind: body.kind } })
    let id = body.id ?? kind.kind
    if (server.settings.sources[id]) {
      if (body.id) return refuse(400, `A Source with the record ID ${id} already exists`, { code: 'sourceExists', values: { source: id } })
      let suffix = 2
      while (server.settings.sources[`${kind.kind}-${suffix}`]) suffix++
      id = `${kind.kind}-${suffix}`
    }
    const config = kind.schema.parse(body.config ?? {})
    server.settings = { ...server.settings, sources: { ...server.settings.sources,
      [id]: { kind: kind.kind, name: body.name, enabled: true, config } } }
    server.revisions[`source:${id}`] = 0
    return { id, revision: 0, restarting: true }
  } },
  'POST code-repos': { body: true, answer: ({ body }) => {
    const id = body.id ?? body.kind
    server.settings = { ...server.settings, codeRepos: { ...server.settings.codeRepos,
      [id]: { kind: body.kind, name: body.name, enabled: true, config: (body.config ?? {}) as Record<string, unknown> } } }
    return { id, revision: 0, restarting: false as const }
  } },
  // 代码仓库预检：测试里返回可预期的结果；真实探测（含空仓库）由宿主实现。
  'POST code-repos/verify': { body: true, answer: ({ body }) => {
    const field = body.field ?? 'all'
    const config = (body.config ?? {}) as Record<string, unknown>
    const auth = config.auth === 'ssh' ? 'ssh' : 'https'
    if ((field === 'repository' || field === 'project') && !config[field]) {
      return { checks: [{ field, ok: false, scope: 'check' as const, code: 'sourceConfigInvalid',
        values: { detail: `${field}: required` } }] }
    }
    const codes: Record<string, string> = { name: 'sourceNameOk', id: 'sourceIdOk', kind: 'sourceKindOk',
      auth: auth === 'ssh' ? 'codeRepoAuthSsh' : 'codeRepoAuthHttps', instanceUrl: 'codeRepoInstanceOk',
      repository: 'githubRepositoryOk', project: 'gitlabProjectOk', remote: 'codeRepoRemoteAuto',
      sshKey: 'codeRepoKeyDefault', cli: auth === 'ssh' ? 'codeRepoCliOptional' : 'githubAccountOk' }
    const values: Record<string, Record<string, string>> = { name: { name: String(body.name ?? '') },
      id: { id: String(body.id ?? '') }, auth: {}, instanceUrl: { host: 'github.com' },
      repository: { repository: 'acme/widgets', login: 'agent-bot' }, project: { project: 'acme/widgets', login: 'agent-bot' },
      remote: { remote: 'git@github.com:acme/widgets.git' }, sshKey: {}, cli: { login: 'agent-bot' } }
    const ok = (name: string) => ({ field: name, ok: true, scope: 'check' as const, code: codes[name] ?? 'sourceKindOk',
      values: values[name] ?? {} })
    const keyFields = body.kind === 'gitlab' ? ['auth', 'project', 'remote', 'sshKey', 'cli'] : ['auth', 'repository', 'remote', 'sshKey', 'cli']
    return { checks: field === 'all' ? ['name', 'kind', 'id', ...keyFields].map(ok) : [ok(field)] }
  } },
  'DELETE code-repos/:id': { answer: ({ params }) => {
    const { [params.id]: _record, ...codeRepos } = server.settings.codeRepos
    server.settings = { ...server.settings, codeRepos }
    return { removed: true as const, restarting: false as const }
  } },
  'POST task-sources': { body: true, answer: ({ body }) => {
    const id = body.id ?? body.kind
    server.settings = { ...server.settings, taskSources: { ...server.settings.taskSources,
      [id]: { kind: body.kind, name: body.name, enabled: true, config: (body.config ?? {}) as Record<string, unknown> } } }
    return { id, revision: 0, restarting: false as const }
  } },
  'DELETE task-sources/:id': { answer: ({ params }) => {
    const { [params.id]: _record, ...taskSources } = server.settings.taskSources
    server.settings = { ...server.settings, taskSources }
    return { removed: true as const, restarting: false as const }
  } },
  'POST task-sources/verify': { body: true, answer: ({ body }) => {
    const field = body.field ?? 'all'
    if (field === 'name' && !String(body.name ?? '').trim()) {
      return { checks: [{ field, ok: false, scope: 'check' as const, code: 'sourceNameRequired', values: {} }] }
    }
    return { checks: [{ field, ok: true, scope: 'check' as const, code: field === 'name' ? 'sourceNameOk' : 'sourceKindOk',
      values: { kind: String(body.kind ?? ''), name: String(body.name ?? '') } }] }
  } },
  'GET task-format/template': { answer: () => ({ filename: 'tasks-template.xlsx', content: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==' }) },
  // 与宿主一致：创建时校验完整项目值；向导提交全部参数，省略的字段取 schema 默认值。
  'POST projects': { body: true, answer: ({ body }) => {
    const { id, ...value } = body
    const recordId = id ?? 'project'
    const project = ProjectSchema.parse(value)
    server.settings = { ...server.settings, projects: { ...server.settings.projects, [recordId]: project } }
    return { id: recordId, revision: 0, restarting: false as const }
  } },
  'DELETE projects/:id': { answer: ({ params }) => {
    const { [params.id]: _record, ...projects } = server.settings.projects
    server.settings = { ...server.settings, projects }
    return { removed: true as const, restarting: false as const }
  } },
  // 凭据与设置快照分开存放：伪实现只保留视图，不保留任何材料。
  'GET git-credentials': { answer: () => ({ credentials: server.gitCredentials }) },
  'GET git-credentials/:id': { answer: ({ params }) => server.gitCredentials.find(item => item.id === params.id)
    ?? refuse(404, 'Git credential not found') },
  'POST git-credentials': { body: true, answer: ({ body }) => {
    const id = body.id ?? credentialSlug(body.value.name)
    if (server.gitCredentials.some(item => item.id === id)) return refuse(409,
      `A Git credential with the record ID ${id} already exists`, { code: 'gitCredentialExists', values: { credential: id } })
    server.gitCredentials = [...server.gitCredentials, gitCredentialView(id, body.value)]
    return { id, revision: 1 }
  } },
  'PUT git-credentials/:id': { body: true, answer: ({ params, body }) => {
    const current = server.gitCredentials.find(item => item.id === params.id)
    if (!current) return refuse(404, 'Git credential not found')
    if (current.revision !== body.revision) return refuse(409, 'The credential changed since it was loaded',
      { code: 'credentialRevisionStale', values: {} })
    const next = gitCredentialView(current.id, body.value, current.revision + 1)
    server.gitCredentials = server.gitCredentials.map(item => item.id === current.id ? next : item)
    return { revision: next.revision }
  } },
  'POST git-credentials/:id/rotate': { body: true, answer: ({ params }) => {
    const current = server.gitCredentials.find(item => item.id === params.id)
    if (!current) return refuse(404, 'Git credential not found')
    const next = { ...current, revision: current.revision + 1 }
    server.gitCredentials = server.gitCredentials.map(item => item.id === current.id ? next : item)
    return { revision: next.revision }
  } },
  'POST git-credentials/verify': { body: true, answer: ({ body }) => {
    const value = body.value ?? {}
    const known = body.id ? server.gitCredentials.find(item => item.id === body.id) : undefined
    if (body.id && !known) return refuse(404, 'Git credential not found')
    const kind = value.kind ?? known?.kind ?? 'ssh'
    const hasMaterial = Boolean(value.privateKey || value.token || value.keyPath || known)
    const checks: CredentialCheck[] = hasMaterial
      ? [{ field: 'material', ok: true, scope: 'check', code: 'gitCredentialMaterialOk',
        values: { hint: kind === 'ssh' ? 'private key' : '••••abcd' } }]
      : [{ field: 'material', ok: false, scope: 'check', code: 'gitCredentialMaterialMissing', values: {} }]
    if (hasMaterial && kind === 'ssh' && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value.privateKey ?? '')
      && !known) checks.push({ field: 'key', ok: false, scope: 'check', code: 'gitCredentialKeyInvalid', values: {} })
    if (body.repository) checks.push({ field: 'repository', ok: true, scope: 'check', code: 'gitCredentialRemoteOk',
      values: { branches: '3' } })
    return { checks }
  } },
  'DELETE git-credentials/:id': { answer: ({ params }) => {
    const used = Object.values(server.settings.projects).filter(project => project.gitCredential === params.id).length
    if (used) return refuse(409, `The ${params.id} Git credential is still used by ${used} Projects`,
      { code: 'gitCredentialInUse', values: { credential: params.id, count: String(used) } })
    server.gitCredentials = server.gitCredentials.filter(item => item.id !== params.id)
    return { removed: true as const }
  } },
  'GET feishu-credentials': { answer: () => ({ credentials: server.feishuCredentials }) },
  'GET feishu-credentials/:id': { answer: ({ params }) => server.feishuCredentials.find(item => item.id === params.id)
    ?? refuse(404, 'Feishu credential not found') },
  'POST feishu-credentials': { body: true, answer: ({ body }) => {
    const id = body.id ?? credentialSlug(body.value.name)
    if (server.feishuCredentials.some(item => item.id === id)) return refuse(409,
      `A Feishu credential with the record ID ${id} already exists`, { code: 'feishuCredentialExists', values: { credential: id } })
    server.feishuCredentials = [...server.feishuCredentials, feishuCredentialView(id, body.value)]
    return { id, revision: 1 }
  } },
  'PUT feishu-credentials/:id': { body: true, answer: ({ params, body }) => {
    const current = server.feishuCredentials.find(item => item.id === params.id)
    if (!current) return refuse(404, 'Feishu credential not found')
    if (current.revision !== body.revision) return refuse(409, 'The credential changed since it was loaded',
      { code: 'credentialRevisionStale', values: {} })
    const next = feishuCredentialView(current.id, body.value, current.revision + 1)
    server.feishuCredentials = server.feishuCredentials.map(item => item.id === current.id ? next : item)
    return { revision: next.revision }
  } },
  'POST feishu-credentials/:id/rotate': { body: true, answer: ({ params }) => {
    const current = server.feishuCredentials.find(item => item.id === params.id)
    if (!current) return refuse(404, 'Feishu credential not found')
    const next = { ...current, revision: current.revision + 1 }
    server.feishuCredentials = server.feishuCredentials.map(item => item.id === current.id ? next : item)
    return { revision: next.revision }
  } },
  'POST feishu-credentials/verify': { body: true, answer: ({ body }) => {
    const value = body.value ?? {}
    const known = body.id ? server.feishuCredentials.find(item => item.id === body.id) : undefined
    if (body.id && !known) return refuse(404, 'Feishu credential not found')
    const mode = value.mode ?? known?.mode ?? 'app'
    const configured = known ? known.configured : mode === 'app' ? Boolean(value.appId && value.appSecret) : Boolean(value.cli)
    const checks: CredentialCheck[] = configured
      ? [{ field: 'identity', ok: true, scope: 'check', code: mode === 'app' ? 'feishuCredentialAppOk' : 'feishuCredentialCliOk',
        values: mode === 'app' ? { appId: value.appId ?? known?.appId ?? '', secret: '••••wxyz' } : { cli: value.cli ?? known?.cli ?? '' } }]
      : [{ field: 'identity', ok: false, scope: 'check', code: 'feishuCredentialMaterialMissing', values: {} }]
    if (body.spaceId) checks.push({ field: 'space', ok: true, scope: 'check', code: 'feishuCredentialSpaceOk',
      values: { spaceId: body.spaceId } })
    return { checks }
  } },
  'DELETE feishu-credentials/:id': { answer: ({ params }) => {
    server.feishuCredentials = server.feishuCredentials.filter(item => item.id !== params.id)
    return { removed: true as const }
  } },
  // 预检在测试脚本里按字段返回可预期的成功结果；真实探测由宿主实现。
  'POST sources/verify': { body: true, answer: ({ body }) => {
    const field = body.field ?? 'all'
    if (field === 'name' && String(body.name ?? '').length > 80) {
      return { checks: [{ field, ok: false, scope: 'check' as const, code: 'sourceNameTooLong', values: { limit: '80' } }] }
    }
    if (field === 'repository' && !(body.config as { repository?: string } | undefined)?.repository) {
      return { checks: [{ field, ok: false, scope: 'check' as const, code: 'checkFailed', values: { output: 'HTTP 404' } }] }
    }
    const codes: Record<string, string> = { name: 'sourceNameOk', id: 'sourceIdOk', kind: 'sourceKindOk',
      instanceUrl: body.kind === 'feishu' ? 'feishuInstanceOk' : 'githubInstanceOk', repository: 'githubRepositoryOk',
      project: 'gitlabProjectOk', cli: body.kind === 'feishu' ? 'feishuAccountOk' : 'githubAccountOk' }
    const values: Record<string, Record<string, string>> = { name: { name: String(body.name ?? '') }, id: { id: String(body.id ?? '') },
      instanceUrl: { host: body.kind === 'feishu' ? 'feishu.cn' : 'github.com' }, repository: { repository: 'acme/widgets', login: 'agent-bot' },
      project: { project: 'acme/widgets', login: 'agent-bot' },
      cli: body.kind === 'feishu' ? { name: '飞书' } : { login: 'agent-bot' } }
    const ok = (name: string) => ({ field: name, ok: true, scope: 'check' as const, code: codes[name] ?? 'sourceKindOk',
      values: values[name] ?? {} })
    const keyFields: Record<string, string[]> = { github: ['instanceUrl', 'repository', 'cli'], gitlab: ['instanceUrl', 'project', 'cli'],
      feishu: ['instanceUrl', 'cli'] }
    return { checks: field === 'all' ? ['name', 'kind', 'id', ...keyFields[body.kind] ?? []].map(ok) : [ok(field)] }
  } },
  'DELETE sources/:id': { answer: ({ params }) => {
    if (!server.settings.sources[params.id]) return refuse(404, 'Source not found')
    const count = server.openTickets[params.id] ?? 0
    if (count) return refuse(409, `The ${params.id} Source still has ${count} unfinished Tickets; disable it to end them`,
      { code: 'sourceInUse', values: { source: params.id, count: String(count) } })
    const { [params.id]: _removed, ...sources } = server.settings.sources
    server.settings = { ...server.settings, sources }
    return { removed: true, restarting: true }
  } },
  'GET health': { answer: () => ({
    ok: !server.setup.problem, stage: server.setup.problem ? 'setup' : 'ready', configured: true, paused: server.settings.paused,
    problem: server.setup.problem, listen: { host: '127.0.0.1', port: 3082 }, machine: { stateDir: MACHINE.stateDir },
    sources: sourceStatuses().map(({ id, enabled, installed, state, health }) => ({ id, kind: server.settings.sources[id]?.kind ?? id,
      enabled, installed, state, health })),
  }) },
  'GET settings': { answer: settingsView },
  'POST sources/:id/labels': { answer: () => {
    // 标签刷新失败来自机器人 CLI，并原样返回。
    if (server.joinError) return refuse(500, server.joinError)
    const added = Object.values(server.joining ?? {}); server.joined = { ...server.joined, ...server.joining }; server.joining = undefined
    return { added }
  } },
  'GET threads': { query: ['filter', 'offset', 'limit'], answer: () => page(server.threads) },
  'GET threads/:key': { query: ['limit', 'before', 'around'], answer: ({ params, query }) => {
    const found = server.threadPages(params.key, query)
    if (!found) return refuse(404, 'Thread not found')
    // 再次发送到评估的触发器已排队，不能重新排队。
    const queued = (item: TriggerRow) => ({ ...item, disposition: { ...item.disposition, queued: true }, actions: { requeue: false } })
    return { ...found, timeline: found.timeline.map(item => server.queued.has(item.id) ? queued(item) : item) }
  } },
  'POST threads/:key/unsubscribe': { answer: ({ params }) => {
    const removed = server.threads.length > 0
    server.threads = []
    return { removed, thread: params.key, context_delivery: 'injected' }
  } },
  'POST triggers/:id/requeue': { answer: ({ params }) => { server.queued.add(params.id); return { queued: true } } },
  'GET decisions': { query: ['kind', 'window', 'offset', 'limit'], answer: ({ query }) =>
    ({ items: query.kind === 'ignore' ? [] : [acceptDecision()], next_offset: null }) },
  'POST decisions/:id/dismiss': { answer: ({ params }) => params.id === 'u1' ? { dismissed: true } : refuse(404,
    'Unavailable Eval not found') },
  'GET tickets': { query: ['state', 'offset', 'limit'], answer: ({ query }) => page(server.tickets[query.state === 'ended' ? 'ended'
    : 'open']) },
  'GET tickets/:id': { answer: ({ params }) => server.ticketDetails[params.id] ?? refuse(404, 'Ticket not found') },
  'POST tickets/:id/retry': { answer: ({ params }) => {
    const ticket = ticketOf(params.id)
    if (!ticket) return refuse(404, 'Ticket not found')
    return ticket.actions.retry ? { retried: true } : refuse(400, 'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed',
      { code: 'notRetryable', values: {} })
  } },
  'POST tickets/:id/stop': { answer: ({ params }) => {
    if (!ticketOf(params.id)) return refuse(404, 'Ticket not found')
    server.tickets.open = []; server.person = server.person.filter(ticket => ticket.id !== params.id)
    return { stopped: true }
  } },
  'POST executor/pause': { body: true, answer: ({ body }) => {
    server.settings = { ...server.settings, paused: body.paused }
    server.revisions.pause = (server.revisions.pause ?? 0) + 1
    return { paused: body.paused }
  } },
  'PUT settings/:block': { body: true, answer: ({ params: { block }, body }) => {
    const record = block.startsWith('source:') ? server.settings.sources[block.slice('source:'.length)] : undefined
    const source = record ? KINDS.find(kind => kind.kind === record.kind) : undefined
    const codeRepoId = block.startsWith('codeRepo:') ? block.slice('codeRepo:'.length) : undefined
    const codeRepo = codeRepoId ? server.settings.codeRepos[codeRepoId] : undefined
    const taskSourceId = block.startsWith('taskSource:') ? block.slice('taskSource:'.length) : undefined
    const taskSource = taskSourceId ? server.settings.taskSources[taskSourceId] : undefined
    const projectId = block.startsWith('project:') ? block.slice('project:'.length) : undefined
    const project = projectId ? server.settings.projects[projectId] : undefined
    if (!['policy', 'eval', 'executor'].includes(block) && !record && !codeRepo && !taskSource && !project) {
      return block.includes(':') ? refuse(404, 'Record not found') : refuse(400, 'Invalid settings: block')
    }
    if (body.revision !== (server.revisions[block] ?? 0)) return refuse(409, 'Settings changed. Reload before saving.')
    let restarting = false
    if (block === 'policy') server.settings = { ...server.settings, policy: PolicyConfigSchema.parse(body.value) }
    else if (block === 'executor') server.settings = { ...server.settings, executor: ExecutorConfigSchema.parse(body.value) }
    else if (block === 'eval') server.settings = { ...server.settings, eval: EvalConfigSchema.parse(body.value) }
    else if (codeRepo && codeRepoId) {
      const { name, enabled, config } = SourceSave.parse(body.value)
      server.settings = { ...server.settings, codeRepos: { ...server.settings.codeRepos,
        [codeRepoId]: { ...codeRepo, name, enabled, config: config as Record<string, unknown> } } }
    } else if (taskSource && taskSourceId) {
      const { name, enabled, config } = SourceSave.parse(body.value)
      server.settings = { ...server.settings, taskSources: { ...server.settings.taskSources,
        [taskSourceId]: { ...taskSource, name, enabled, config: config as Record<string, unknown> } } }
    } else if (project && projectId) {
      server.settings = { ...server.settings, projects: { ...server.settings.projects, [projectId]: ProjectSchema.parse(body.value) } }
    } else if (record && source) {
      const { name, enabled, config: value } = SourceSave.parse(body.value)
      const config = source.schema.parse(value)
      // 与服务器上一样，更改后的 CLI 若未通过检查，会以设置问题拒绝保存。
      if (config.cli === 'lark-broken') {
        const refused = new SetupError('feishuCliFailed', { output: 'lark-cli: app secret missing' })
        return refuse(400, refused.message, { setup: refused.problem })
      }
      const id = block.slice('source:'.length)
      restarting = (config.cli ?? '') !== (record.config.cli ?? '')
      server.settings = { ...server.settings, sources: { ...server.settings.sources, [id]: { kind: record.kind, name, enabled, config } } }
    }
    server.revisions[block] = (server.revisions[block] ?? 0) + 1
    return { restarting, revision: server.revisions[block] }
  } },
  'GET policy/history': { answer: () => server.history },
  'POST policy-sync/:id': { answer: ({ params }) => ({ policy: server.settings.policy.sources[params.id] }) },
  'POST setup/check': { answer: () => ({ restarting: true }) },
  'POST admin/reset': { body: true, answer: ({ body: request }) => request.confirm === 'RESET'
    ? { at: '2026-11-11T00:00:00.000Z', stateDir: '/srv/dsh-superagent/state', backup: '/backup/2026-11-11T00-00-00-000Z',
      removed: ['orchestrator.sqlite'], kept: [] }
    : refuse(400, 'Invalid request body') },
  'GET models': { answer: () => ({ default: { provider: 'host', model: 'default' }, routableProviders: [], failures: [],
    groups: [{ id: 'worker-provider', name: 'Worker provider', models: [{ id: 'worker-model', name: 'Worker model',
      reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] }) },
  'GET prompts': { query: ['revision', 'offset'], answer: () => server.prompts },
  'PUT prompts': { body: true, answer: ({ body }) => {
    const { revision } = server.prompts
    if (body.baseRevision !== revision) return refuse(409,
      `Prompt version changed to ${revision}; compare the latest version before saving`)
    // 正如宿主所做：模板保留其占位符，没有覆盖时会存为 none。
    const { overrides = {}, ...config } = body.config as PromptsView['current']['config']
    for (const [part, override] of Object.entries(overrides)) {
      if (!builtInPart(part)) return refuse(400, 'refused', { code: 'unknownPromptPart', values: { part } })
      const missing = (builtInPart(part)?.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      if (missing.length) return refuse(400, 'refused', { code: 'promptPlaceholders', values: { part, placeholders: missing.join(', ') } })
    }
    server.prompts.revision++
    server.prompts.current = promptVersion(server.prompts.revision, Object.keys(overrides).length ? { ...config, overrides } : config)
    return { revision: server.prompts.revision, context_delivery: 'injected' }
  } },
  'POST prompts/preview': { body: true, answer: ({ body }) => {
    const skills = [...server.setup.accounts?.feishu ? ['feishu'] : [], 'github', ...Object.keys(body.skills)].map(name => [name,
      composeSkill(body, name)])
    // 由模板生成的部件，不含变量或规则。
    const environment = environmentSection(body, []), policy = policySection(SettingsSchema.parse({ policy: { rules: [] } }), body)
    return { parts: { orchestrator: promptParts(body, 'orchestrator', environment, policy), worker: promptParts(body, 'worker', environment) },
      skills: Object.fromEntries(skills),
      orchestrator: composePrompt(body, 'orchestrator'), worker: composePrompt(body, 'worker'), scope: '' }
  } },
}

function match(method: string, segments: string[]) {
  for (const key of Object.keys(ROUTES) as (keyof Api)[]) {
    const [verb, path] = key.split(' ') as [string, string]
    const pattern = path.split('/')
    if (verb !== method || pattern.length !== segments.length || !pattern.every((part, index) => part.startsWith(':')
      || part === segments[index])) continue
    return { key, params: Object.fromEntries(pattern.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1),
      decodeURIComponent(segments[index]!)]] : [])) }
  }
  return undefined
}
async function run<K extends keyof Api>(key: K, params: Record<string, string>, query: URLSearchParams, body: unknown): Promise<Answer<K>> {
  const route: Route<K> = ROUTES[key]
  const read: readonly string[] = route.query ?? []
  for (const name of query.keys()) if (!read.includes(name)) server.misuse.push(`${key} with the query parameter ${name}`)
  if ((body !== undefined) !== !!route.body) server.misuse.push(`${key} ${body === undefined ? 'without' : 'with'} a body`)
  const values: Partial<Record<Query<K>, string>> = {}
  for (const name of route.query ?? []) { const value = query.get(name); if (value !== null) values[name] = value }
  return route.answer({ params: params as RouteParams<K>, query: values, body: body as Body<K> })
}
/**
 * 响应包装器：构造时增加 `server.pending`，消费 `.text()` 时减少它。
 * 被 `server.searching` 暂缓的请求在 `searching` 解决前不会构造，因此不会过早计入待处理。
 */
class Reply extends Response {
  constructor(value: unknown, status: number) { super(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json' } }); server.pending++ }
  override async text() { server.pending--; return super.text() }
}

export function usePanelServer(cleanup: () => void) {
  beforeEach(() => {
    sessionStorage.clear()
    server = initial()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (server.down) return new Response(null, { status: 404 })
      const address = new URL(url, 'http://127.0.0.1:3082')
      const path = address.pathname.replace('/orchestrator/api/', '')
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
      server.requests.push({ path: decodeURIComponent(`${path}${address.search}`), method, ...body === undefined ? {} : { body } })
      const route = match(method, path.split('/'))
      if (!route) return new Reply({ error: 'Unknown operation' }, 404)
      const answer = await run(route.key, route.params, address.searchParams, body)
      return answer instanceof Refusal ? new Reply(answer.body, answer.status) : new Reply(answer, 200)
    }))
  })
  afterEach(() => {
    try { expect(server.misuse).toEqual([]) }
    finally { cleanup(); vi.unstubAllGlobals() }
  })
}

type Ops = Parameters<ConfigForm<Record<string, unknown>>['mutate']>[0]
/** 伪造的 DSH 宿主配置表单，记录变更并可选地将其应用到快照。 */
export function fakeForm(writable = true, accept = true) {
  const listeners = new Set<() => void>()
  let snapshot: ConfigFormSnapshot<Record<string, unknown>> = { status: 'ready', value: { ...MACHINE }, base: undefined, user: undefined,
    revision: 1, writable,
    mode: 'host' }
  const notify = () => { for (const listener of listeners) listener() }
  const mutations: { ops: Ops; revision: number | undefined }[] = []
  const form: ConfigForm<Record<string, unknown>> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
      if (!accept || revision !== snapshot.revision) return false
      const value = { ...snapshot.value }
      for (const op of ops) { if (op.op === 'set') value[op.path[0]!] = op.value; else delete value[op.path[0]!] }
      snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
      notify()
      return true
    },
    set: async () => false, unset: async () => false,
  }
  const publish = (patch: Partial<ConfigFormSnapshot<Record<string, unknown>>>) => { snapshot = { ...snapshot, ...patch }; notify() }
  return { form, mutations, publish }
}
