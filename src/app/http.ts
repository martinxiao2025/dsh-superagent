/** 仅限回环地址的管理 HTTP 路由，对 Web 面板强制同源校验。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { LIMITS } from '../limits.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem, type SourceCheck } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import { firstSource, type Deployment, type Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { projectTasksView } from './views/projects.ts'
import { settingsView } from './views/settings.ts'
import { sourceHealth, sourceState, sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import type { StartupStatus } from './startup.ts'
import type { QueueSnapshot } from '../queue/model.ts'
import type { ResetReport } from './reset.ts'
import type { GitCredentials } from '../git-credentials/service.ts'
import type { FeishuCredentials } from '../feishu-credentials/service.ts'
import { GitCredentialInputSchema } from '../git-credentials/kind.ts'
import { FeishuCredentialInputSchema } from '../feishu-credentials/kind.ts'
import { TASK_TEMPLATE_FILENAME, taskTemplate } from '../task-sources/excel-template.ts'

export interface HttpHost {
  readonly store: Store
  /** 启动以来已解析的飞书消息链接，搜索用它来匹配 AppLink URL。 */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels' | 'createSource' | 'removeSource'
    | 'createCodeRepo' | 'removeCodeRepo' | 'createTaskSource' | 'removeTaskSource' | 'createProject' | 'removeProject'>
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
  /** 项目调度队列的只读快照；P5 面板与外部集成读取。 */
  queue(): QueueSnapshot
  /** 项目被删除后清理它的队列记录并停止在跑的工单。 */
  forgetProject(projectId: string): void
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  /** 对新增来源的候选配置做真实预检；不写设置、不重启。 */
  checkSource(kind: string, config: unknown, field: string, meta: { id?: string; name?: string }): Promise<SourceCheck[]>
  /** 对代码仓库候选配置做真实预检；SSH 模式不运行 CLI，按本机 key 探测远端。 */
  checkCodeRepo(kind: string, config: unknown, field: string, meta: { id?: string; name?: string }): Promise<SourceCheck[]>
  /** 对新增任务来源的候选配置做真实预检；驱动负责读取清单或文档，同样不写设置、不重启。 */
  checkTaskSource(kind: string, config: unknown, field: string, meta: { id?: string; name?: string }): Promise<SourceCheck[]>
  requestPass(): void
  models(): Promise<ModelCatalog>
  /** 备份并清空状态目录后重启；仅由要求显式确认的管理入口调用。 */
  reset(): Promise<ResetReport>
}
/**
 * 表示管理路由解析或查找期间抛出的面向客户端的 400 或 404 错误。
 * 当请求体格式错误或目标记录缺失时，路由处理器会抛出它，registerHttp 会在 HTTP 响应中序列化其状态码和消息。
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  // 回环地址包含 IPv4、localhost 与 IPv6 回环；端口必须是管理接口实际监听的端口。
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** 将错误映射为 HTTP 状态码和结构化载荷，面板会按界面语言对其进行本地化。 */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [/InUse$/.test(error.code) ? 409 : error.missing ? 404 : 400,
    { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
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
/** 管理接口的实际监听地址；健康探针据此报告入口。 */
export interface Listen { host: string; port: number }
/** 构建 `/orchestrator/api/health` 探针视图：就绪阶段、监听地址与每条来源记录的状态摘要。 */
export function healthView(runtime: HttpHost, listen: Listen, startup?: () => StartupStatus) {
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

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const RecordBlock = z.templateLiteral([z.enum(['source', 'codeRepo', 'taskSource', 'project']), ':', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), RecordBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })
const ResourceId = z.string().regex(/^[a-z][a-z0-9-]*$/)
const CreateCodeRepoRequest = z.object({ kind: z.enum(['github', 'gitlab']), id: ResourceId.optional(),
  name: z.string().trim().min(1).max(LIMITS.sourceName), config: z.unknown().optional() })
const CreateTaskSourceRequest = z.object({ kind: z.string().regex(/^[a-z][a-z0-9-]*$/), id: ResourceId.optional(),
  name: z.string().trim().min(1).max(LIMITS.sourceName), config: z.unknown().optional() })
const CreateProjectRequest = z.object({ id: ResourceId.optional() }).passthrough()
const CreateSourceRequest = z.object({ kind: ResourceId, id: ResourceId.optional(),
  name: z.string().trim().min(1).max(LIMITS.sourceName), config: z.unknown().optional() })
const VerifySourceRequest = z.object({ kind: ResourceId, id: ResourceId.optional(),
  name: z.string().trim().max(LIMITS.sourceName).optional(), config: z.unknown().optional(), field: z.string().max(40).optional() })
const CreateGitCredentialRequest = z.object({ id: ResourceId.optional(), value: GitCredentialInputSchema })
const UpdateGitCredentialRequest = z.object({ value: GitCredentialInputSchema, revision: z.number().int().nonnegative() })
const RotateGitCredentialRequest = GitCredentialInputSchema.partial()
const VerifyGitCredentialRequest = z.object({ id: ResourceId.optional(), value: GitCredentialInputSchema.partial().optional(),
  repository: z.string().trim().max(2000).optional() })
const CreateFeishuCredentialRequest = z.object({ id: ResourceId.optional(), value: FeishuCredentialInputSchema })
const UpdateFeishuCredentialRequest = z.object({ value: FeishuCredentialInputSchema, revision: z.number().int().nonnegative() })
const RotateFeishuCredentialRequest = FeishuCredentialInputSchema.partial()
const VerifyFeishuCredentialRequest = z.object({ id: ResourceId.optional(), value: FeishuCredentialInputSchema.partial().optional(),
  spaceId: z.string().trim().max(80).optional() })

function routes(runtime: HttpHost, listen: () => Listen, startup: () => StartupStatus): Routes {
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
    'POST code-repos': async ({ body }) => {
      const request = CreateCodeRepoRequest.parse(await body())
      return runtime.settings.createCodeRepo(request.kind, request.id, request.config, 'panel', request.name)
    },
    // 与来源预检同构：字段级检查按认证方式真实探测，但不持久化候选配置。
    'POST code-repos/verify': async ({ body }) => {
      const request = VerifySourceRequest.parse(await body())
      return { checks: await runtime.checkCodeRepo(request.kind, request.config, request.field ?? 'all',
        { id: request.id, name: request.name }) }
    },
    'DELETE code-repos/:id': ({ params }) => runtime.settings.removeCodeRepo(params.id, 'panel'),
    'POST task-sources': async ({ body }) => {
      const request = CreateTaskSourceRequest.parse(await body())
      return runtime.settings.createTaskSource(request.kind, request.id, request.config, 'panel', request.name)
    },
    // 与来源预检同构：驱动真实读取任务清单，但不持久化候选配置。
    'POST task-sources/verify': async ({ body }) => {
      const request = VerifySourceRequest.parse(await body())
      return { checks: await runtime.checkTaskSource(request.kind, request.config, request.field ?? 'all',
        { id: request.id, name: request.name }) }
    },
    'DELETE task-sources/:id': ({ params }) => runtime.settings.removeTaskSource(params.id, 'panel'),
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
    'GET projects/:id/tasks': ({ params }) => {
      const settings = store.settings()
      const project = settings.projects[params.id]
      if (!project) throw new RouteError(404, 'Project not found')
      return projectTasksView(params.id, project, settings, runtime.queue())
    },
    // 凭据与来源、代码仓库记录相互独立：路由、校验端点与材料存储都不共用。
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
    'DELETE feishu-credentials/:id': ({ params }) => runtime.feishuCredentials.remove(params.id),
    // 健康探针附带启动阶段：即使运行时已就绪，也能看出这次启动经历了锁等待还是直接就绪。
    'GET health': () => healthView(runtime, listen(), startup),
    'GET queue': () => runtime.queue(),
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
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const [family, id] = block.includes(':') ? block.split(/:(.*)/s) as [string, string] : [block, '']
      const known = family === 'source' ? runtime.sources.instances().some(instance => instance.id === id)
        : family === 'codeRepo' ? !!store.settings().codeRepos[id]
          : family === 'taskSource' ? !!store.settings().taskSources[id]
            : family === 'project' ? !!store.settings().projects[id] : true
      if (!known) throw new RouteError(404, family === 'source' ? 'Source not found'
        : family === 'codeRepo' ? 'Code repository not found' : family === 'taskSource' ? 'Task source not found' : 'Project not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    // 重置是破坏性操作：请求体必须显式包含确认词，且在停止运行时之后才删除状态目录。
    'POST admin/reset': async ({ body }) => {
      z.object({ confirm: z.literal('RESET') }).parse(await body())
      return runtime.reset()
    },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
/**
 * 挂载管理 API。第一种形式供 `Runtime` 自挂载（测试与独立运行时）；第二种形式供插件入口
 * 在运行时创建之前先挂载，并在初始化失败时用启动状态回答健康探针与 503 诊断。
 */
export function registerHttp(ctx: Context, runtime: HttpHost): () => void
export function registerHttp(ctx: Context, resolve: () => HttpHost | undefined, status: () => StartupStatus): () => void
export function registerHttp(ctx: Context, source: HttpHost | (() => HttpHost | undefined), status?: () => StartupStatus): () => void {
  const resolve = typeof source === 'function' ? source : () => source
  const state = status ?? ((): StartupStatus => ({ phase: 'ready', detail: '', stateDir: resolve()?.machine.stateDir ?? '' }))
  // 端口在请求时读取：插件初始化阶段 Web 服务器可能尚未监听。
  const listen = (): Listen => ({ host: ctx.webServer.host, port: ctx.webServer.port })
  // 运行时只创建一次；缓存它的路由表，避免每个请求重建。
  let cached: { runtime: HttpHost; table: Routes } | undefined
  const tableFor = (runtime: HttpHost): Routes => {
    if (cached?.runtime !== runtime) cached = { runtime, table: routes(runtime, listen, state) }
    return cached.table
  }
  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/orchestrator/api', handler: async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
    const method = req.method ?? 'GET'
    // 前缀按路径边界匹配 `/orchestrator/api`，其余 `/orchestrator/*` 交给宿主的页面路由。
    const path = url.pathname.slice('/orchestrator/api'.length).replace(/^\//, '')
    const runtime = resolve()
    if (!runtime) {
      const { phase, detail, error, stateDir } = state()
      // 运行时尚未创建或初始化失败：健康探针返回 200，其余接口以 503 说明阶段，而不是空体 404。
      if (method === 'GET' && path === 'health') {
        json(res, 200, { ok: false, stage: phase, phase, detail, error: error ?? null, configured: false, paused: false,
          problem: null, listen: listen(), machine: { stateDir }, sources: [] })
        return
      }
      json(res, 503, { error: detail || 'dsh-superagent is not ready', code: 'startupPending', phase, detail, stateDir })
      return
    }
    try {
      await runtime.ready
      const route = match(tableFor(runtime), method, path.split('/'))
      if (!route) throw new RouteError(404, 'Unknown operation')
      const query = Object.fromEntries(url.searchParams)
      json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
    } catch (error) { json(res, ...failure(error)) }
  } })
  return () => { dispose() }
}
