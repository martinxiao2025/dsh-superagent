/** 领域聚合、键值状态、设置历史和渠道发件箱的 SQLite 持久化。 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, threadKey, type ChannelRef, type Decision, type OutboundMessage, type ReplyStatus, type Repositories, type Thread, type ThreadFact,
  type ThreadFacts, type Ticket, type Trigger, type TriggerDisposition } from '../core/index.ts'
import { KV, type Family, type Key } from '../kv.ts'
import { QueueEntrySchema, type QueueEntry } from '../queue/model.ts'
import { SettingsSchema, type Settings, type SettingsOrigin, type SettingsSave } from '../policy.ts'
import type { GitCredential } from '../git-credentials/kind.ts'
import type { FeishuCredential } from '../feishu-credentials/kind.ts'
import { Versions } from './versions.ts'
import { storeReads } from './store-read.ts'

/** 触发器在线程时间线上的位置，按时间戳排序，并以 `id` 作为并列时的决胜依据。 */
export interface TimelinePlace { at: string; id: string }
/** 消息被丢弃的原因：其会话永远无法接收（`channelGone`），或其来源不再监听（`channelIgnored`）。 */
export type DropReason = 'channelGone' | 'channelIgnored'
/** 从入队起在发件箱中跟踪的出站消息回执（`pending`、`sent` 或 `dropped`）；投递尝试次数记录在其 `reply` 副作用上。 */
export interface Receipt extends OutboundMessage { status: ReplyStatus; dropped?: { at: string; reason: DropReason } }
/** 已丢弃的出站消息回执，包含丢弃时间和原因。 */
export type Dropped = Receipt & { dropped: { at: string; reason: DropReason } }
/** 已保存的设置快照，包含策略版本及其产生的工单通知（`internal` 保存没有来源）。 */
export interface SettingsVersion {
  revision: number; savedAt: string; source: SettingsOrigin | 'internal'; block?: SettingsSave
  policyVersion: string; policyChanged: boolean; notified: string[]; settings: Settings
}
/** 副作用队列中的一行：`seq` 保留队列位置，`generation` 在载荷更新时递增，使运行中的尝试不会删除更新的载荷。 */
export interface EffectRow { key: string; value: string; seq: number; generation: number; attempts: number; due: number }
/**
 * 定义活跃工作集的生成列和部分索引，使轮次只扫描活跃行。
 * 打开数据库时按这里的定义补齐列与索引，由 SQLite 从已存储的 JSON 行填充。
 */
const SETS: Record<string, Record<string, string>> = {
  ticket: {
    open: "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)",
    // 只有最新的分配可以是待处理或运行中，因为引擎会在添加下一个之前关闭前一个。
    active: `INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
      OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)`,
  },
  thread: {
    active: "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
    subscribed: "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)",
  },
  // 用于保持每个会话回复顺序的复合键（ticketId + thread）。
  outbox: { dropped: "TEXT AS (value ->> '$.dropped.at')", pending: `TEXT AS (CASE WHEN value ->> '$.status' = 'pending'
    AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)` },
  queue: {
    active: `TEXT AS (CASE WHEN value ->> '$.state' IN ('queued','starting','running') THEN value ->> '$.project' END)`,
    inflight: `TEXT AS (CASE WHEN value ->> '$.state' IN ('starting','running') THEN value ->> '$.project' END)`,
    // 同一项目 + 任务 + 工作项在活动态只能有一条，唯一索引把去重放到数据库层。
    uniqueKey: `TEXT AS (CASE WHEN value ->> '$.state' IN ('queued','starting','running')
      THEN (value ->> '$.project') || char(31) || (value ->> '$.task') || char(31)
        || COALESCE(value ->> '$.itemKey', '#' || (value ->> '$.item')) END)`,
    // 建单后的工单反查（调度器结算）：只在建单中/执行中的行上非 NULL，终态行不会误命中。
    ticketId: `TEXT AS (CASE WHEN value ->> '$.state' IN ('starting','running') THEN value ->> '$.ticketId' END)`,
  },
}
/** 当前数据库模式版本；只有这一版本的数据库可以被打开，其他版本必须重置。 */
export const SCHEMA_VERSION = 14
/** 工单的关键字段形状：读取时校验这些不变量，未知字段放行；与 `entity` 的 fail-fast 策略一致。 */
const TicketShape = z.object({
  id: z.string(), title: z.string(), decisionId: z.string(), createdAt: z.string(), updatedAt: z.string(),
  mandate: z.object({ strength: z.string(), policyVersion: z.string(), basis: z.object({ via: z.string() }).passthrough() }).passthrough(),
  origin: z.object({ triggerId: z.string(), triggerIds: z.array(z.unknown()) }).passthrough(),
  channels: z.array(z.unknown()), assignments: z.array(z.unknown()), inputs: z.array(z.unknown()), undelivered: z.array(z.unknown()),
}).passthrough()
/** 线程的关键字段形状。 */
const ThreadShape = z.object({
  key: z.string(), createdAt: z.string(), lastAt: z.string().optional(),
  ref: z.object({ source: z.string(), id: z.string() }).passthrough(),
  subscriptions: z.array(z.unknown()), correlated: z.array(z.unknown()), pending: z.array(z.unknown()),
  meta: z.object({}).passthrough(),
}).passthrough()
/** 决策的关键字段形状。 */
const DecisionShape = z.object({
  id: z.string(), evalId: z.string(), threadKey: z.string(), triggerIds: z.array(z.unknown()),
  policyVersion: z.string(), at: z.string(), kind: z.string(), strength: z.string(),
  reason: z.array(z.unknown()),
}).passthrough()
/** 拒绝打开其他模式版本的错误消息：本版本不做迁移，只能备份后用 `reset` 从空基线重新开始。 */
const unsupported = (version: number): string =>
  `Unsupported orchestrator database version ${version}: this build opens schema ${SCHEMA_VERSION} only; back it up and start from an empty baseline with reset (the panel's Reset action, \`reset\` command, or the resetState setting)`
/**
 * 实现领域 `Repositories`、视图读取查询、带版本的设置、发件箱回执和键值状态的 SQLite 支撑存储。
 * 运行时在锁定状态目录后打开它；空库在打开时按当前基线建表，其他模式的库直接拒绝。
 * 引擎在 `atomic` 事务内修改领域聚合，而来源、视图和发件箱读取状态或更新各自的记录。
 */
export class Store implements Repositories {
  readonly db: DatabaseSync
  /**
   * 在 `path` 处打开或创建 SQLite 数据库：空库建当前基线并写入 `SCHEMA_VERSION`。
   * @param report - 接收 `afterCommit` 回调抛出的错误，且不会使已提交的事务失败。
   * @throws 当数据库模式不是 `SCHEMA_VERSION`（14）时抛出，提示备份并用 `reset` 从空基线重新开始；此时数据库文件保持不变，并关闭 SQLite 句柄，使同一进程中的后续尝试可以打开它。
   */
  constructor(path: string, private readonly report: (error: unknown) => void = () => {}) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.read = storeReads(this.db)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      const version = this.get(KV.store.schema)
      if (version !== undefined && version !== SCHEMA_VERSION) throw new Error(unsupported(version))
      this.atomic(() => {
        this.createTables()
        this.addColumns()
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS queue_unique_active ON queue(uniqueKey) WHERE uniqueKey IS NOT NULL')
        if (version === undefined) this.set(KV.store.schema, SCHEMA_VERSION)
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  /** 建立当前基线的表与普通索引；空库和已有当前模式库都走这里，重复执行没有副作用。 */
  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
        PRIMARY KEY (thread, id));
      CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
        since TEXT NOT NULL, PRIMARY KEY (kind, key));
      CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, value TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS git_credential (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feishu_credential (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
      CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
      CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
      CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
      CREATE INDEX IF NOT EXISTS queue_seq ON queue(seq);
    `)
  }
  /** 确保工作集列与索引和当前构建一致；定义变化的生成列会被重建。 */
  private addColumns(): void {
    const columns = (table: string) => new Set(this.db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table).map(row => String(row.name)))
    for (const [table, definitions] of Object.entries(SETS)) {
      // 在添加当前生成列之前，删除定义已变化或已移除的生成列及其索引。
      const sql = String(this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? '')
      const generated = this.db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)').all(table).map(row => String(row.name))
      for (const name of generated) {
        if (definitions[name] && sql.includes(`${name} ${definitions[name]}`)) continue
        this.db.exec(`DROP INDEX IF EXISTS ${table}_${name}; ALTER TABLE ${table} DROP COLUMN ${name}`)
      }
      const existing = columns(table)
      for (const [name, definition] of Object.entries(definitions)) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL`)
      }
    }
  }
  /** 关闭底层 SQLite 数据库连接。 */
  close(): void { this.db.close() }
  /** 解析 `sql` 返回的 JSON `value` 列。 */
  private values<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)) as T)
  }
  /** 重新索引触发器所属的线程，替换同一触发器早先保存产生的行。 */
  private indexThreads(trigger: Trigger): void {
    this.db.prepare('DELETE FROM trigger_thread WHERE id=?').run(trigger.id)
    const insert = this.db.prepare('INSERT OR IGNORE INTO trigger_thread VALUES (?,?,?,?)')
    for (const ref of trigger.threads) insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0)
  }
  private depth = 0
  /** 在最外层事务提交后运行的回调，按保存点层级索引；回滚某一层级会丢弃其回调。 */
  private readonly committed: (() => void)[][] = []
  /**
   * 在保存点事务中执行 `operation`（如果有当前事务则嵌套其中）；失败会回滚其更改。
   * 提交后回调仅在最外层事务提交后运行，回调错误会被报告，但不会使已提交的事务失败。
   */
  atomic<T>(operation: () => T): T {
    const level = this.depth++
    const name = `orchestrator_atomic_${level}`
    this.committed[level] = []
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    try { value = operation(); this.db.exec(`RELEASE ${name}`) }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
    const actions = this.committed.splice(level)[0]!
    if (level) this.committed[level - 1]!.push(...actions)
    else for (const action of actions) { try { action() } catch (error) { this.report(error) } }
    return value
  }
  /**
   * 安排 `action` 在最外层事务提交后运行；若不在事务中则立即运行；
   * 在回滚的事务内排队的回调会被丢弃且永不运行。
   * 对已提交写入的即时内存后续工作（如刷新健康状态或取消内存中的轮次）使用 `afterCommit`，这类工作不能等待副作用队列且无需在重启后存活；对必须在崩溃后存活的持久化副作用使用 `Effects`。
   */
  afterCommit(action: () => void): void {
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    else action()
  }
  /** 按 `KV` 中的键读取带类型的 KV 记录。 */
  get<V>(name: Key<V>): V | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(name)
    return row === undefined ? undefined : JSON.parse(String(row.value)) as V
  }
  /** 在 `name` 下写入带类型的 KV 记录。 */
  set<V>(name: Key<V>, value: V): void {
    this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value))
  }
  /** 删除 `name` 处的 KV 记录。 */
  delete(name: string): void { this.db.prepare('DELETE FROM kv WHERE key=?').run(name) }
  /** 返回属于 `family` 或以 `prefix` 开头的所有 KV 键。 */
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
  keys(family: string | { prefix: string }): string[] {
    const prefix = typeof family === 'string' ? family : family.prefix
    const pattern = `${prefix.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return this.db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'").all(pattern).map(row => String(row.key))
  }

  /** 带版本的设置快照；当前设置即最新修订的快照。 */
  private readonly settingsVersions = new Versions<SettingsVersion>(this, KV.settings.revision, KV.settings.version)
  /** 已解析设置的修订键缓存：KV 指针未变时直接复用，免去热路径的全量 parse；键失配即失效（回滚后指针未动，自然失配）。 */
  private settingsCache: { revision: number; value: Settings } | undefined
  /** 当前已校验的设置。 */
  settings(): Settings {
    const revision = this.settingsVersions.revision()
    if (this.settingsCache?.revision === revision) return this.settingsCache.value
    const value = SettingsSchema.parse(this.settingsVersions.current()?.settings ?? {})
    this.settingsCache = { revision, value }
    return value
  }
  /** 单个设置块的修订；每个配置页按自己的块进行乐观并发保存。 */
  blockRevision(block: SettingsSave): number { return this.get(KV.settings.block(block)) ?? 0 }
  /** 将设置保存为下一个修订（使其成为当前），并在存在时递增 `record.block` 的修订计数器。 */
  saveSettings(value: unknown, record: Omit<SettingsVersion, 'revision' | 'savedAt' | 'settings'> = { source: 'internal', policyVersion: '', policyChanged: false, notified: [] }): Settings {
    const settings = SettingsSchema.parse(value)
    return this.atomic(() => {
      const saved = this.settingsVersions.save(revision => ({ ...record, revision, savedAt: new Date().toISOString(), settings }))
      if (record.block) this.set(KV.settings.block(record.block), this.blockRevision(record.block) + 1)
      // 写者即失效点：同一事务把缓存推进到新修订；事务回滚时 KV 指针未动，缓存键失配即不会读到脏值。
      this.settingsCache = { revision: saved.revision, value: saved.settings }
      return settings
    })
  }
  /** 已保存的设置修订，最新的在前；早于设置历史的修订不包含在内。 */
  settingsHistory(limit = 20): SettingsVersion[] { return this.settingsVersions.list(limit) }

  /** 解析单条实体记录；缺字段或 JSON 损坏时明确报错，而不是把 `undefined` 继续传下去。 */
  private entity<T>(json: string, label: string, field: string, id: string): T {
    let value: unknown
    try {
      value = JSON.parse(json)
    } catch (error) {
      throw new Error(`The ${label} record ${id} is corrupt: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || (field !== '' && typeof (value as Record<string, unknown>)[field] !== 'string')) {
      throw new Error(`The ${label} record ${id} is invalid${field ? `: missing ${field}` : ''}`)
    }
    return value as T
  }
  readonly triggers = {
    get: (id: string): Trigger | undefined => { const row = this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id); return row ? this.entity<Trigger>(String(row.value), 'trigger', 'id', id) : undefined },
    save: (trigger: Trigger): void => this.atomic(() => {
      this.db.prepare('INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at').run(trigger.id, JSON.stringify(trigger), trigger.at)
      this.indexThreads(trigger)
    }),
    disposition: (id: string): TriggerDisposition | undefined => { const row = this.db.prepare('SELECT value FROM disposition WHERE id=?').get(id); return row ? this.entity<TriggerDisposition>(String(row.value), 'disposition', '', id) : undefined },
    saveDisposition: (id: string, value: TriggerDisposition): void => { this.db.prepare('INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)) },
  }
  /** Git 凭据记录：只含展示与用途信息，材料在 `<stateDir>/secrets/git` 加密保存。 */
  readonly gitCredentials = {
    get: (id: string): GitCredential | undefined => { const row = this.db.prepare('SELECT value FROM git_credential WHERE id=?').get(id); return row ? this.entity<GitCredential>(String(row.value), 'git credential', 'id', id) : undefined },
    list: (): GitCredential[] => this.values('SELECT value FROM git_credential ORDER BY rowid'),
    save: (value: GitCredential): void => { this.db.prepare('INSERT INTO git_credential VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at').run(value.id, JSON.stringify(value), value.updatedAt) },
    remove: (id: string): void => { this.db.prepare('DELETE FROM git_credential WHERE id=?').run(id) },
  }
  /** 飞书凭据记录：应用密钥同样只保存在 `secrets/feishu`。 */
  readonly feishuCredentials = {
    get: (id: string): FeishuCredential | undefined => { const row = this.db.prepare('SELECT value FROM feishu_credential WHERE id=?').get(id); return row ? this.entity<FeishuCredential>(String(row.value), 'Feishu credential', 'id', id) : undefined },
    list: (): FeishuCredential[] => this.values('SELECT value FROM feishu_credential ORDER BY rowid'),
    save: (value: FeishuCredential): void => { this.db.prepare('INSERT INTO feishu_credential VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at').run(value.id, JSON.stringify(value), value.updatedAt) },
    remove: (id: string): void => { this.db.prepare('DELETE FROM feishu_credential WHERE id=?').run(id) },
  }
  readonly threads = {
    get: (keyValue: string): Thread | undefined => { const row = this.db.prepare('SELECT value FROM thread WHERE key=?').get(keyValue); return row ? this.entity<Thread>(String(row.value), 'thread', 'key', keyValue) : undefined },
    save: (thread: Thread): void => { this.db.prepare('INSERT INTO thread VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(thread.key, JSON.stringify(thread)) },
    list: (): Thread[] => this.entityValues('SELECT value FROM thread ORDER BY rowid', ThreadShape),
    active: (): Thread[] => this.values('SELECT value FROM thread WHERE active = 1 ORDER BY rowid'),
    /** 更新人类可读的线程元数据（`label`、`url` 和 `facts`，其中 `null` 会按 ID 删除事实）；线程不存在时为空操作。 */
    describe: (keyValue: string, patch: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }): void => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const facts: ThreadFacts = { ...(thread.meta.facts as ThreadFacts | undefined) }
      for (const [id, fact] of Object.entries(patch.facts ?? {})) { if (fact) facts[id] = fact; else delete facts[id] }
      const meta = { ...thread.meta, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.url === undefined ? {} : { url: patch.url }), facts }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    },
    /** 重新读取线程后，原子地设置或移除（`undefined`）来源特定的元数据键；线程不存在时为空操作。 */
    patchMeta: (keyValue: string, patch: Record<string, unknown>): void => this.atomic(() => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const meta = { ...thread.meta }
      for (const [name, value] of Object.entries(patch)) { if (value === undefined) delete meta[name]; else meta[name] = value }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    }),
  }
  readonly tickets = {
    get: (id: string): Ticket | undefined => { const row = this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id); return row ? this.entity<Ticket>(String(row.value), 'ticket', 'id', id) : undefined },
    save: (ticket: Ticket): void => { this.db.prepare('INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(ticket.id, JSON.stringify(ticket)) },
    /** 最新的在前。 */
    list: (): Ticket[] => this.entityValues('SELECT value FROM ticket ORDER BY rowid DESC', TicketShape),
    /** 最新的在前。 */
    open: (): Ticket[] => this.entityValues('SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC', TicketShape),
    /** 最新的在前。 */
    active: (): Ticket[] => this.entityValues('SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC', TicketShape),
  }
  readonly decisions = {
    get: (id: string): Decision | undefined => { const row = this.db.prepare('SELECT value FROM decision WHERE id=?').get(id); return row ? this.entity<Decision>(String(row.value), 'decision', 'id', id) : undefined },
    save: (decision: Decision): void => { this.db.prepare('INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread').run(decision.id, decision.threadKey, JSON.stringify(decision)) },
    byThread: (threadKeyValue: string): Decision[] =>
      this.entityValues('SELECT value FROM decision WHERE thread=? ORDER BY rowid', DecisionShape, threadKeyValue),
  }
  /** 持久化调度队列；`seq` 决定全局 FIFO 顺序，状态列只索引活动条目。读取时按 schema 校验，避免字段漂移被静默接受。 */
  readonly queue = {
    get: (id: string): QueueEntry | undefined => {
      const row = this.db.prepare('SELECT value FROM queue WHERE id=?').get(id)
      return row ? QueueEntrySchema.parse(JSON.parse(String(row.value))) : undefined
    },
    save: (entry: QueueEntry): void => { this.db.prepare('INSERT INTO queue (id, value, seq) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, seq=excluded.seq').run(entry.id, JSON.stringify(entry), entry.seq) },
    /** 全部条目，按全局入队顺序。 */
    list: (): QueueEntry[] => this.queueValues('SELECT value FROM queue ORDER BY seq'),
    /** 仍在队列或执行中的条目，按全局入队顺序。 */
    active: (): QueueEntry[] => this.queueValues('SELECT value FROM queue WHERE active IS NOT NULL ORDER BY seq'),
    /** 排队中的条目，按全局入队顺序；由活动部分索引支撑。 */
    queued: (): QueueEntry[] => this.queueValues('SELECT value FROM queue WHERE inflight IS NULL AND active IS NOT NULL ORDER BY seq'),
    /** 已到期可派工的排队条目，按全局入队顺序；调度器的出队扫描只读这些行。 */
    ready: (now: number): QueueEntry[] => this.queueValues("SELECT value FROM queue WHERE inflight IS NULL AND active IS NOT NULL AND json_extract(value, '$.dueAt') <= ? ORDER BY seq", now),
    /** 建单中或执行中的条目里工单 ID 匹配的那一条；工单终态回写按它反查所属队列条目。 */
    byTicket: (ticketId: string): QueueEntry | undefined => this.queueValues('SELECT value FROM queue WHERE ticketId = ?', ticketId)[0],
    /** 一个项目当前的活动条目，按全局入队顺序；索引按项目直接定位。 */
    activeIn: (project: string): QueueEntry[] => this.queueValues('SELECT value FROM queue WHERE active = ? ORDER BY seq', project),
    /** 一个项目的终态条目，最新的在前；项目详情页是交互路径，允许这一受保留期约束的扫描。 */
    terminalIn: (project: string): QueueEntry[] =>
      this.queueValues("SELECT value FROM queue WHERE active IS NULL AND inflight IS NULL AND json_extract(value, '$.project') = ? ORDER BY json_extract(value, '$.endedAt') DESC, seq DESC", project),
    /** 全部终态条目的最新一页，最新的在前；全局队列快照按页读取，不再解析整表 JSON。 */
    terminal: (offset: number, limit: number): QueueEntry[] =>
      this.queueValues("SELECT value FROM queue WHERE active IS NULL AND inflight IS NULL ORDER BY json_extract(value, '$.endedAt') DESC, seq DESC LIMIT ? OFFSET ?", limit, offset),
    /** 全部条目数；队列快照用它给出分页元数据，避免为计数解析整表 JSON。 */
    count: (): number => Number((this.db.prepare('SELECT COUNT(*) AS n FROM queue').get() as { n: number }).n),
    /** 项目当前占用的执行位置（正在建单或执行），按项目记录 ID 去重。 */
    inflight: (): string[] => this.db.prepare('SELECT DISTINCT inflight FROM queue WHERE inflight IS NOT NULL').all().map(row => String(row.inflight)),
    maxSeq: (): number => Number((this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM queue').get() as { seq: number }).seq),
    /** 删除项目的全部条目；用于删除项目后的收尾。 */
    remove: (project: string): void => { this.db.prepare(`DELETE FROM queue WHERE value ->> '$.project' = ?`).run(project) },
    /** 清理某项目在 `before` 之前结束的终态条目，返回删除条数。 */
    prune: (project: string, before: string): number => Number(this.db.prepare(`DELETE FROM queue WHERE value ->> '$.project' = ?
      AND value ->> '$.state' IN ('succeeded','failed','cancelled') AND value ->> '$.endedAt' IS NOT NULL
      AND value ->> '$.endedAt' < ?`).run(project, before).changes),
  }
  /** 队列读取统一按 schema 解析，字段缺失或类型变化会明确失败而不是变成 `undefined`。 */
  private queueValues(sql: string, ...parameters: SQLInputValue[]): QueueEntry[] {
    return this.db.prepare(sql).all(...parameters).map(row => QueueEntrySchema.parse(JSON.parse(String(row.value))))
  }
  /** 工单/线程/决策的列表读取校验：关键字段必须存在且类型正确，未知字段放行；单行损坏跳过并上报，不让整个列表失败（详情页 `get` 仍 fail-fast）。 */
  private entityValues<T>(sql: string, schema: z.ZodType, ...parameters: SQLInputValue[]): T[] {
    const values: T[] = []
    for (const row of this.db.prepare(sql).all(...parameters)) {
      try {
        const value = JSON.parse(String(row.value)) as unknown
        const parsed = schema.safeParse(value)
        if (!parsed.success) {
          throw new Error(`Stored record is corrupt: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`)
        }
        // 关键字段已经过校验；其余字段仍以领域类型为准（与 `entity` 的单一记录校验同口径）。
        values.push(value as T)
      } catch (error) {
        // 单行损坏只跳过并上报；列表保持可用，详情接口按 id 直读（`entity`）仍会明确报错。
        this.report(error)
      }
    }
    return values
  }
  /** 副作用队列的仓储面：入队、取消、到期分发与按序号+代数的结算，全部供 `Effects` 调度使用。 */
  readonly effects = {
    /** 重启时延续全局队列顺序的最大序号。 */
    maxSeq: (): number => Number(this.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0),
    /** 在调用方的事务中 upsert 一个副作用，与同类同键的等待行合并，保留队列位置并在载荷更新时递增 generation。 */
    enqueue: (kind: string, key: string, value: string, seq: number, due: number, since: string): void => {
      this.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
        SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
        .run(kind, key, value, seq, due, since)
    },
    /** 是否存在等待中的副作用：整个类别或某个键。 */
    pending: (kind: string, key?: string): boolean => key === undefined
      ? !!this.db.prepare('SELECT 1 FROM effect WHERE kind = ? LIMIT 1').get(kind)
      : !!this.db.prepare('SELECT 1 FROM effect WHERE kind = ? AND key = ?').get(kind, key),
    /** 按类别和键删除排队的行；如果它已在运行，则该次尝试会正常完成。 */
    cancel: (kind: string, key: string): void => { this.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key) },
    /** 有序类别取最旧的一行；无序类别取已到期的前 `limit` 行（运行中的键由调用方在内存里排除）。 */
    due: (kind: string, query: { ordered: boolean; now: number; limit: number }): EffectRow[] =>
      (query.ordered
        ? this.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1').all(kind)
        : this.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?')
          .all(kind, query.now, query.limit)) as unknown as EffectRow[],
    /** 仅当序号与代数仍匹配时删除已完成的行，避免删除运行期间被替换或重新入队的行。 */
    complete: (kind: string, key: string, seq: number, generation: number): void => {
      this.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ? AND seq = ? AND generation = ?').run(kind, key, seq, generation)
    },
    /** 仅当序号与代数仍匹配时，把一行推迟到 `due`（不计失败），例如处理方报告的 `Later`。 */
    attempt: (due: number, kind: string, key: string, seq: number, generation: number): void => {
      this.db.prepare('UPDATE effect SET due = ? WHERE kind = ? AND key = ? AND seq = ? AND generation = ?').run(due, kind, key, seq, generation)
    },
    /** 仅当序号与代数仍匹配时记录一次失败：递增尝试数、保存截断后的错误文本并按退避推迟。 */
    fail: (error: string, due: number, kind: string, key: string, seq: number, generation: number): void => {
      this.db.prepare('UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE kind = ? AND key = ? AND seq = ? AND generation = ?')
        .run(error, due, kind, key, seq, generation)
    },
    /** 汇总一个类别的等待数、最早入队时间、最大尝试数与最近一次失败文本，供健康上报。 */
    stats: (kind: string): { waiting: number; since: string | null; attempts: number; error: string | null } => {
      const row = this.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
        (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind)
      return { waiting: Number(row?.waiting ?? 0), since: row?.since == null ? null : String(row.since),
        attempts: Number(row?.attempts ?? 0), error: row?.error == null ? null : String(row.error) }
    },
  }
  /** 管理视图、编排工具和来源轮询的只读查询（见 `storeReads`）。 */
  readonly read: ReturnType<typeof storeReads>

  /** 排队消息的投递状态；回执会永久保留，使消息 ID 具备幂等性。 */
  replyStatus(id: string): ReplyStatus | undefined { return this.receipts.get(id)?.status }
  /** 渠道投递的发件箱消息回执；只有 `Outbox` 会写入 `receipts`。 */
  readonly receipts = {
    get: (id: string): Receipt | undefined => this.values<Receipt>('SELECT value FROM outbox WHERE id = ?', id)[0],
    /** 待处理的消息回执，最早的在前。 */
    waiting: (): Receipt[] => this.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
    /** 若同一工单和会话的较早消息仍待处理，且 `reply` 副作用的连续失败尝试少于 `failures` 次，则为 true。 */
    behind: (id: string, failures: number): boolean => !!this.db.prepare(`SELECT 1 FROM outbox earlier
      JOIN outbox message ON message.id = ? LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ? LIMIT 1`).get(id, failures),
    /**
     * 记录新的待处理消息回执；已记录的消息 ID 保留其原始回执。
     * @returns 该消息 ID 是否为新记录。
     */
    add: (message: OutboundMessage): boolean => {
      const receipt: Receipt = { ...message, status: 'pending' }
      return Number(this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)').run(message.id, JSON.stringify(receipt)).changes) > 0
    },
    /**
     * 将待处理回执标记为已发送或已丢弃（附带丢弃原因和时间戳）；若消息在发送期间被撤回，
     * 则重建回执，使其 ID 无法再次入队。
     */
    settle: (message: OutboundMessage, outcome: 'sent' | DropReason): void => {
      const settled = outcome === 'sent' ? { status: 'sent' } : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } }
      const { id, channel, text, kind, ticketId } = message
      const updated = this.db.prepare("UPDATE outbox SET value = json_patch(value, ?) WHERE id = ? AND value ->> '$.status' = 'pending'")
        .run(JSON.stringify(settled), id)
      if (!Number(updated.changes)) this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
        .run(id, JSON.stringify({ id, channel, text, kind, ...ticketId ? { ticketId } : {}, ...settled }))
    },
    /**
     * 撤回尚未发送的待处理消息。
     * @returns 是否存在并移除了 id 为 `id` 的待处理消息。
     */
    withdraw: (id: string): boolean =>
      Number(this.db.prepare("DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'").run(id).changes) > 0,
  }
}
export { key, threadKey }
export type { ChannelRef }
