/**
 * Git 与飞书凭据服务共享的编排骨架：记录元数据 + 加密材料的增删改查、轮换与引用保护。
 * 两域的 vault 分区、错误码与探测互不复用——共享的是编排（材料先落盘、修订乐观并发、引用拒绝删除），不是身份。
 */
import { UserError, type UserErrorCode } from '../core/index.ts'
import { SecretVault, type SecretArea, type SecretMaterial } from './vault.ts'
import { credentialId } from './id.ts'

/** 凭据记录的最小公共形状：修订用于乐观并发，时间戳供面板展示。 */
export interface CredentialRecord {
  readonly id: string
  readonly name: string
  readonly revision: number
  readonly updatedAt: string
  readonly lastVerifiedAt: string
}
/** 记录层只依赖最小读写接口，便于用内存实现测试。 */
export interface CredentialRepository<R> {
  get(id: string): R | undefined
  list(): R[]
  save(value: R): void
  remove(id: string): void
}
/** 一个凭据域注入给共享骨架的差异点。 */
export interface CredentialDomain<R extends CredentialRecord, I extends { name: string }, V> {
  /** 材料所在 vault 分区；Git 与飞书各一，互不读取对方的材料。 */
  readonly area: SecretArea
  readonly records: CredentialRepository<R>
  readonly vault: SecretVault
  /** 面向用户的错误码：已存在 / 未安装 / 材料不完整 / 仍被引用。 */
  readonly codes: { exists: UserErrorCode; notInstalled: UserErrorCode; material: UserErrorCode; inUse: UserErrorCode }
  /** 引用该凭据的配置（项目或任务来源）；删除前据此拒绝。 */
  references(): readonly string[]
  /** 解析创建与更新的完整输入。 */
  parseInput(input: unknown): I
  /** 解析轮换与校验的部分输入。 */
  parsePartial(input: unknown): Partial<I>
  /** 从输入提取要写入 vault 的材料；update/rotate 据此替换整份材料。 */
  materialOf(input: Partial<I>): SecretMaterial
  /** 输入携带材料字段时为 true（update 由此决定是否替换 vault 内容）。 */
  replaces(input: I): boolean
  /** 记录与材料的完整性规则，如 ssh 必须有私钥、app 模式必须有 appId 与密钥。 */
  complete(record: R, material: SecretMaterial): boolean
  /** 由输入构造 revision 1 的新记录。 */
  createRecord(id: string, input: I, at: string): R
  /** 合并输入到既有记录，并把修订递增为 `current.revision + 1`（update）。 */
  mergeRecord(current: R, input: I, at: string): R
  /** 只换材料时的记录变更，并把修订递增为 `current.revision + 1`（rotate）。 */
  rotateRecord(current: R, input: Partial<I>, at: string): R
  /** 面板视图；`readable` 表示 vault 材料可读，不可读时视图只含掩码为空的字段。 */
  viewOf(record: R, material: SecretMaterial, readable: boolean): V
  now?(): string
}

/** 承载两个凭据域共享的编排：材料先落盘再写元数据（失败不留半条记录）、修订乐观并发、引用拒绝删除。 */
export class CredentialService<R extends CredentialRecord, I extends { name: string }, V> {
  private readonly now: () => string
  constructor(private readonly domain: CredentialDomain<R, I, V>) {
    this.now = domain.now ?? (() => new Date().toISOString())
  }

  /** 全部凭据视图，按记录 ID 排序。 */
  list(): V[] {
    return this.domain.records.list().sort((a, b) => a.id.localeCompare(b.id)).map(record => this.view(record))
  }
  /** 单条凭据视图；不存在时抛 404。 */
  get(id: string): V { return this.view(this.record(id)) }
  /** 创建凭据：材料先落盘再写元数据，任一步失败都不留下半条记录。 */
  create(input: unknown, id?: string): { id: string; revision: number } {
    const { area, records, vault, codes } = this.domain
    const parsed = this.domain.parseInput(input)
    const recordId = id ?? this.unique(credentialId(parsed.name))
    if (records.get(recordId)) throw new UserError(codes.exists, { credential: recordId })
    const material = this.domain.materialOf(parsed)
    const record = this.domain.createRecord(recordId, parsed, this.now())
    if (!this.domain.complete(record, material)) throw new UserError(codes.material)
    if (Object.keys(material).length) vault.save(area, recordId, material)
    try { records.save(record) } catch (error) {
      vault.remove(area, recordId)
      throw error
    }
    return { id: recordId, revision: record.revision }
  }
  /** 更新元数据；提交了材料字段时一并替换材料。 */
  update(id: string, input: unknown, revision: number): { revision: number } {
    const { area, records, vault, codes } = this.domain
    const current = this.record(id)
    if (current.revision !== revision) throw new UserError('credentialRevisionStale')
    const parsed = this.domain.parseInput(input)
    const replaced = this.domain.replaces(parsed)
    const material = replaced ? this.domain.materialOf(parsed) : vault.read(area, id) ?? {}
    const record = this.domain.mergeRecord(current, parsed, this.now())
    if (!this.domain.complete(record, material)) throw new UserError(codes.material)
    if (replaced) vault.save(area, id, material)
    records.save(record)
    return { revision: record.revision }
  }
  /** 只替换材料，元数据与认证方式保持不变；引用方应重新校验。 */
  rotate(id: string, material: unknown): { revision: number } {
    const { area, records, vault, codes } = this.domain
    const current = this.record(id)
    const parsed = this.domain.parsePartial(material ?? {})
    const secret = this.domain.materialOf(parsed)
    const record = this.domain.rotateRecord(current, parsed, this.now())
    if (!this.domain.complete(record, secret)) throw new UserError(codes.material)
    vault.save(area, id, secret)
    records.save(record)
    return { revision: record.revision }
  }
  /** 删除凭据；仍被引用时拒绝。 */
  remove(id: string): { removed: true } {
    const { area, records, vault, codes } = this.domain
    this.record(id)
    const used = this.domain.references().filter(reference => reference === id).length
    if (used) throw new UserError(codes.inUse, { credential: id, count: String(used) })
    records.remove(id)
    vault.remove(area, id)
    return { removed: true }
  }
  /** 按 ID 读取记录；不存在时抛对应域的未安装错误。 */
  protected record(id: string): R {
    const record = this.domain.records.get(id)
    if (!record) throw new UserError(this.domain.codes.notInstalled, { credential: id })
    return record
  }
  /** 从显示名推导的基础 ID 上追加 `-2`、`-3`……直到未被占用。 */
  private unique(base: string): string {
    let candidate = base, suffix = 2
    while (this.domain.records.get(candidate)) candidate = `${base}-${suffix++}`
    return candidate
  }
  /** 读取材料并交给域渲染视图；vault 不可读时按空材料与 `readable: false` 渲染。 */
  private view(record: R): V {
    let material: SecretMaterial = {}
    let readable = true
    try { material = this.domain.vault.read(this.domain.area, record.id) ?? {} }
    catch { readable = false }
    return this.domain.viewOf(record, material, readable)
  }
}
