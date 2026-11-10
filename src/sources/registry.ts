/** 已安装来源种类、来源记录以及引擎的 SourceScope 实现的注册表。 */
import { UserError, type ChannelRef, type OutboundMessage, type ScopeResult, type SourceScope, type Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'
import { healthNames } from './identity.ts'


/**
 * 管理已注册的 SourceKind 插件与用户创建的来源记录，校验记录和策略配置，并为引擎实现 SourceScope。
 * 记录 ID 是来源身份：触发器、策略、健康项、线程与 KV 键都以它为准；`kind` 只决定由哪个适配器处理。
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** 注册一个 SourceKind，并为已有的来源记录认领其健康条目（拒绝 `sync:` 前缀，这些由 Settings 拥有）。 */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    try { this.syncHealth() } catch (error) { this.kinds.delete(kind.kind); throw error }
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); this.syncHealth(); unregistered() }
  }
  /**
   * 返回记录 `id` 对应的活跃健康条目，键为种类声明的本地条目名。
   * 来源上下文通过构建时收到的条目写入，因此在该注册结束之后发送的报告即使种类再次注册也不会生效。
   */
  healthEntries(id: string, kind: { kind: string; health: readonly string[] }): Map<string, HealthEntry> {
    const names = healthNames(id, kind.health)
    return new Map(kind.health.flatMap((name, index) => {
      const entry = this.health.get(names[index]!)
      return entry ? [[name, entry] as const] : []
    }))
  }
  /** 按当前来源记录校准健康项：为已安装类型的记录认领条目，释放记录或类型已不存在的条目。 */
  syncHealth(settings = this.settings()): void {
    const keep = new Set<string>()
    for (const [id, record] of Object.entries(settings.sources)) {
      const kind = this.kinds.get(record.kind)
      if (kind) for (const name of healthNames(id, kind.health)) keep.add(name)
    }
    for (const [name, entry] of this.health) {
      if (keep.has(name)) continue
      entry.release()
      this.health.delete(name)
    }
    for (const name of keep) {
      if (this.health.has(name)) continue
      this.health.set(name, this.board.claim(name, { state: 'starting', detail: '' }))
    }
  }
  /** 按适配器类型查找已安装的种类。 */
  kindByName(kind: string): SourceKind | undefined { return this.kinds.get(kind) }
  /** 按记录 ID 查找该记录使用的适配器类型。 */
  kindOf(id: string, settings = this.settings()): SourceKind | undefined {
    const record = settings.sources[id]
    return record ? this.kinds.get(record.kind) : undefined
  }
  /** 存储的来源记录；记录不存在时返回 undefined。 */
  record(id: string, settings = this.settings()) { return settings.sources[id] }
  /** 记录 ID 按字典序排序；适配器未安装的记录保持存储时的原样。 */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    return Object.entries(settings.sources).sort(([a], [b]) => a.localeCompare(b)).map(([id, stored]) => {
      const kind = this.kinds.get(stored.kind)
      return kind ? { ...this.resolve(id, kind, stored), installed: true } : { id, kind: stored.kind, enabled: stored.enabled, config: stored.config, installed: false }
    })
  }
  /** 已安装适配器的类型目录，供面板新增来源时选择。 */
  kindsList(): SourceKind[] { return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)) }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const record = settings.sources[id]
    if (!record) return undefined
    const kind = this.kinds.get(record.kind)
    return kind ? this.resolve(id, kind, record) as SourceInstance<C> : undefined
  }
  /** 按记录所属适配器校验提交的 `{ enabled, config }`；记录或适配器缺失时抛出可读错误。 */
  validate(id: string, value: { enabled: boolean; config: unknown }): { enabled: boolean; config: Record<string, unknown> } {
    const record = this.settings().sources[id]
    if (!record) throw new UserError('sourceNotInstalled', { source: id })
    const kind = this.kinds.get(record.kind)
    if (!kind) throw new UserError('sourceNotInstalled', { source: id })
    return { enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** 根据记录对应的种类校验提交策略中每个来源的部分；未安装适配器的记录保持存储时的原样。 */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    const settings = this.settings()
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kindOf(id, settings)?.policy
      // `admission` 由策略自身的 schema 校验（所有种类共享），其余部分由种类校验。
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kindOf(id, settings)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const instance = this.instance(channel.source, settings)
    const kind = this.kindOf(channel.source, settings)
    if (!kind || !instance) return false
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** 每条记录的变量声明，无论启用还是禁用；`id` 是记录 ID，`kind` 是适配器类型。 */
  declarations(settings = this.settings()): { id: string; kind: string; variables: readonly VariableSpec[] }[] {
    return this.instances(settings).flatMap(instance => {
      const kind = this.kinds.get(instance.kind)
      return kind?.environment ? [{ id: instance.id, kind: instance.kind, variables: kind.environment.variables }] : []
    })
  }
  /** 每条已启用记录的运行环境；`kind` 是适配器种类，`config` 是该记录的配置。 */
  environments(settings = this.settings()) {
    return this.instances(settings).flatMap(instance => {
      const kind = this.kinds.get(instance.kind)
      return kind?.environment && instance.enabled ? [{ id: instance.id, kind, environment: kind.environment, config: instance.config }] : []
    })
  }
  /**
   * 通过其频道的种类幂等地发送消息；记录不存在时返回 `'gone'`，记录存在但适配器未安装时返回 `'waiting'`。
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const record = this.settings().sources[message.channel.source]
    if (!record) return 'gone'
    const kind = this.kinds.get(record.kind)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands: commands.scope(message.channel.source) }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const kind = this.kindOf(channel.source)
    const link = kind?.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.kinds.values()].flatMap(kind => kind.find ? [kind.find(query)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kindOf(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kindOf(trigger.source, settings)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const record = settings.sources[trigger.source]
    if (!record) return undefined
    const { config } = this.resolve(trigger.source, kind, record)
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands.scope(trigger.source), trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands.scope(trigger.source), trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const stored = settings.sources[input.source]
    // 记录不存在等价于该来源未安装：它不再监听任何内容。
    if (!stored) return { listened: false, reason: 'source_not_installed' }
    const kind = this.kinds.get(stored.kind)
    if (!kind) return { listened: false, reason: 'source_not_installed' }
    const instance = this.resolve(input.source, kind, stored)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** 存储的配置校验失败时回退到 schema 默认值并禁用该记录。 */
  private resolve(id: string, kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown> }): SourceInstance {
    const parsed = kind.schema.safeParse(stored.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && stored.enabled, config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
