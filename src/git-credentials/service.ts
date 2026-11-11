/** Git 凭据的增删改查、轮换与真实探测；材料只经过加密存储层。 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { UserError } from '../core/index.ts'
import { SecretVault, fingerprint, mask, type SecretMaterial } from '../secrets/vault.ts'
import { credentialCheck, type CredentialCheck } from '../secrets/check.ts'
import { GitCredentialInputSchema, GitCredentialSchema, type GitCredential, type GitCredentialInput,
  type GitCredentialView } from './kind.ts'
import { credentialId } from '../secrets/id.ts'

/** 记录层只依赖最小读写接口，便于用内存实现测试。 */
export interface GitCredentialRepository {
  get(id: string): GitCredential | undefined
  list(): GitCredential[]
  save(value: GitCredential): void
  remove(id: string): void
}
/** 远端探测：测试注入假实现，生产环境用 `git ls-remote`。 */
export type GitProbe = (input: { remote: string; kind: 'ssh' | 'https'; material: SecretMaterial }) => Promise<{ branches: number }>
export interface GitCredentialsOptions {
  credentials: GitCredentialRepository
  vault: SecretVault
  /** 项目对凭据的引用；删除时据此拒绝。 */
  projects: () => Record<string, { gitCredential?: string }>
  probe: GitProbe
  now?: () => string
}

/** SSH 私钥的最小形状检查；不做口令解密。 */
const KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
/** 把探测错误归入面板可本地化的失败原因。 */
export function classifyProbeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/permission denied|authentication failed|could not read from remote|access denied|\b40[13]\b/i.test(text)) return 'gitCredentialForbidden'
  if (/could not resolve|connection (refused|timed out)|timed out|network is unreachable|no route to host|operation timed out/i.test(text)) return 'gitCredentialUnreachable'
  if (/not found|does not exist|\b404\b/i.test(text)) return 'gitCredentialRepositoryMissing'
  return 'gitCredentialProbeFailed'
}

/** Git 凭据服务：元数据写入 SQLite，材料写入加密存储；校验端点与飞书凭据各自独立。 */
export class GitCredentials {
  private readonly now: () => string
  constructor(private readonly options: GitCredentialsOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /** 全部凭据视图，按记录 ID 排序。 */
  list(): GitCredentialView[] {
    return this.options.credentials.list().sort((a, b) => a.id.localeCompare(b.id)).map(record => this.view(record))
  }
  /** 单条凭据视图；不存在时抛 404。 */
  get(id: string): GitCredentialView {
    return this.view(this.record(id))
  }
  /** 创建凭据：材料先落盘再写元数据，任一步失败都不留下半条记录。 */
  create(input: unknown, id?: string): { id: string; revision: number } {
    const parsed = GitCredentialInputSchema.parse(input)
    const recordId = id ?? this.unique(credentialId(parsed.name))
    if (this.options.credentials.get(recordId)) throw new UserError('gitCredentialExists', { credential: recordId })
    const material = this.material(parsed)
    if (!this.complete(parsed.kind, material)) throw new UserError('gitCredentialMaterial')
    const record = GitCredentialSchema.parse({ id: recordId, name: parsed.name, kind: parsed.kind, provider: parsed.provider,
      username: parsed.username ?? '', note: parsed.note ?? '', origin: parsed.keyPath ? 'file' : 'pasted',
      keyPath: parsed.keyPath ?? '', revision: 1, updatedAt: this.now(), lastVerifiedAt: '' })
    this.options.vault.save('git', recordId, material)
    try { this.options.credentials.save(record) } catch (error) {
      this.options.vault.remove('git', recordId)
      throw error
    }
    return { id: recordId, revision: record.revision }
  }
  /** 更新元数据；提交了材料字段时一并替换材料。 */
  update(id: string, input: unknown, revision: number): { revision: number } {
    const current = this.record(id)
    if (current.revision !== revision) throw new UserError('credentialRevisionStale')
    const parsed = GitCredentialInputSchema.parse(input)
    const replaced = this.hasMaterial(parsed)
    const material = replaced ? this.material(parsed) : this.options.vault.read('git', id) ?? {}
    const kind = parsed.kind
    if (!this.complete(kind, material)) throw new UserError('gitCredentialMaterial')
    const record = GitCredentialSchema.parse({ ...current, name: parsed.name, kind, provider: parsed.provider,
      username: parsed.username ?? current.username, note: parsed.note ?? current.note,
      origin: parsed.keyPath ? 'file' : replaced ? 'pasted' : current.origin, keyPath: parsed.keyPath ?? current.keyPath,
      revision: current.revision + 1, updatedAt: this.now() })
    if (replaced) this.options.vault.save('git', id, material)
    this.options.credentials.save(record)
    return { revision: record.revision }
  }
  /** 只替换材料，元数据与认证方式保持不变；引用方应重新校验。 */
  rotate(id: string, material: unknown): { revision: number } {
    const current = this.record(id)
    const input = GitCredentialInputSchema.partial().parse(material ?? {})
    const parsed = this.material(input)
    if (!this.complete(current.kind, parsed)) throw new UserError('gitCredentialMaterial')
    this.options.vault.save('git', id, parsed)
    const record = GitCredentialSchema.parse({ ...current, revision: current.revision + 1, updatedAt: this.now(),
      origin: input.keyPath ? 'file' : 'pasted', keyPath: input.keyPath ?? current.keyPath })
    this.options.credentials.save(record)
    return { revision: record.revision }
  }
  /** 删除凭据；仍被项目引用时拒绝。 */
  remove(id: string): { removed: true } {
    this.record(id)
    const used = Object.values(this.options.projects()).filter(project => project.gitCredential === id).length
    if (used) throw new UserError('gitCredentialInUse', { credential: id, count: String(used) })
    this.options.credentials.remove(id)
    this.options.vault.remove('git', id)
    return { removed: true }
  }
  /** 校验已有凭据或尚未保存的候选材料；只读，不写记录。 */
  async verify(input: { id?: string; input?: unknown; repository?: string }): Promise<CredentialCheck[]> {
    const checks: CredentialCheck[] = []
    let kind: 'ssh' | 'https'
    let material: SecretMaterial
    if (input.id) {
      const record = this.record(input.id)
      kind = record.kind
      try { material = this.options.vault.read('git', input.id) ?? {} }
      catch { return [credentialCheck('material', false, 'gitCredentialUnreadable')] }
    } else {
      const parsed = GitCredentialInputSchema.partial().parse(input.input ?? {})
      kind = parsed.kind ?? 'ssh'
      material = this.material(parsed)
    }
    if (!this.complete(kind, material)) return [credentialCheck('material', false, 'gitCredentialMaterialMissing')]
    checks.push(credentialCheck('material', true, 'gitCredentialMaterialOk', { hint: this.hint(kind, material) }))
    if (kind === 'ssh' && !KEY_PATTERN.test(material.privateKey ?? '')) {
      checks.push(credentialCheck('key', false, 'gitCredentialKeyInvalid'))
      return checks
    }
    const remote = (input.repository ?? '').trim()
    if (!remote) return checks
    const scheme = kind === 'ssh' ? /^(ssh:\/\/|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:)/ : /^https?:\/\//
    if (!scheme.test(remote)) {
      checks.push(credentialCheck('repository', false, 'gitCredentialKindMismatch', { kind }))
      return checks
    }
    try {
      const result = await this.options.probe({ remote, kind, material })
      checks.push(result.branches > 0
        ? credentialCheck('repository', true, 'gitCredentialRemoteOk', { branches: String(result.branches) })
        : credentialCheck('repository', true, 'gitCredentialRepositoryEmpty'))
    } catch (error) {
      checks.push(credentialCheck('repository', false, classifyProbeError(error), { error: this.redact(error) }))
    }
    return checks
  }

  private redact(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/\/\/[^/@\s]+@/g, '//***@')
  }
  private record(id: string): GitCredential {
    const record = this.options.credentials.get(id)
    if (!record) throw new UserError('gitCredentialNotInstalled', { credential: id })
    return record
  }
  private unique(base: string): string {
    let candidate = base, suffix = 2
    while (this.options.credentials.get(candidate)) candidate = `${base}-${suffix++}`
    return candidate
  }
  /** 提交里出现任一材料字段就视为替换材料。 */
  private hasMaterial(input: Partial<GitCredentialInput>): boolean {
    return input.privateKey !== undefined || input.keyPath !== undefined || input.token !== undefined || input.passphrase !== undefined
  }
  /** 把输入转成材料；`keyPath` 在这里读取，之后的展示与探测都只用加密材料。 */
  private material(input: Partial<GitCredentialInput>): SecretMaterial {
    const material: SecretMaterial = {}
    if (input.kind === undefined || input.kind === 'ssh') {
      const pasted = input.privateKey?.trim() ?? ''
      const path = input.keyPath?.trim() ?? ''
      if (pasted) material.privateKey = pasted
      else if (path) {
        if (!isAbsolute(path)) throw new UserError('gitCredentialKeyPath', { path })
        if (!existsSync(path)) throw new UserError('gitCredentialKeyPathMissing', { path })
        material.privateKey = readFileSync(path, 'utf8').trim()
      }
      if (input.passphrase) material.passphrase = input.passphrase
    }
    if (input.token) material.token = input.token.trim()
    return material
  }
  private complete(kind: 'ssh' | 'https', material: SecretMaterial): boolean {
    return kind === 'ssh' ? Boolean(material.privateKey) : Boolean(material.token)
  }
  private hint(kind: 'ssh' | 'https', material: SecretMaterial): string {
    if (kind === 'ssh') return KEY_PATTERN.test(material.privateKey ?? '') ? 'private key' : ''
    return mask(material.token ?? '')
  }
  private view(record: GitCredential): GitCredentialView {
    let material: SecretMaterial = {}
    let readable = true
    try { material = this.options.vault.read('git', record.id) ?? {} }
    catch { readable = false }
    const configured = readable && this.complete(record.kind, material)
    const secret = record.kind === 'ssh' ? material.privateKey ?? '' : material.token ?? ''
    return { id: record.id, name: record.name, kind: record.kind, provider: record.provider, username: record.username,
      note: record.note, origin: record.origin, keyPath: record.keyPath, revision: record.revision,
      updatedAt: record.updatedAt, lastVerifiedAt: record.lastVerifiedAt, configured,
      fingerprint: secret ? fingerprint(secret) : '', hint: readable ? this.hint(record.kind, material) : '' }
  }
}
