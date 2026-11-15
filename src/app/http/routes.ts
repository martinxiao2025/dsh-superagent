/** 管理 API 的路由表：每条路由把 HTTP 请求翻译成对 `HttpHost` 的调用，并把结果组装成面板视图。 */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { type Api, type ApiResponse, type RouteParams } from '../api.ts'
import { sourceSkills } from '../context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts } from '../prompts.ts'
import { policyVersion } from '../../policy.ts'
import { type Settings } from '../settings.ts'
import { type SetupProblem, type SourceCheck } from '../../setup.ts'
import { type EngineForPeople, type Ticket } from '../../core/index.ts'
import { firstSource, type Deployment, type Machine } from '../../deployment.ts'
import type { DshExecutor } from '../../executor/dsh.ts'
import type { Health } from '../../infra/health.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import type { Sessions } from '../sessions.ts'
import type { Store } from '../store.ts'
import type { TextCache } from '../cache.ts'
import type { LinkTarget, ViewHost } from '../views/records.ts'
import type { Variable } from '../execution-environment.ts'
import { policyHistory } from '../settings-history.ts'
import { overview } from '../views/overview.ts'
import { projectTasksView } from '../views/projects.ts'
import { settingsView } from '../views/settings.ts'
import { sourceHealth, sourceState, sourcesStatus, type SetupState } from '../views/sources.ts'
import { decisionList, search, threadDetail, threadList } from '../views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from '../views/tickets.ts'
import type { StartupStatus } from '../startup.ts'
import type { QueuePage } from '../scheduler.ts'
import type { QueueSnapshot } from '../../queue/model.ts'
import type { ResetReport } from '../reset.ts'
import type { GitCredentials } from '../../git-credentials/service.ts'
import type { FeishuCredentials } from '../../feishu-credentials/service.ts'
import { TASK_TEMPLATE_FILENAME, taskTemplate } from '../../task-sources/excel-template.ts'
import { ProjectTasksQuery, PromptsQuery, QueueQuery, TicketsQuery, ThreadsQuery, ThreadQuery, DecisionsQuery, RetroQuery,
  SettingsBlockSchema, SaveRequest, CreateProjectRequest, CreateSourceRequest, VerifySourceRequest, VerifyCodeRepoRequest,
  VerifyTaskSourceRequest, CreateGitCredentialRequest, UpdateGitCredentialRequest, RotateGitCredentialRequest,
  VerifyGitCredentialRequest, CreateFeishuCredentialRequest, UpdateFeishuCredentialRequest, RotateFeishuCredentialRequest,
  VerifyFeishuCredentialRequest, FeishuImChatsRequest, PauseRequest, SavePromptsRequest, ResetRequest } from './schemas.ts'
import { RouteError } from './error.ts'

export interface HttpHost {
  readonly store: Store
  /** 启动以来已解析的飞书消息链接，搜索用它来匹配 AppLink URL。 */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels' | 'createSource' | 'removeSource'
    | 'createProject' | 'removeProject'>
  /** Git 凭据：材料只存在于加密存储，面板拿到的是掩码与指纹。 */
  readonly gitCredentials: Pick<GitCredentials, 'list' | 'get' | 'create' | 'update' | 'rotate' | 'remove' | 'verify'>
  /** 飞书凭据：与 Git 凭据完全独立，互不读取对方的材料。 */
  readonly feishuCredentials: Pick<FeishuCredentials, 'list' | 'get' | 'create' | 'update' | 'rotate' | 'remove' | 'verify'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** 当启动完成或初始化确定仍缺什么时完成。 */
  readonly ready: Promise<void>
  /** 已解析的部署；在等待初始化期间读取（`!configured()`）会抛出异常。 */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  /** 按来源记录 ID 索引的部署校验问题。 */
  readonly sourceProblems?: Readonly<Record<string, SetupProblem>> | undefined
  /** 按记录 ID 排序的第一条记录问题；概览据此说明某个来源为何没有启动。 */
  readonly sourceProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  /** 项目调度队列的分页快照；P5 面板轮询读取，终态历史按页加载。 */
  queue(query?: { offset: number; limit: number }): QueuePage
  /** 项目详情视图的完整条目集（活动 + 终态），交互路径不分页。 */
  projectQueue(projectId: string): QueueSnapshot
  /** 手动重试一个已结束或退避中的队列条目。 */
  retryQueue(id: string): { retried: boolean }
  /** 手动取消一个活动中的队列条目；运行中的工单会被停止。 */
  cancelQueue(id: string): { cancelled: boolean }
  /** 清空排队项；传入项目 ID 时只清理该项目的排队项。 */
  clearQueue(project?: string): { cancelled: number }
  /** 项目被删除后清理它的队列记录并停止在跑的工单。 */
  forgetProject(projectId: string): void
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  /** 对新增来源的候选配置做真实预检；不写设置、不重启。 */
  checkSource(kind: string, config: unknown, field: string, meta: { id?: string; name?: string }): Promise<SourceCheck[]>
  /** 对代码仓库候选配置做真实预检；项目选择的 Git 凭据优先于本机 CLI 或 SSH key。 */
  checkCodeRepo(kind: string, config: unknown, field: string, meta: { gitCredential?: string }): Promise<SourceCheck[]>
  /** 按代码仓库候选配置与 Git 凭据列出远端分支；向导在连通性验证通过后据此渲染分支选择。 */
  listCodeRepoBranches(kind: string, config: unknown,
    gitCredential?: string): Promise<{ remote: string; branches: string[]; defaultBranch: string }>
  /** 对新增任务来源的候选配置做真实预检；驱动负责读取清单或文档，同样不写设置、不重启。 */
  checkTaskSource(kind: string, config: unknown, field: string, meta: {
    feishuCredential?: string
    projectId?: string
    repo?: { kind: 'github' | 'gitlab'; config: Record<string, unknown> }
    gitCredential?: string
  }): Promise<SourceCheck[]>
  /** 按飞书凭据列出机器人已加入的群；任务来源的群 ID 选择用它，凭据不可用时返回空列表。 */
  feishuImChats(credential: string): Promise<{ id: string; name: string }[]>
  requestPass(): void
  models(): Promise<ModelCatalog>
  /** 备份并清空状态目录后重启；仅由要求显式确认的管理入口调用。 */
  reset(): Promise<ResetReport>
  /** 在运行中的 SQLite 上执行 `VACUUM INTO`，把一致性快照写入 `target`（绝对路径）；日常备份用。 */
  backupDatabase(target: string): { snapshot: string }
}

export function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  // 账号摘要展示每种类型的第一条记录；面板的来源列表逐记录给出完整状态。
  const github = firstSource(resolved, 'github')
  const feishu = firstSource(resolved, 'feishu')
  const gitlab = firstSource(resolved, 'gitlab')
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: github?.repository ?? '', agent: github?.login ?? '', feishu: feishu ? { appId: feishu.appId, brand: feishu.brand, botId: feishu.botId, name: feishu.name } : null,
      gitlab: gitlab ? { project: gitlab.project, login: gitlab.login } : null } : null,
  }
}
/** 构建管理面板和 `scripts/dsh-superagent status` 使用的 `/orchestrator/api/state` 响应（`docs/006-deployment.md`）。 */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, sourceProblems: runtime.sourceProblems })
export type StateView = ReturnType<typeof stateView>
/** 构建工单详情视图；在等待初始化期间 `environment` 为空，因为它需要已解析的部署。 */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // 每个内置部分及其文本的键（覆盖项会把它记录为基准），以及对于所展示的覆盖项，
  // 若其内置文本此后发生变化，则为已知的其编辑来源文本。
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

export interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
export type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }

export function routes(runtime: HttpHost, listen: () => { host: string; port: number }, startup: () => StartupStatus): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.sourceProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'POST sources': async ({ body }) => {
      const request = CreateSourceRequest.parse(await body())
      return runtime.settings.createSource(request.kind, request.id, request.config, 'panel', request.name)
    },
    // 预检复用真实探测，但不持久化；面板逐字段调用，`field: 'all'` 表示验证全部关键字段。
    'POST sources/verify': async ({ body }) => {
      const request = VerifySourceRequest.parse(await body())
      return { checks: await runtime.checkSource(request.kind, request.config, request.field ?? 'all',
        { id: request.id, name: request.name }) }
    },
    'DELETE sources/:id': ({ params }) => runtime.settings.removeSource(params.id, 'panel'),
    // 仓库预检不再创建独立记录：候选配置来自项目表单，命中 Git 凭据时真实探测远端。
    'POST code-repos/verify': async ({ body }) => {
      const request = VerifyCodeRepoRequest.parse(await body())
      return { checks: await runtime.checkCodeRepo(request.kind, request.config, request.field ?? 'all',
        { gitCredential: request.gitCredential }) }
    },
    // 向导分支选择：按候选配置与 Git 凭据真实 ls-remote；连通性验证通过后调用。
    'POST code-repos/branches': async ({ body }) => {
      const request = VerifyCodeRepoRequest.parse(await body())
      return runtime.listCodeRepoBranches(request.kind, request.config, request.gitCredential)
    },
    // 任务来源预检：由驱动真实读取任务清单，但不持久化候选配置。
    'POST task-sources/verify': async ({ body }) => {
      const request = VerifyTaskSourceRequest.parse(await body())
      return { checks: await runtime.checkTaskSource(request.kind, request.config, request.field ?? 'all',
        { projectId: request.projectId, repo: request.repo, gitCredential: request.gitCredential,
          feishuCredential: request.feishuCredential }) }
    },
    // 标准任务清单模板：面板直接下载为 xlsx，不写入任何状态目录。
    'GET task-format/template': () => ({ filename: TASK_TEMPLATE_FILENAME, content: taskTemplate().toString('base64') }),
    'POST projects': async ({ body }) => {
      const { id, ...value } = CreateProjectRequest.parse(await body())
      return runtime.settings.createProject(id, value, 'panel')
    },
    'DELETE projects/:id': async ({ params }) => {
      const removed = await runtime.settings.removeProject(params.id, 'panel')
      // 设置删除成功后再清理队列，避免设置写入失败时丢失排队任务。
      runtime.forgetProject(params.id)
      return removed
    },
    // 项目详情页读取该项目在队列中的任务与全局运行时占用；项目不存在时 404。
    'GET projects/:id/tasks': ({ params, query }) => {
      const project = store.projects.get(params.id)
      if (!project) throw new RouteError(404, 'Project not found')
      return projectTasksView(params.id, project, runtime.projectQueue(params.id), ProjectTasksQuery.parse(query))
    },
    // 凭据与来源相互独立：路由、校验端点与材料存储都不共用。
    'GET git-credentials': () => ({ credentials: runtime.gitCredentials.list() }),
    'GET git-credentials/:id': ({ params }) => runtime.gitCredentials.get(params.id),
    'POST git-credentials': async ({ body }) => {
      const request = CreateGitCredentialRequest.parse(await body())
      return runtime.gitCredentials.create(request.value, request.id)
    },
    'PUT git-credentials/:id': async ({ params, body }) => {
      const request = UpdateGitCredentialRequest.parse(await body())
      return runtime.gitCredentials.update(params.id, request.value, request.revision)
    },
    'POST git-credentials/:id/rotate': async ({ params, body }) =>
      runtime.gitCredentials.rotate(params.id, RotateGitCredentialRequest.parse(await body())),
    // 用候选材料或已保存的材料做真实探测；不写设置、不落盘。
    'POST git-credentials/verify': async ({ body }) => {
      const request = VerifyGitCredentialRequest.parse(await body())
      return { checks: await runtime.gitCredentials.verify({ id: request.id, input: request.value, repository: request.repository }) }
    },
    'DELETE git-credentials/:id': ({ params }) => runtime.gitCredentials.remove(params.id),
    'GET feishu-credentials': () => ({ credentials: runtime.feishuCredentials.list() }),
    'GET feishu-credentials/:id': ({ params }) => runtime.feishuCredentials.get(params.id),
    'POST feishu-credentials': async ({ body }) => {
      const request = CreateFeishuCredentialRequest.parse(await body())
      return runtime.feishuCredentials.create(request.value, request.id)
    },
    'PUT feishu-credentials/:id': async ({ params, body }) => {
      const request = UpdateFeishuCredentialRequest.parse(await body())
      return runtime.feishuCredentials.update(params.id, request.value, request.revision)
    },
    'POST feishu-credentials/:id/rotate': async ({ params, body }) =>
      runtime.feishuCredentials.rotate(params.id, RotateFeishuCredentialRequest.parse(await body())),
    'POST feishu-credentials/verify': async ({ body }) => {
      const request = VerifyFeishuCredentialRequest.parse(await body())
      return { checks: await runtime.feishuCredentials.verify({ id: request.id, input: request.value, spaceId: request.spaceId }) }
    },
    // 飞书群消息任务来源的群 ID 选择：按凭据真实列出机器人已加入的群。
    'POST feishu-im/chats': async ({ body }) => {
      const request = FeishuImChatsRequest.parse(await body())
      return { chats: await runtime.feishuImChats(request.credential) }
    },
    'DELETE feishu-credentials/:id': ({ params }) => runtime.feishuCredentials.remove(params.id),
    // 健康探针附带启动阶段：即使运行时已就绪，也能看出这次启动经历了锁等待还是直接就绪。
    'GET health': () => healthView(runtime, listen(), startup),
    'GET queue': ({ query }) => runtime.queue(QueueQuery.parse(query)),
    // 队列操作面：重试/取消单条，或清空排队项；运行中的任务不会被清空操作打断。
    'POST queue/:id/retry': ({ params }) => runtime.retryQueue(params.id),
    'POST queue/:id/cancel': ({ params }) => runtime.cancelQueue(params.id),
    'POST queue/clear': ({ query }) => runtime.clearQueue(query.project || undefined),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    // 自我升级闭环的回顾聚合：按修订/模型/阶段分桶的工单结果与用量。
    'GET retro': ({ query }) => { const { by } = RetroQuery.parse(query); return { by, buckets: store.read.retro(by) } },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(PauseRequest.parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const [family, id] = block.includes(':') ? block.split(/:(.*)/s) as [string, string] : [block, '']
      const known = family === 'source' ? runtime.sources.instances().some(instance => instance.id === id)
        : family === 'project' ? !!store.projects.get(id) : true
      if (!known) throw new RouteError(404, family === 'source' ? 'Source not found' : 'Project not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    // 重置是破坏性操作：请求体必须显式包含确认词，且在停止运行时之后才删除状态目录。
    'POST admin/reset': async ({ body }) => {
      ResetRequest.parse(await body())
      return runtime.reset()
    },
    // 日常备份：在运行中的数据库上执行 VACUUM INTO 得到一致性快照；目标必须是绝对路径。
    'POST admin/backup': async ({ body }) => {
      const request = z.object({ target: z.string().trim().refine(path => isAbsolute(path), 'An absolute path') }).parse(await body())
      return runtime.backupDatabase(request.target)
    },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = SavePromptsRequest.parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}

/** 构建管理面板健康探针视图：就绪阶段、监听地址与每条来源记录的状态摘要。 */
export function healthView(runtime: HttpHost, listen: { host: string; port: number }, startup?: () => StartupStatus) {
  const setup = setupState(runtime)
  const ok = runtime.configured() && !runtime.setupProblem
  return {
    ok, stage: ok ? 'ready' as const : 'setup' as const, configured: runtime.configured(),
    paused: runtime.store.settings().paused, problem: runtime.setupProblem ?? null, listen,
    // 启动阶段只在插件入口挂载管理路由时提供；独立运行时（测试）省略这两个字段。
    ...startup === undefined ? {} : { phase: startup().phase, detail: startup().detail },
    machine: { stateDir: runtime.machine.stateDir },
    // 逐记录给出健康摘要；未安装类型按 `missing`，禁用记录按 `off`。
    sources: runtime.sources.instances().map(instance => {
      const { health, id } = sourceHealth(runtime.sources, instance, runtime.health)
      return { id, kind: instance.kind, enabled: instance.enabled, installed: instance.installed,
        state: sourceState(instance, health, setup), health }
    }),
  }
}
export type HealthView = ReturnType<typeof healthView>
