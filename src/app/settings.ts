/** 按块作用域的设置校验、乐观并发保存、处理暂停控制，以及来源策略同步。 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { LIMITS } from '../limits.ts'
import { UserError, type EngineForSettings, type Ticket, type UserErrorCode } from '../core/index.ts'
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema, policyEffects, policyVersion } from '../policy.ts'
import type { Settings as SettingsValue, SettingsBlock, SettingsOrigin, SettingsSave } from '../policy.ts'
import { ProjectSchema, type Project } from '../projects/kind.ts'
import { codeRepoType } from '../code-repos/types.ts'
import { taskSourceKnowledgeBase, taskSources } from '../task-sources/index.ts'
import type { SourceHost } from '../sources/host.ts'
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { resolveRoleModel } from './role-models.ts'
import { changedPaths, settingsNotice } from './notices.ts'
import type { Sessions } from './sessions.ts'
import { setupChanged, type Setup } from './setup.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'

/**
 * 表示按过时修订保存或同步设置块时发生的乐观并发冲突。
 * 由 `Settings.save` 和 `Settings.sync` 抛出，管理路由会将其转换为 HTTP 409 响应。
 */
export class SettingsConflict extends Error {}
const now = (): string => new Date().toISOString()
/** 控制 shell 执行路径、准备命令和命令 shim 的执行器设置。 */
const environment = ({ executor }: SettingsValue) => JSON.stringify([executor.directory, executor.prepare, executor.blockedCommands])

/** 单个设置块类型的模式解析器、设置合并器和非面板来源守卫。 */
interface Block {
  parse(value: unknown, sources: SourceRegistry, id: string): unknown
  merge(settings: SettingsValue, value: unknown, id: string): SettingsValue
  guard?(current: SettingsValue, candidate: SettingsValue, origin: SettingsOrigin): void
}
const BLOCKS: Record<'policy' | 'eval' | 'executor' | 'source' | 'project', Block> = {
  policy: {
    parse: (value, sources) => {
      const policy = PolicyConfigSchema.parse(value)
      return { ...policy, sources: sources.validatePolicy(policy.sources) }
    },
    merge: (settings, value) => ({ ...settings, policy: value as SettingsValue['policy'] }),
  },
  eval: { parse: value => EvalConfigSchema.parse(value), merge: (settings, value) => ({ ...settings, eval: value as SettingsValue['eval'] }) },
  executor: {
    parse: value => ExecutorConfigSchema.parse(value),
    merge: (settings, value) => ({ ...settings, executor: value as SettingsValue['executor'] }),
    // 只有管理面板可以修改 shell 执行路径或命令。
    guard: (current, candidate, origin) => { if (origin !== 'panel' && environment(current) !== environment(candidate)) throw new UserError('panelOnlyEnvironment') },
  },
  source: {
    parse: (value, sources, id) => sources.validate(id, z.object({
      name: z.string().trim().min(1).max(LIMITS.sourceName), enabled: z.boolean(), config: z.unknown() }).parse(value)),
    // 记录的类型不可通过设置块修改：保存开关与配置时保留已存储的 `kind`。
    merge: (settings, value, id) => ({ ...settings, sources: { ...settings.sources, [id]: { ...settings.sources[id]!, ...value as object } } }),
    // 只有管理面板可以切换来源账户。
    guard: (current, candidate, origin) => { if (origin !== 'panel' && setupChanged(current, candidate)) throw new UserError('panelOnlyAccounts') },
  },
  project: {
    parse: value => parseProject(value),
    merge: (settings, value, id) => ({ ...settings, projects: { ...settings.projects, [id]: value as SettingsValue['projects'][string] } }),
  },
}

/** 校验项目的内嵌仓库与任务来源：类型必须存在，配置交给对应 schema，避免把非法配置写进设置。 */
function parseProject(value: unknown): Project {
  const project = ProjectSchema.parse(value)
  const repoType = codeRepoType(project.codeRepo.kind)
  if (!repoType) throw new UserError('sourceKindUnknown', { kind: project.codeRepo.kind })
  const driver = taskSources.kind(project.taskSource.kind)
  if (!driver) throw new UserError('sourceKindUnknown', { kind: project.taskSource.kind })
  return { ...project,
    codeRepo: { ...project.codeRepo, config: repoType.schema.parse(project.codeRepo.config) as Record<string, unknown> },
    taskSource: { ...project.taskSource, config: driver.schema.parse(project.taskSource.config) as Record<string, unknown> } }
}

/** 项目任务来源声明的知识空间范围；未声明或字段为空时返回空串。 */
function projectSpace(project: Project): string {
  return taskSourceKnowledgeBase({ kind: project.taskSource.kind, name: project.name,
    enabled: project.enabled, config: project.taskSource.config })
}

/** `Settings` 使用的宿主依赖。 */
export interface SettingsHost {
  readonly store: Pick<Store, 'settings' | 'saveSettings' | 'blockRevision' | 'atomic' | 'tickets' | 'triggers' | 'get'>
  readonly sources: SourceRegistry
  /** 当设置保存改变策略版本时收到通知。 */
  readonly engine: EngineForSettings
  /** 健康看板，每个来源的策略同步会在 `sync:<id>` 下报告。 */
  readonly health: Pick<HealthBoard, 'claim'>
  /** 用于校验和解析角色模型的 DSH Cordis 上下文。 */
  readonly context: Context
  readonly lifetime: AbortSignal
  /** 会话管理器，通过它把已保存的设置通知给主会话。 */
  readonly sessions: Pick<Sessions, 'notify' | 'delivery'>
  /** 传递给来源类型的策略同步和标签刷新的来源宿主。 */
  readonly sourceHost: SourceHost
  /** 初始化状态、账户/命令校验，以及初始化读取字段变化时触发重启。 */
  readonly setup: Pick<Setup, 'configured' | 'checkAccounts' | 'blockCommands' | 'restart'>
  /** 触发一次即时轮次，使设置保存后新获允许的工作立即运行。 */
  requestPass(): void
}

/**
 * 在 `Store` 中校验并持久化按块作用域的设置，执行来源守卫，并管理来源策略同步与标签刷新。
 * `Runtime`、管理 HTTP 路由和主会话工具都通过它读取和保存设置。
 * 当策略版本变化时通知 `Engine`，通过 `Sessions` 通知主会话，并在保存的设置生效时触发 `Setup` 重启或 `Passes` 轮次。
 * 在 `HealthBoard` 中跟踪各来源的同步状态，并以指数退避重试失败的同步。
 */
export class Settings {
  /** 各来源的 `sync:<id>` 健康条目，在每个来源首次策略同步时惰性认领。 */
  private readonly syncs = new Map<string, HealthEntry>()
  /** 同步失败后，各来源待处理的指数退避重试计时器和上次等待时长（毫秒）。 */
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>()
  constructor(private readonly host: SettingsHost) {
    host.lifetime.addEventListener('abort', () => { for (const { timer } of this.retries.values()) clearTimeout(timer) }, { once: true })
  }
  /** 来源同步失败后安排指数退避重试（1 分钟至 1 小时）；成功时清除待处理的重试。 */
  private retrySync(id: string, failed: boolean): void {
    const previous = this.retries.get(id)
    if (previous) clearTimeout(previous.timer)
    this.retries.delete(id)
    if (!failed || this.host.lifetime.aborted) return
    const wait = previous ? Math.min(previous.wait * 2, 3_600_000) : 60_000
    const timer = setTimeout(() => { this.sync(id).catch(() => { /* sync() 会把失败记录到健康状态中。 */ }) }, wait)
    timer.unref?.()
    this.retries.set(id, { timer, wait })
  }
  private syncHealth(id: string): HealthEntry {
    let entry = this.syncs.get(id)
    if (!entry) this.syncs.set(id, entry = this.host.health.claim(`sync:${id}`))
    return entry
  }
  /** 从 `Store` 返回当前已校验的设置。 */
  current(): SettingsValue { return this.host.store.settings() }
  /**
   * 返回所有设置块及其当前块修订的概览：`pause`、`eval` 和
   * `executor` 的完整值；`policy` 的规则摘要和允许发送者计数；消息来源实例；
   * 以及代码仓库、任务来源与项目的记录摘要（完整块读取使用 `read: 'settings/<block>'` 路径）。
   */
  view() {
    const { store, sources } = this.host
    const settings = store.settings(), revision = (block: SettingsSave) => store.blockRevision(block)
    const { rules, sources: parts } = settings.policy
    return { revision: store.get(KV.settings.revision) ?? 0,
      pause: { revision: revision('pause'), value: { paused: settings.paused } },
      eval: { revision: revision('eval'), value: settings.eval },
      executor: { revision: revision('executor'), value: settings.executor },
      policy: { revision: revision('policy'), rules: rules.map(rule => ({ id: rule.id, name: rule.name, enabled: rule.enabled })),
        allowed: Object.fromEntries(Object.entries(parts).map(([id, part]) => [id, part.allowed.length])), read: 'settings/policy' },
      sources: sources.instances(settings).map(({ id, kind, name, enabled, installed }) =>
        ({ id, kind, name, enabled, installed, revision: revision(`source:${id}`), read: `settings/source:${id}` })),
      projects: Object.entries(settings.projects).map(([id, project]) => ({ id, name: project.name, enabled: project.enabled,
        codeRepo: project.codeRepo.kind, taskSource: project.taskSource.kind, revision: revision(`project:${id}`), read: `settings/project:${id}` })) }
  }
  /**
   * 返回 `save` 可接受的一个设置块（`policy`、`eval`、`executor`，持有 `{ paused }` 的 `pause`，
   * 持有 `{ name, enabled, config }` 的 `source:<id>`，或完整项目值的 `project:<id>`）及其当前块修订。
   * 代码仓库与任务来源随项目保存，不再有独立块。
   * @throws 当不存在该设置块时抛出 UserError（`unknownBlock`）。
   */
  block(block: string): { block: string; revision: number; value: unknown } {
    const { store, sources } = this.host
    const settings = store.settings(), [family, id] = block.includes(':') ? block.split(/:(.*)/s) : [block, '']
    const instance = family === 'source' ? sources.instances(settings).find(item => item.id === id) : undefined
    const project = family === 'project' ? settings.projects[id!] : undefined
    const value = block === 'pause' ? { paused: settings.paused } : block === 'policy' || block === 'eval' || block === 'executor' ? settings[block]
      : instance ? { name: instance.name, enabled: instance.enabled, config: instance.config }
        : project ?? undefined
    if (value === undefined) throw new UserError('unknownBlock', { block })
    return { block, revision: store.blockRevision(block as SettingsSave), value }
  }
  /**
   * 按 `revision` 校验并保存一个设置块；无实际变化的保存不记录新修订，策略
   * 版本变化会通知受影响的未结束工单，而修改初始化读取字段（`SETUP_FIELDS`，如账户 CLI）或
   * 在等待初始化期间保存任何变更（`!this.host.setup.configured()`）都会重启 `dsh-superagent`，使初始化再次运行。
   * @param origin - 调用方来源；将执行环境和账户 CLI 变更限制为 `'panel'`（这是针对提示词注入式工具调用的防护栏，而不是操作系统安全边界，因为智能体会运行 shell 命令；`origin` 没有默认值，因此没有调用方会隐式获得面板权限）。
   * @returns 保存结果，包含该块当前的 `revision`、`policy_changed`、`restarting` 以及 `context_delivery` 状态（`'injected'` 或 `'pending'`）。
   * @throws 当 `block` 的修订在校验检查之前或期间发生变化时抛出 SettingsConflict。
   * @throws 当 `block` 未知、来源未安装、`value` 无效（例如 `executor` 块携带只有 `pause` 才设置的 `paused`）、非面板 `origin` 修改仅面板字段，或角色模型/账户校验失败时抛出 UserError | z.ZodError。
   */
  async save(block: SettingsBlock, value: unknown, revision: number, origin: SettingsOrigin) {
    const { store, sources, engine, sessions } = this.host
    const stale = () => revision !== store.blockRevision(block)
    if (stale()) throw new SettingsConflict('Settings changed. Reload before saving.')
    const [kind, id] = block.includes(':') ? block.split(/:(.*)/s) as [string, string] : [block, block]
    if (!(kind in BLOCKS)) throw new UserError('unknownBlock', { block })
    const rules = BLOCKS[kind as keyof typeof BLOCKS]
    const stored = store.settings()
    if (kind === 'source' && !sources.record(id)) throw new UserError('sourceNotInstalled', { source: id })
    if (kind === 'project' && !stored.projects[id]) throw new UserError('projectNotInstalled', { project: id })
    const parsed = rules.parse(value, sources, id)
    const current = stored
    // 停用一条正在工作的记录会结束它名下未完成工单，而不是让它们失去来源后悬挂。
    const disabling = kind === 'source' && current.sources[id]?.enabled !== false && !(parsed as { enabled: boolean }).enabled
    const candidate = rules.merge(current, parsed, id)
    const model = block === 'eval' ? candidate.eval.model : block === 'executor' ? candidate.executor.model : null
    const previous = block === 'eval' ? current.eval.model : block === 'executor' ? current.executor.model : null
    if (model && JSON.stringify(model) !== JSON.stringify(previous)) {
      try { await resolveRoleModel(this.host.context, model) }
      catch (error) { throw new UserError('modelUnavailable', { block, error: error instanceof Error ? error.message : String(error) }) }
    }
    rules.guard?.(current, candidate, origin)
    if (kind === 'project') this.checkKnowledgeOwner(candidate, id)
    if (setupChanged(current, candidate)) await this.host.setup.checkAccounts(block, candidate)
    if (stale()) throw new SettingsConflict('Settings changed during the checks. Reload before saving.')
    // 异步检查后重新读取当前设置，以防无关块被并发保存。
    const old = store.settings()
    const settings = rules.merge(old, parsed, id)
    if (JSON.stringify(SettingsSchema.parse(settings)) === JSON.stringify(old)) {
      const delivery = await sessions.delivery(`settings:${block}`)
      return { saved: true, revision: store.blockRevision(block), policy_changed: false, restarting: false, context_delivery: delivery,
        stopped: 0 }
    }
    const restarting = setupChanged(old, settings) || !this.host.setup.configured()
    const before = policyVersion(old), after = policyVersion(settings)
    const scope = (version: SettingsValue) => ({
      scope: (input: { source: string; meta: Record<string, unknown> }) => this.host.sources.scope(input, version) })
    const effects = before === after ? new Map() : policyEffects(store.tickets.open(), old, SettingsSchema.parse(settings), scope)
    const notified = [...effects.keys()]
    store.atomic(() => {
      store.saveSettings(SettingsSchema.parse(settings), { source: origin, block, policyVersion: after, policyChanged: before !== after, notified })
      if (origin !== 'tool') sessions.notify(...settingsNotice(block, changedPaths(old, settings)))
      if (before !== after) engine.policyChanged(before, after, effects)
    })
    // 当 `blockedCommands` 变化时立即重写执行器命令 shim。
    const blocked = settings.executor.blockedCommands
    const changed = blocked.join(' ') !== old.executor.blockedCommands.join(' ')
    if (changed) await this.host.setup.blockCommands(blocked)
    // 停用记录后结束其名下工单；这一动作写入工单历史（原因 `source_disabled`），面板与日志可查。
    const stopped = disabling ? this.stopTickets(id) : 0
    // 重启时，通知会保持待处理状态直到重启之后；`setup.restart()` 会延迟到本次调用返回后执行。
    const delivery = restarting ? 'pending' : await sessions.delivery(`settings:${block}`)
    if (restarting) this.host.setup.restart()
    else this.host.requestPass()
    return { saved: true, revision: store.blockRevision(block), policy_changed: before !== after, restarting, context_delivery: delivery,
      stopped }
  }
  /** 主触发来源属于记录 `id` 的未结束工单；用于删除保护与停用后的收尾。 */
  openTickets(id: string): Ticket[] {
    const { store } = this.host
    return store.tickets.open().filter(ticket => store.triggers.get(ticket.origin.triggerId)?.source === id)
  }
  /**
   * 结束记录 `id` 名下的全部未结束工单，原因记为 `source_disabled`。
   * 并发的结束可能已经关闭其中某个工单，此时跳过。
   * @returns 实际结束的工单数量。
   */
  private stopTickets(id: string): number {
    let stopped = 0
    for (const ticket of this.openTickets(id)) {
      try { this.host.engine.stopTicket(ticket.id, 'source_disabled'); stopped++ }
      catch { /* 工单已在别处结束。 */ }
    }
    return stopped
  }
  /**
   * 用插件提供的类型创建一个来源记录并重启使配置生效。
   * 未提供 `id` 时按 `kind`、`kind-2`… 生成；显式 `id` 已存在时拒绝。
   * `name` 是面板显示的项目名称，必填。
   * @returns 新记录的 ID、当前修订和重启标记。
   * @throws 当类型未安装（`sourceKindUnknown`）、显式 ID 冲突（`sourceExists`）或配置无效（ZodError）时抛出。
   */
  async createSource(kind: string, id: string | undefined, config: unknown, origin: SettingsOrigin, name: string) {
    const { store, sources, sessions } = this.host
    const spec = sources.kindByName(kind)
    if (!spec) throw new UserError('sourceKindUnknown', { kind })
    const current = store.settings()
    let recordId = id ?? kind
    if (current.sources[recordId]) {
      if (id !== undefined) throw new UserError('sourceExists', { source: recordId })
      let suffix = 2
      while (current.sources[`${kind}-${suffix}`]) suffix++
      recordId = `${kind}-${suffix}`
    }
    const parsed = spec.schema.parse(config ?? {})
    const settings = SettingsSchema.parse({ ...current,
      sources: { ...current.sources, [recordId]: { kind, name, enabled: true, config: parsed } } })
    const block: SettingsSave = `source:${recordId}`
    store.atomic(() => {
      store.saveSettings(settings, { source: origin, block, policyVersion: policyVersion(current), policyChanged: false, notified: [] })
      if (origin !== 'tool') sessions.notify(...settingsNotice(block, changedPaths(current, settings)))
    })
    sources.syncHealth(settings)
    await sessions.delivery(`settings:${block}`)
    this.host.setup.restart()
    return { id: recordId, revision: store.blockRevision(block), restarting: true as const }
  }
  /**
   * 删除一条来源记录：移除记录与其策略部分、释放健康项和同步重试，并重启使轮询停止。
   * 仍有未结束工单时拒绝，避免留下没有来源的工单。
   * @returns 删除完成并等待重启的标记。
   * @throws 当记录不存在（`sourceNotInstalled`）或仍有未结束工单（`sourceInUse`）时抛出。
   */
  async removeSource(id: string, origin: SettingsOrigin) {
    const { store, sources, engine, sessions } = this.host
    const current = store.settings()
    if (!current.sources[id]) throw new UserError('sourceNotInstalled', { source: id })
    const open = this.openTickets(id)
    if (open.length) throw new UserError('sourceInUse', { source: id, count: String(open.length) })
    const { [id]: _record, ...restSources } = current.sources
    const { [id]: _part, ...restParts } = current.policy.sources
    const settings = SettingsSchema.parse({ ...current, sources: restSources, policy: { ...current.policy, sources: restParts } })
    const block: SettingsSave = `source:${id}`
    const before = policyVersion(current), after = policyVersion(settings)
    const scope = (version: SettingsValue) => ({
      scope: (input: { source: string; meta: Record<string, unknown> }) => this.host.sources.scope(input, version) })
    const effects = before === after ? new Map() : policyEffects(store.tickets.open(), current, settings, scope)
    const notified = [...effects.keys()]
    store.atomic(() => {
      store.saveSettings(settings, { source: origin, block, policyVersion: after, policyChanged: before !== after, notified })
      if (origin !== 'tool') sessions.notify(...settingsNotice(block, changedPaths(current, settings)))
      if (before !== after) engine.policyChanged(before, after, effects)
    })
    this.releaseSource(id)
    sources.syncHealth(settings)
    await sessions.delivery(`settings:${block}`)
    this.host.setup.restart()
    return { removed: true as const, restarting: true as const }
  }
  /** 创建一个项目；代码仓库与任务来源随项目保存，配置由各自 schema 校验。 */
  async createProject(id: string | undefined, value: unknown, origin: SettingsOrigin) {
    const current = this.current()
    const project = parseProject(value)
    const recordId = this.recordId(id, 'project', current.projects, 'projectExists', 'project')
    const settings = SettingsSchema.parse({ ...current, projects: { ...current.projects, [recordId]: project } })
    this.checkKnowledgeOwner(settings, recordId)
    return this.persistRecord(`project:${recordId}`, settings, current, origin, recordId)
  }

  /**
   * 知识空间归属唯一：`spaceId` 全库只归属一个项目，两个项目解析出同一空间即拒绝保存。
   * 任务来源随项目保存后，这里直接比较项目自己的任务来源配置。
   * @throws 冲突时抛出 `knowledgeBaseClaimed`。
   */
  private checkKnowledgeOwner(settings: SettingsValue, projectId: string): void {
    const project = settings.projects[projectId]
    const space = project ? projectSpace(project) : ''
    if (!space) return
    for (const [id, other] of Object.entries(settings.projects)) {
      if (id === projectId) continue
      if (projectSpace(other) === space) throw new UserError('knowledgeBaseClaimed', { space, project: id })
    }
  }
  /** 删除一个项目；队列与运行记录由 P4 的调度器负责收尾。 */
  async removeProject(id: string, origin: SettingsOrigin) {
    const current = this.current()
    if (!current.projects[id]) throw new UserError('projectNotInstalled', { project: id })
    const { [id]: _record, ...projects } = current.projects
    const settings = SettingsSchema.parse({ ...current, projects })
    return this.removeRecord(`project:${id}`, settings, current, origin)
  }
  /** 生成记录 ID：未提供时按类型、`<类型>-2`… 递增；显式 ID 冲突时拒绝。 */
  private recordId(id: string | undefined, base: string, records: Record<string, unknown>, code: UserErrorCode, field: string): string {
    if (id === undefined) {
      let candidate = base, suffix = 2
      while (records[candidate]) candidate = `${base}-${suffix++}`
      return candidate
    }
    if (records[id]) throw new UserError(code, { [field]: id })
    return id
  }
  /** 保存新建记录：写入设置与变更通知，返回块修订与上下文投递状态。 */
  private async persistRecord(block: SettingsSave, settings: SettingsValue, current: SettingsValue, origin: SettingsOrigin, id: string) {
    const { store, sessions } = this.host
    store.atomic(() => {
      store.saveSettings(settings, { source: origin, block, policyVersion: policyVersion(current), policyChanged: false, notified: [] })
      if (origin !== 'tool') sessions.notify(...settingsNotice(block, changedPaths(current, settings)))
    })
    // 新建项目同样可能改变部署材料（仓库、凭据引用），需要按 save 的同一规则触发初始化重跑，
    // 否则部署里没有新项目的仓库来源，调度轮询会以「记录必须是 GitHub 或 GitLab」失败。
    const restarting = setupChanged(current, settings) || !this.host.setup.configured()
    const delivery = restarting ? 'pending' : await sessions.delivery(`settings:${block}`)
    if (restarting) this.host.setup.restart()
    return { id, revision: store.blockRevision(block), restarting, context_delivery: delivery }
  }
  /** 删除记录并写入变更通知。 */
  private async removeRecord(block: SettingsSave, settings: SettingsValue, current: SettingsValue, origin: SettingsOrigin) {
    const { store, sessions } = this.host
    store.atomic(() => {
      store.saveSettings(settings, { source: origin, block, policyVersion: policyVersion(current), policyChanged: false, notified: [] })
      if (origin !== 'tool') sessions.notify(...settingsNotice(block, changedPaths(current, settings)))
    })
    // 删除项目同样改变部署材料：仓库来源要在初始化重跑后移出部署，避免残留可同步的孤儿记录。
    const restarting = setupChanged(current, settings) || !this.host.setup.configured()
    const delivery = restarting ? 'pending' : await sessions.delivery(`settings:${block}`)
    if (restarting) this.host.setup.restart()
    return { removed: true as const, restarting, context_delivery: delivery }
  }
  /** 删除记录后释放它拥有的 `sync:<id>` 健康项，并取消待处理的策略同步重试。 */
  private releaseSource(id: string): void {
    const retry = this.retries.get(id)
    if (retry) clearTimeout(retry.timer)
    this.retries.delete(id)
    const entry = this.syncs.get(id)
    if (entry) { entry.release(); this.syncs.delete(id) }
  }
  /**
   * 暂停或恢复处理（新的评估、执行器调度和渠道投递，而来源继续记录
   * 触发器）；保存在独立的 `'pause'` 块中，使并发的 `executor` 编辑在期间仍然有效。
   * @returns 当前处理是否已暂停（`{ paused }`）。
   */
  async pause(paused: boolean, origin: SettingsOrigin): Promise<{ paused: boolean }> {
    const { store, sessions } = this.host
    const old = store.settings()
    if (old.paused === paused) return { paused }
    store.atomic(() => {
      const record = { source: origin, block: 'pause' as const, policyVersion: policyVersion(old), policyChanged: false, notified: [] }
      store.saveSettings({ ...old, paused }, record)
      if (origin !== 'tool') sessions.notify(...settingsNotice('pause', ['paused']))
    })
    await sessions.delivery('settings:pause')
    this.host.requestPass()
    return { paused }
  }
  /** 返回已安装、已启用且其策略部分当前可同步的来源 ID（初始化未配置时为空）。 */
  syncable(): string[] {
    const { sources } = this.host
    if (!this.host.setup.configured()) return []
    return sources.instances().filter(instance => instance.installed && instance.enabled).flatMap(instance => {
      const sync = sources.kindOf(instance.id)?.policy?.sync
      const part = sources.policyPart(instance.id)
      return sync && part && sync.ready(part) ? [instance.id] : []
    })
  }
  /**
   * 从外部可信来源同步来源 `id` 的策略部分，在
   * 变化时保存为 `'policy'` 修订，并把结果记录到 `sync:<id>` 健康条目（失败时通过 `retrySync` 安排指数退避重试）。
   * @returns `id` 的已同步策略部分。
   * @throws 当 `id` 当前无法同步时抛出 UserError（`nothingToSync`）；若同步期间 `'policy'` 块发生变化则抛出 `SettingsConflict`；失败时抛出底层同步错误。
   */
  async sync(id: string) {
    const { store, sources } = this.host
    if (!this.syncable().includes(id)) throw new UserError('nothingToSync', { source: id })
    const health = this.syncHealth(id)
    try {
      const revision = store.blockRevision('policy')
      const part = await sources.kindOf(id)!.policy!.sync!.run(this.host.sourceHost, id, sources.policyPart(id)!, this.host.lifetime)
      if (revision !== store.blockRevision('policy')) throw new SettingsConflict('Policy changed during synchronization. Retry with the current settings.')
      const policy = store.settings().policy
      // 当同步后的列表未变化时跳过保存新修订。
      if (JSON.stringify(part) !== JSON.stringify(policy.sources[id])) {
        await this.save('policy', { ...policy, sources: { ...policy.sources, [id]: part } }, revision, 'sync')
      }
      health.set({ state: 'ready', detail: `${part.allowed.length} allowed`, at: now(), category: 'sync' })
      this.retrySync(id, false)
      return part
    } catch (error) {
      health.set({ state: 'error', detail: String(error), at: now(), category: 'sync' })
      this.retrySync(id, true)
      throw error
    }
  }
  /**
   * 立即重新读取来源的显示名称（如飞书群名称）。
   * @returns 本次读取之前存储的标签映射中不存在的、排序后的显示名称（`{ added }`）。
   * @throws 当来源没有标签刷新时抛出 UserError（`noLabels`）；读取失败时重新抛出，并保留已存储的列表。
   */
  async refreshLabels(id: string): Promise<{ added: string[] }> {
    const { store, sources } = this.host
    const kind = sources.kindOf(id)
    if (!kind?.refreshLabels) throw new UserError('noLabels')
    const before = store.get(KV.sources.labels(id)) ?? {}
    const after = await kind.refreshLabels(this.host.sourceHost, id)
    return { added: Object.entries(after).filter(([key]) => !(key in before)).map(([, name]) => name).sort((a, b) => a.localeCompare(b)) }
  }
}
