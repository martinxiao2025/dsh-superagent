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
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import { firstSource, type Deployment, type Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
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
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import type { SourceAdapter } from '../sources/kind.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// 来源插件仅通过 `SourceHost` 服务接口与 dsh-superagent 交互。
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

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
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  private readonly loops = new Set<{ controller: AbortController; running: Promise<void> }>()
  /** 当主会话工具正在执行引擎命令时非零，用于抑制自触发的领域事件通知。 */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // 在打开数据库之前锁定状态目录，使其他进程无法并发迁移或写入。
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!firstSource(setup.deployment, 'feishu')
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // 当来源插件动态加载时，在启动完成后同步一次来源成员列表。
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() 会把失败记录到健康状态中。 */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // 仅向主会话通知并非由其自身发起的领域事件。
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // 到达未结束工单的人的消息属于该工单；主会话会在同一事务中得知，
          // 对于已结束工单则在恢复后得知，除非是主会话自己将消息路由到那里。
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // 当工单通过拉取请求结束时，通知该工单的所有会话。
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.sources)) outbox.send(message)
          }
        } })
      // 若过去一小时内曾出现评估因不可用而失败，则在每次轮次更新 `evals` 健康条目。
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get sourceProblems() { return setup.sourceProblems }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }, runtime.sources.instances().find(item => item.kind === 'github')?.id ?? '') },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // 如果初始化失败，释放数据库和状态锁，以便进程内重启可以重新获取它们。
      try { opened?.close() } finally { release() }
      throw error
    }
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
  get gitlabProblem(): SetupProblem | undefined { return this.problemOfKind('gitlab') }
  /** 按记录 ID 排序的第一条记录问题；概览用它说明某个来源为何没有启动。 */
  get sourceProblem(): SetupProblem | undefined {
    const [first] = Object.keys(this.setup.sourceProblems).sort()
    return first === undefined ? undefined : this.setup.sourceProblems[first]
  }
  links(): LinkTarget {
    const sources = this.setup.configured() ? this.setup.deployment.sources : {}
    return channel => {
      const source = sources[channel.source]
      return this.sources.link(channel, source?.kind === 'github' ? { repository: source.repository } : source?.kind === 'feishu' ? { feishu: source }
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
  /** 在暂停或等待初始化期间暂缓评估、调度和出站投递；来源仍会记录传入的触发器。 */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // 在初始化完成前注册管理 HTTP 路由，使操作者可以在界面中修复初始化问题。
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
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
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get sourceProblems() { return setup.sourceProblems }, get sourceProblem() { return runtime.sourceProblem },
      get feishuProblem() { return runtime.feishuProblem }, get gitlabProblem() { return runtime.gitlabProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** 幂等停止；并发或重复调用共享同一个关闭 Promise。 */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
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
