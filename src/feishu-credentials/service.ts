/** 飞书凭据的增删改查、轮换与身份校验；应用密钥只经过加密存储层。 */
import { UserError } from '../core/index.ts'
import { SecretVault, fingerprint, mask, type SecretMaterial } from '../secrets/vault.ts'
import { credentialCheck, type CredentialCheck } from '../secrets/check.ts'
import { FeishuCredentialInputSchema, FeishuCredentialSchema, type FeishuCredential, type FeishuCredentialInput,
  type FeishuCredentialView } from './kind.ts'
import { credentialId } from '../secrets/id.ts'

/** 记录层只依赖最小读写接口，便于用内存实现测试。 */
export interface FeishuCredentialRepository {
  get(id: string): FeishuCredential | undefined
  list(): FeishuCredential[]
  save(value: FeishuCredential): void
  remove(id: string): void
}
/** 身份与知识库探测：应用模式校验 tenant token，CLI 模式校验可执行文件。 */
export type FeishuProbe = (input: { mode: 'app' | 'cli'; appId?: string; appSecret?: string; cli?: string; spaceId?: string })
  => Promise<{ nodes: number }>
export interface FeishuCredentialsOptions {
  credentials: FeishuCredentialRepository
  vault: SecretVault
  /** 引用该凭据的任务来源配置；删除前据此拒绝。 */
  references: () => readonly string[]
  probe: FeishuProbe
  now?: () => string
}

/** 把探测错误归入面板可本地化的失败原因。 */
export function classifyFeishuError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/99991663|99991672|permission|forbidden|\b403\b|unauthorized|\b401\b/i.test(text)) return 'feishuCredentialForbidden'
  if (/99991400|rate limit/i.test(text)) return 'feishuCredentialRateLimited'
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|timed out|network|EAI_AGAIN/i.test(text)) return 'feishuCredentialUnreachable'
  if (/not found|does not exist|\b404\b|131002/i.test(text)) return 'feishuCredentialSpaceMissing'
  return 'feishuCredentialProbeFailed'
}

/** 飞书凭据服务：元数据写入 SQLite，应用密钥写入加密存储；与 Git 凭据互不复用路由或材料。 */
export class FeishuCredentials {
  private readonly now: () => string
  constructor(private readonly options: FeishuCredentialsOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  list(): FeishuCredentialView[] {
    return this.options.credentials.list().sort((a, b) => a.id.localeCompare(b.id)).map(record => this.view(record))
  }
  get(id: string): FeishuCredentialView { return this.view(this.record(id)) }
  /** 创建凭据：材料先落盘再写元数据。 */
  create(input: unknown, id?: string): { id: string; revision: number } {
    const parsed = FeishuCredentialInputSchema.parse(input)
    const recordId = id ?? this.unique(credentialId(parsed.name))
    if (this.options.credentials.get(recordId)) throw new UserError('feishuCredentialExists', { credential: recordId })
    const material = this.materialOf(parsed)
    this.requireComplete(parsed.mode, parsed.appId ?? '', parsed.cli ?? '', material)
    const record = FeishuCredentialSchema.parse({ id: recordId, name: parsed.name, mode: parsed.mode, appId: parsed.appId ?? '',
      cli: parsed.cli ?? '', note: parsed.note ?? '', revision: 1, updatedAt: this.now(), lastVerifiedAt: '' })
    if (Object.keys(material).length) this.options.vault.save('feishu', recordId, material)
    try { this.options.credentials.save(record) } catch (error) {
      this.options.vault.remove('feishu', recordId)
      throw error
    }
    return { id: recordId, revision: record.revision }
  }
  /** 更新元数据；提交了应用密钥时一并替换材料。 */
  update(id: string, input: unknown, revision: number): { revision: number } {
    const current = this.record(id)
    if (current.revision !== revision) throw new UserError('credentialRevisionStale')
    const parsed = FeishuCredentialInputSchema.parse(input)
    const replaced = parsed.appSecret !== undefined
    const material = replaced ? this.materialOf(parsed) : this.options.vault.read('feishu', id) ?? {}
    this.requireComplete(parsed.mode, parsed.appId ?? current.appId, parsed.cli ?? current.cli, material)
    const record = FeishuCredentialSchema.parse({ ...current, name: parsed.name, mode: parsed.mode, appId: parsed.appId ?? current.appId,
      cli: parsed.cli ?? current.cli, note: parsed.note ?? current.note, revision: current.revision + 1, updatedAt: this.now() })
    if (replaced) this.options.vault.save('feishu', id, material)
    this.options.credentials.save(record)
    return { revision: record.revision }
  }
  /** 只替换应用密钥。 */
  rotate(id: string, material: unknown): { revision: number } {
    const current = this.record(id)
    const input = FeishuCredentialInputSchema.partial().parse(material ?? {})
    const parsed = this.materialOf(input)
    this.requireComplete(current.mode, input.appId ?? current.appId, input.cli ?? current.cli, parsed)
    this.options.vault.save('feishu', id, parsed)
    const record = FeishuCredentialSchema.parse({ ...current, appId: input.appId ?? current.appId, cli: input.cli ?? current.cli,
      revision: current.revision + 1, updatedAt: this.now() })
    this.options.credentials.save(record)
    return { revision: record.revision }
  }
  /** 删除凭据；仍被任务来源引用时拒绝。 */
  remove(id: string): { removed: true } {
    this.record(id)
    const used = this.options.references().filter(reference => reference === id).length
    if (used) throw new UserError('feishuCredentialInUse', { credential: id, count: String(used) })
    this.options.credentials.remove(id)
    this.options.vault.remove('feishu', id)
    return { removed: true }
  }
  /** 供知识库读取使用：材料缺失或不可解密时返回 undefined，不抛给调用方。 */
  material(id: string): SecretMaterial | undefined {
    try { return this.options.vault.read('feishu', id) } catch { return undefined }
  }
  /** 校验已有凭据或尚未保存的候选材料；只读，不写记录。 */
  async verify(input: { id?: string; input?: unknown; spaceId?: string }): Promise<CredentialCheck[]> {
    const checks: CredentialCheck[] = []
    let mode: 'app' | 'cli'
    let appId = '', cli = ''
    let material: SecretMaterial
    if (input.id) {
      const record = this.record(input.id)
      mode = record.mode
      appId = record.appId
      cli = record.cli
      try { material = this.options.vault.read('feishu', input.id) ?? {} }
      catch { return [credentialCheck('material', false, 'feishuCredentialUnreadable')] }
    } else {
      const parsed = FeishuCredentialInputSchema.partial().parse(input.input ?? {})
      mode = parsed.mode ?? 'app'
      appId = parsed.appId ?? ''
      cli = parsed.cli ?? ''
      material = this.materialOf(parsed)
    }
    const missing = mode === 'app' ? !appId || !material.appSecret : !cli
    if (missing) return [credentialCheck('identity', false, 'feishuCredentialMaterialMissing')]
    checks.push(credentialCheck('identity', true, mode === 'app' ? 'feishuCredentialAppOk' : 'feishuCredentialCliOk',
      mode === 'app' ? { appId, secret: mask(material.appSecret ?? '') } : { cli }))
    const spaceId = (input.spaceId ?? '').trim()
    try {
      const result = await this.options.probe({ mode, appId, appSecret: material.appSecret, cli, spaceId })
      checks.push(spaceId ? (result.nodes > 0
        ? credentialCheck('space', true, 'feishuCredentialSpaceOk', { spaceId })
        : credentialCheck('space', true, 'feishuCredentialSpaceEmpty', { spaceId }))
        : credentialCheck('space', true, 'feishuCredentialSpaceSkipped'))
    } catch (error) {
      checks.push(credentialCheck(spaceId ? 'space' : 'identity', false, classifyFeishuError(error), { spaceId,
        error: error instanceof Error ? error.message : String(error) }))
    }
    return checks
  }

  private record(id: string): FeishuCredential {
    const record = this.options.credentials.get(id)
    if (!record) throw new UserError('feishuCredentialNotInstalled', { credential: id })
    return record
  }
  private unique(base: string): string {
    let candidate = base, suffix = 2
    while (this.options.credentials.get(candidate)) candidate = `${base}-${suffix++}`
    return candidate
  }
  private materialOf(input: Partial<FeishuCredentialInput>): SecretMaterial {
    const material: SecretMaterial = {}
    if (input.appSecret) material.appSecret = input.appSecret.trim()
    return material
  }
  /** 应用模式必须有 App ID 与密钥；CLI 模式必须给出可执行文件。 */
  private requireComplete(mode: 'app' | 'cli', appId: string, cli: string, material: SecretMaterial): void {
    if (mode === 'app' ? !appId || !material.appSecret : !cli) throw new UserError('feishuCredentialMaterial')
  }
  private view(record: FeishuCredential): FeishuCredentialView {
    let material: SecretMaterial = {}
    let readable = true
    try { material = this.options.vault.read('feishu', record.id) ?? {} }
    catch { readable = false }
    const configured = readable && (record.mode === 'app' ? Boolean(record.appId && material.appSecret) : Boolean(record.cli))
    return { id: record.id, name: record.name, mode: record.mode, appId: record.appId, cli: record.cli, note: record.note,
      revision: record.revision, updatedAt: record.updatedAt, lastVerifiedAt: record.lastVerifiedAt, configured,
      fingerprint: record.mode === 'app' && material.appSecret ? fingerprint(material.appSecret) : '',
      hint: record.mode === 'app' && readable ? mask(material.appSecret ?? '') : '' }
  }
}

