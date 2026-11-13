/** dsh-superagent 的应用组合根和生命周期管理器。 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy, type Settings as SettingsSnapshot } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import { firstSource, type Deployment, type Machine } from '../deployment.ts'
import { environmentOf, executionRoot, ticketEnvironment, type Variable } from './execution-environment.ts'
import { collectWorkspaces } from './workspace-gc.ts'
import { resetState as resetStateFiles, type ResetReport } from './reset.ts'
import type { AdminMount } from './admin-mount.ts'
import type { StateLock } from './startup.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger } from '../executor/dsh.ts'
import { workerSessionId } from '../executor/format.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { SecretVault } from '../secrets/vault.ts'
import { GitCredentials } from '../git-credentials/service.ts'
import { gitProbe } from '../git-credentials/probe.ts'
import { FeishuCredentials } from '../feishu-credentials/service.ts'
import { feishuProbe } from '../feishu-credentials/probe.ts'
import { httpWikiApi, larkWikiApi, type FeishuWikiApi, type FeishuWikiReader } from '../task-sources/feishu-api.ts'
import { httpImApi, larkImApi, type FeishuImApi, type FeishuImReader } from '../task-sources/feishu-im-api.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health } from '../infra/health.ts'
import type { SourceContext, SourceHost } from '../sources/host.ts'
import type { SourceAdapter } from '../sources/kind.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { ProjectScheduler } from './scheduler.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// 来源插件仅通过 `SourceHost` 服务接口与 dsh-superagent 交互。
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * 插件入口在构造 `Runtime` 之前完成的启动步骤：管理路由已经挂载、状态目录锁已经取得。
 * 这样取锁失败不会让 `/orchestrator/api` 前缀从未注册，初始化失败也不会让它被卸载。
 */
export interface RuntimeBoot {
  readonly mount: AdminMount
  readonly lock: StateLock
}
/**
 * dsh-superagent 的组合根，连接 `Store`、`Setup`、`Engine`、`SourceRegistry`、`Effects`、`Outbox`、`Passes`、`Sessions`、`Settings`、`Prompts`、`DshExecutor` 和 `MasterAssessor`。
 * 在 Cordis 上下文中为来源插件暴露 `SourceHost` 服务，并协调启动、初始化检查、HTTP 路由注册和优雅关闭。
 * 在打开 SQLite 之前锁定状态目录，使并发进程无法破坏状态或重复迁移。
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly scheduler: ProjectScheduler
  /** 凭据材料只经过这个加密存储层，Git 与飞书各自一个区域。 */
  readonly vault: SecretVault
  readonly gitCredentials: GitCredentials
  readonly feishuCredentials: FeishuCredentials
  /** 按飞书凭据 ID 取知识库读取能力；预检与调度共用，凭据材料不经过任何视图。 */
  private feishuWikiReader?: FeishuWikiReader
  /** 按飞书凭据 ID 取群消息读取能力；任务来源预检与项目轮询共用，材料不经过任何视图。 */
  private feishuImReader?: FeishuImReader
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  private readonly workspaceHealth = this.board.claim('workspace', { state: 'starting', detail: '', category: 'workspace' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private readonly restartPlugin: () => void
  private readonly boot?: RuntimeBoot
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  private readonly loops = new Set<{ controller: AbortController; running: Promise<void> }>()
  /** 当主会话工具正在执行引擎命令时非零，用于抑制自触发的领域事件通知。 */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void, boot?: RuntimeBoot) {
    super(ctx, 'orchestrator')
    this.boot = boot
    this.restartPlugin = restart
    this.bindLock()
    // 阶段按固定顺序执行，后面的阶段读取前面阶段赋上的字段；任何一步失败都由这里统一释放数据库与状态锁。
    let opened: Store | undefined
    try {
      // ① 存储与基座：数据库、部署解析（Setup）、提示词、主会话 ID 与命令入口。
      const storage = this.openStorage()
      opened = this.store = storage.store
      this.setup = storage.setup
      this.prompts = storage.prompts
      this.masterId = storage.masterId
      this.commands = storage.commands
      // ② 凭据：加密存储、Git/飞书两域服务，以及按凭据现取的读取能力（材料不进设置快照）。
      const credentials = this.buildCredentials()
      this.vault = credentials.vault
      this.gitCredentials = credentials.gitCredentials
      this.feishuCredentials = credentials.feishuCredentials
      this.feishuWikiReader = credentials.feishuWikiReader
      this.feishuImReader = credentials.feishuImReader
      // ③ 来源与视图基座：效果队列与来源注册表，以及后续阶段共用的链接解析、工单环境与只读资源。
      const base = this.buildSources()
      this.effects = base.effects
      this.sources = base.sources
      // ④ 会话与设置：会话注册有序 relay/notice 副作用，设置做来源策略同步，执行器挂效果处理器，都必须晚于 ③。
      const rooms = this.buildSessions(base.environment, base.link)
      this.sessions = rooms.sessions
      this.settings = rooms.settings
      this.executor = rooms.executor
      // ⑤ 领域与调度：引擎的事件回调引用会话与调度器，writeback 处理器引用调度器，必须晚于 ③④。
      const domain = this.buildDomain(base.link, base.links)
      this.assessor = domain.assessor
      this.outbox = domain.outbox
      this.engine = domain.engine
      this.scheduler = domain.scheduler
      this.passes = domain.passes
      // ⑥ 来源上下文与工具宿主：读取上述全部协作者。
      this.sourceDeps = this.buildSourceDeps()
      this.toolHost = this.bindTools(base.resources)
      this.ready = this.initialize()
    } catch (error) {
      // 如果初始化失败，释放数据库和状态锁，以便进程内重启可以重新获取它们。
      try { opened?.close() } finally { void this.releaseLock?.().catch(() => { /* 释放失败只影响下次启动的等待时长。 */ }) }
      throw error
    }
  }

  /** 接管状态目录锁：插件入口已取得时补登记抢占处理；独立运行（测试）时先锁再开库。 */
  private bindLock(): void {
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message, category: 'runtime' }); this.stopped.abort() }
    if (this.boot) {
      // 锁由插件入口在管理路由挂载之后取得；这里只接收释放函数并补登记抢占处理。
      this.releaseLock = this.boot.lock.release
      this.boot.lock.onCompromised(compromised)
    } else {
      // 在打开数据库之前锁定状态目录，使其他进程无法并发迁移或写入。
      mkdirSync(this.machine.stateDir, { recursive: true, mode: 0o700 })
      const release = lockSync(this.machine.stateDir, { stale: 30_000, onCompromised: compromised })
      this.releaseLock = async () => { release() }
    }
  }

  /** 打开数据库并构造初始化基座：Setup、版本化提示词、主会话 ID 与命令入口。必须晚于 `bindLock`。 */
  private openStorage(): { store: Store; setup: Setup; prompts: Prompts; masterId: string; commands: Commands } {
    const { ctx, machine } = this
    const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
    const store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
    const setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart: this.restartPlugin,
      feishuWiki: credential => this.wikiOf(credential), feishuIm: credential => this.imOf(credential),
      gitCredential: id => this.gitCredentials.metaOf(id), gitAuth: id => this.gitCredentials.authOf(id),
      commands: repoId => this.commands.scope(repoId) })
    const deployed = () => setup.configured()
      ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
    const feishu = () => setup.configured() && !!firstSource(setup.deployment, 'feishu')
    const prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
    const masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
    store.set(KV.runtime.masterId, masterId)
    const commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
    return { store, setup, prompts, masterId, commands }
  }

  /** 构造加密存储与两域凭据服务，以及按凭据现取的飞书知识库/群消息读取能力。必须晚于 `openStorage`。 */
  private buildCredentials(): { vault: SecretVault; gitCredentials: GitCredentials; feishuCredentials: FeishuCredentials;
    feishuWikiReader: FeishuWikiReader; feishuImReader: FeishuImReader } {
    const { store, setup, commands, machine } = this
    // 凭据记录与项目引用相互独立：项目只保存记录 ID，材料永远不进入设置快照。
    const vault = new SecretVault(machine.stateDir)
    const projects = () => store.settings().projects
    const gitCredentials = new GitCredentials({ credentials: store.gitCredentials, vault, projects, probe: gitProbe(commands, vault) })
    const feishuCredentials = new FeishuCredentials({ credentials: store.feishuCredentials, vault,
      references: () => feishuCredentialReferences(store.settings()), probe: feishuProbe(commands) })
    /** 凭据的调用方式：CLI 身份用可执行文件，应用身份用 appId 与密钥；材料只在这里短暂读取。 */
    const feishuApi = (credential: string): { cli: string } | { appId: string; secret: string } | undefined => {
      const record = store.feishuCredentials.get(credential)
      if (!record) return undefined
      if (record.mode === 'cli') return { cli: record.cli.trim() || 'lark' }
      const secret = feishuCredentials.material(credential)?.appSecret
      return record.appId && secret ? { appId: record.appId, secret } : undefined
    }
    /** CLI 身份调用：以机器人身份、JSON 输出，失败时把业务码并进消息。 */
    const larkCall = (cli: string) => async (args: string[]): Promise<unknown> => {
      const output = await commands.run(cli, [...args, '--as', 'bot', '--format', 'json'], machine.stateDir)
      const result = JSON.parse(output) as { ok: boolean; data: unknown; error?: { code?: number; message?: string } }
      if (!result.ok) throw new Error(`${result.error?.message ?? 'Feishu command failed'}${result.error?.code ? ` (${result.error.code})` : ''}`)
      return result.data
    }
    // 凭据材料只在读取知识库或群消息时短暂进入内存；两种能力共用同一份凭据解析。
    const feishuWikiReader: FeishuWikiReader = async credential => {
      const api = feishuApi(credential)
      if (!api) return undefined
      return 'cli' in api ? larkWikiApi(larkCall(api.cli)) : httpWikiApi(api.appId, api.secret, this.lifetime)
    }
    const feishuImReader: FeishuImReader = async credential => {
      const api = feishuApi(credential)
      if (!api) return undefined
      return 'cli' in api ? larkImApi(larkCall(api.cli)) : httpImApi(api.appId, api.secret, this.lifetime)
    }
    return { vault, gitCredentials, feishuCredentials, feishuWikiReader, feishuImReader }
  }

  /** 构造效果队列与来源注册表，以及后续阶段共用的链接解析、工单环境与只读资源。必须晚于 `buildCredentials`。 */
  private buildSources() {
    const { store, board } = this
    const effects = new Effects(store, board)
    const sources = new SourceRegistry(() => store.settings(), board, kind => {
      // 当来源插件动态加载时，在启动完成后同步一次来源成员列表。
      if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
        .catch(() => { /* sync() 会把失败记录到健康状态中。 */ })
      return () => {}
    })
    const links: LinkHost = { store, links: this.sourceLinks, commands: this.commands, sources, lifetime: this.lifetime }
    const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
    const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
    const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts: this.prompts, commands: this.commands,
      masterId: this.masterId, context: this.ctx,
      promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
      feishuPageSize: source => feishuSettings(sources, source).readPageSize, sourceLink: link }
    return { effects, sources, links, link, environment, resources }
  }

  /** 构造会话管理器、设置服务与执行器；执行器经惰性 getter 回读稍后装配的引擎。必须晚于 `buildSources`。 */
  private buildSessions(environment: (ticket: Ticket) => Variable[], link: (trigger: Trigger, signal?: AbortSignal) => Promise<{ source_url?: string; source_url_read?: string }>) {
    const runtime = this
    const sessions = new Sessions({ context: this.ctx, store: this.store, prompts: this.prompts, effects: this.effects,
      health: this.board.claim('models'), masterId: this.masterId, lifetime: this.lifetime,
      closing: () => this.closing(), environment,
      tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
    const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
    const stopTicket: EngineForSettings['stopTicket'] = (id, reason) => this.engine.stopTicket(id, reason)
    const settings = new Settings({ store: this.store, sources: this.sources, engine: { policyChanged, stopTicket }, health: this.board,
      context: this.ctx, lifetime: this.lifetime, sessions, sourceHost: this, setup: this.setup,
      requestPass: () => { this.passes.request() } })
    const executor = new DshExecutor({ context: this.ctx, get engine() { return runtime.engine }, store: this.store, effects: this.effects,
      commands: this.commands, health: this.board.claim('worker'), machine: this.machine,
      lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
      repliedTo: trigger => repliedTo({ store: this.store, sources: this.sources }, trigger) })
    return { sessions, settings, executor }
  }

  /** 构造评估器、出站发件箱、引擎、项目调度器与编排轮次；引擎回调把领域事件转给主会话与调度器。必须晚于 `buildSessions`。 */
  private buildDomain(link: (trigger: Trigger, signal?: AbortSignal) => Promise<{ source_url?: string; source_url_read?: string }>, links: LinkHost) {
    const runtime = this
    const { store, board } = this
    const assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands: this.commands,
      get deployment() { return runtime.setup.deployment }, effects: this.effects,
      settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => this.sources.threadContext(trigger),
      deliver: (id, text) => this.sessions.prompt(this.masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
    const outbox = new Outbox({ store, effects: this.effects, sources: this.sources, commands: this.commands, paused: () => this.paused() })
    const executor = this.executor
    const policy = () => settingsPolicy(store.settings(), this.sources)
    const engine = new Engine({ repo: store, scope: this.sources, policy, assessor, executor,
      outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
        // 仅向主会话通知并非由其自身发起的领域事件。
        const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
        if (notice) this.sessions.notify(...notice)
        // 到达未结束工单的人的消息属于该工单；主会话会在同一事务中得知，
        // 对于已结束工单则在恢复后得知，除非是主会话自己将消息路由到那里。
        const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
        const followup = followed ? followupNotice(store, this.sources, event.data.triggerId) : undefined
        if (followup) this.sessions.relay(followup.id, followup.text)
        // 项目调度按工单终态更新队列；失败重排与回写在调度器内完成。
        if (event.type === 'ticket.ended') this.scheduler.observe(event.data.ticketId)
      } })
    // 调度与工作区回收共用健康看板：错误按 `schedule` / `workspace` 分类暴露给面板。
    const scheduleHealth = board.claim('schedule', { state: 'starting', detail: '', category: 'schedule' })
    const scheduler = new ProjectScheduler({ store, settings: () => store.settings(),
      engine: { schedule: input => engine.schedule(input), stopTicket: (id, reason) => engine.stopTicket(id, reason) },
      executor: { slotsInUse: () => executor.slotsInUse(), projectsInUse: () => executor.projectsInUse() },
      effects: this.effects, commands: this.commands, stateDir: this.machine.stateDir, lifetime: this.lifetime,
      feishuWiki: credential => this.wikiOf(credential),
      feishuIm: credential => this.imOf(credential), gitAuth: id => this.gitCredentials.authOf(id),
      health: scheduleHealth, collectWorkspaces: () => this.reclaimWorkspaces() })
    // 回写是持久化副作用：失败按退避重试，状态进入 `effects` 健康条目；项目已被删除时不静默丢弃。
    this.effects.handle('writeback', payload => this.scheduler.writeBackNow(payload), { retry: [5_000, 600_000] })
    // 若过去一小时内曾出现评估因不可用而失败，则在每次轮次更新 `evals` 健康条目。
    const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
    const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
    const passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects: this.effects,
      health: this.runtimeHealth, lifetime: this.lifetime, configured: () => this.setup.configured(), closing: () => this.closing() })
    return { assessor, outbox, engine, scheduler, passes }
  }

  /** 每来源记录的作用域上下文读取引擎、发件箱与命令入口；惰性字段等待启动完成。必须晚于 `buildDomain`。 */
  private buildSourceDeps(): SourceContextDeps {
    const runtime = this
    return { store: this.store, engine: this.engine, outbox: this.outbox, commands: this.commands, sources: this.sources,
      stateDir: this.machine.stateDir, get ready() { return runtime.ready },
      get deployment() { return runtime.setup.deployment }, configured: () => this.setup.configured(),
      get sourceProblems() { return runtime.setup.sourceProblems }, receive: trigger => this.passes.receive(trigger) }
  }

  /** 主会话与执行器会话的工具宿主；`quietly` 抑制自触发领域事件的通知。必须晚于 `buildDomain`。 */
  private bindTools(resources: ResourceHost): MainToolsHost & ExecutorToolsHost {
    return { context: this.ctx, engine: this.engine, store: this.store, prompts: this.prompts, sessions: this.sessions,
      settings: this.settings, assessor: this.assessor, resources,
      requestPass: () => { this.passes.request() }, sendReplies: () => this.outbox.sent(),
      quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** dsh-superagent 停止或失去状态目录锁时触发中止，取消正在运行的读取和子进程。 */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }, id: string): SourceContext { return sourceContextOf(this.sourceDeps, kind, id) }
  /**
   * 注册内置来源适配器，并为每条来源记录启动一个独立循环。
   * 记录之间存在类型隔离：同类型多条记录各自解析配置、各自报告健康状态。
   */
  startSources(adapters: readonly SourceAdapter[]): void {
    for (const adapter of adapters) {
      if (!this.sources.kindsList().some(kind => kind.kind === adapter.kind.kind)) this.sources.register(adapter.kind)
    }
    this.sources.syncHealth()
    for (const instance of this.sources.instances()) {
      const adapter = adapters.find(item => item.kind.kind === instance.kind)
      if (!adapter) continue
      const controller = new AbortController()
      const loop = { controller, running: adapter.watch(this, instance.id, controller.signal) }
      this.loops.add(loop)
      void loop.running.finally(() => this.loops.delete(loop))
    }
  }
  /** 已解析的部署；在等待初始化期间（`!configured()`）抛出异常。 */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** 按来源记录 ID 索引的部署校验问题；单条记录失败只暂停该记录。 */
  get sourceProblems(): Readonly<Record<string, SetupProblem>> { return this.setup.sourceProblems }
  /** 视图层按类型汇总的第一条记录问题；面板按记录展示问题由 `sourceProblems` 提供。 */
  private problemOfKind(kind: string): SetupProblem | undefined {
    const settings = this.store.settings()
    for (const [id, problem] of Object.entries(this.setup.sourceProblems)) if (settings.sources[id]?.kind === kind) return problem
    return undefined
  }
  get feishuProblem(): SetupProblem | undefined { return this.problemOfKind('feishu') }
  /** 按记录 ID 排序的第一条记录问题；概览用它说明某个来源为何没有启动。 */
  get sourceProblem(): SetupProblem | undefined {
    const [first] = Object.keys(this.setup.sourceProblems).sort()
    return first === undefined ? undefined : this.setup.sourceProblems[first]
  }
  links(): LinkTarget {
    const sources = this.setup.configured() ? this.setup.deployment.sources : {}
    return channel => {
      const source = sources[channel.source]
      return this.sources.link(channel, source?.kind === 'github' ? { github: source } : source?.kind === 'feishu' ? { feishu: source }
        : source?.kind === 'gitlab' ? { gitlab: source } : {})
    }
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** 飞书知识库读取能力：按凭据现取，轮换或删除后下一次读取自然生效。 */
  private async wikiOf(credential: string): Promise<FeishuWikiApi | undefined> {
    return this.feishuWikiReader?.(credential)
  }
  /** 飞书群消息读取能力：按凭据现取，轮换或删除后下一次读取自然生效。 */
  private async imOf(credential: string): Promise<FeishuImApi | undefined> {
    return this.feishuImReader?.(credential)
  }
  /** 在暂停或等待初始化期间暂缓评估、调度和出站投递；来源仍会记录传入的触发器。 */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // 管理路由由插件入口先挂载并按启动阶段报告；独立运行时（测试）没有挂载点时仍自行注册。
    if (this.boot) this.boot.mount.attach(this.httpHost())
    else this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now(), category: 'runtime' })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() 会把失败记录到健康状态中。 */ })
    // 若在等待初始化、创建会话或策略同步期间调用了 stop()，则不要启动后台循环。
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.scheduler.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now(), category: 'runtime' })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      gitCredentials: this.gitCredentials, feishuCredentials: this.feishuCredentials,
      queue: (query?: { offset: number; limit: number }) => this.scheduler.snapshot(query?.offset, query?.limit),
      projectQueue: id => this.scheduler.projectQueue(id),
      retryQueue: id => this.scheduler.retryEntry(id),
      cancelQueue: id => this.scheduler.cancelEntry(id),
      clearQueue: project => this.scheduler.clearQueue(project),
      forgetProject: id => this.scheduler.forget(id),
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get sourceProblems() { return setup.sourceProblems }, get sourceProblem() { return runtime.sourceProblem },
      get feishuProblem() { return runtime.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() },
      checkSource: (kind, config, field, meta) => setup.checkSource(kind, config, field, sources, meta),
      checkCodeRepo: (kind, config, field, meta) => setup.checkCodeRepo(kind, config, field, meta),
      listCodeRepoBranches: (kind, config, gitCredential) => setup.listCodeRepoBranches(kind, config, gitCredential ?? ''),
      checkTaskSource: (kind, config, field, meta) => setup.checkTaskSource(kind, config, field, meta),
      feishuImChats: async credential => (await this.feishuImReader?.(credential))?.chats() ?? [],
      requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog(),
      reset: () => runtime.reset() }
  }
  /** 回收过期的工单执行目录，并把结果写入 `workspace` 健康条目；与运行中任务互斥由工单结束时间保证。 */
  private async reclaimWorkspaces(): Promise<void> {
    const report = await collectWorkspaces({ tickets: this.store.tickets,
      workRoot: executionRoot(this.store.settings(), this.machine.stateDir),
      retentionMs: this.machine.workspaceRetentionDays.get() * 86_400_000 })
    const detail = report.disabled ? 'Workspace reclaim is disabled'
      : `${report.removed.length} reclaimed, ${report.kept} kept, ${report.unknown} unknown, ${report.scanned} scanned`
        + (report.errors.length ? `; ${report.errors.join('; ')}` : '')
    this.workspaceHealth.set({ state: report.errors.length ? 'error' : 'ready', detail, at: report.at, category: 'workspace' })
  }
  /**
   * 重置状态目录：先停止运行时（关闭数据库并释放锁），备份后清空插件拥有的条目，再重启插件。
   * 重启在 `finally` 中执行，使重置失败时服务仍能带着原（或已恢复的）状态回来。
   */
  async reset(): Promise<ResetReport> {
    await this.stop()
    try {
      return await resetStateFiles({ stateDir: this.machine.stateDir })
    } finally {
      this.restartPlugin()
    }
  }
  /** 幂等停止；并发或重复调用共享同一个关闭 Promise。 */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; this.scheduler.stop(); const passes = this.passes.stop(); this.stopped.abort()
    const loops = [...this.loops]
    for (const loop of loops) loop.controller.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle()), ...loops.map(loop => loop.running)])
      // 执行器的任务和子代理也会停止：它们的结束会启动执行器轮次，而下面释放的工具限制届时尚未生效。
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // 在释放目录锁之前关闭数据库，使其他进程无法在写入中途打开数据库；已失效的锁可能已经释放。
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}

/** 收集项目引用的飞书凭据 ID；删除凭据时按它统计引用。 */
export function feishuCredentialReferences(settings: SettingsSnapshot): string[] {
  return Object.values(settings.projects).flatMap(project => project.feishuCredential ? [project.feishuCredential] : [])
}
