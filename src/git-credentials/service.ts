/** Git 凭据的增删改查、轮换与真实探测；材料只经过加密存储层。 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { UserError } from '../core/index.ts'
import { SecretVault, fingerprint, mask, type SecretMaterial } from '../secrets/vault.ts'
import { credentialCheck, type CredentialCheck } from '../secrets/check.ts'
import { CredentialService } from '../secrets/credential-service.ts'
import { GitCredentialInputSchema, GitCredentialSchema, type GitCredential, type GitCredentialInput,
  type GitCredentialView } from './kind.ts'
import type { GitAuth } from '../code-repos/sync.ts'

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
/**
 * 规范化 SSH 私钥文本：去 BOM、CRLF 转 LF、保证以换行结尾。
 * OpenSSH 拒绝不以换行结尾的私钥文件（`is not a key file` / `invalid format`），
 * 因此这里不能用会剥掉尾部换行的整串 `trim()`。
 */
export function normalizePrivateKey(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s*$/, '\n')
}
/** 把探测错误归入面板可本地化的失败原因。 */
export function classifyProbeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/permission denied|authentication failed|could not read from remote|access denied|\b40[13]\b/i.test(text)) return 'gitCredentialForbidden'
  if (/could not resolve|connection (refused|timed out)|timed out|network is unreachable|no route to host|operation timed out/i.test(text)) return 'gitCredentialUnreachable'
  if (/not found|does not exist|\b404\b/i.test(text)) return 'gitCredentialRepositoryMissing'
  return 'gitCredentialProbeFailed'
}
/** 把输入转成材料；`keyPath` 在这里读取，之后的展示与探测都只用加密材料。 */
function materialOfInput(input: Partial<GitCredentialInput>): SecretMaterial {
  const material: SecretMaterial = {}
  if (input.kind === undefined || input.kind === 'ssh') {
    const pasted = input.privateKey ?? ''
    const path = input.keyPath?.trim() ?? ''
    if (pasted.trim()) material.privateKey = normalizePrivateKey(pasted)
    else if (path) {
      if (!isAbsolute(path)) throw new UserError('gitCredentialKeyPath', { path })
      if (!existsSync(path)) throw new UserError('gitCredentialKeyPathMissing', { path })
      material.privateKey = normalizePrivateKey(readFileSync(path, 'utf8'))
    }
    if (input.passphrase) material.passphrase = input.passphrase
  }
  if (input.token) material.token = input.token.trim()
  return material
}
/** 提交里出现任一材料字段就视为替换材料。 */
function hasMaterial(input: Partial<GitCredentialInput>): boolean {
  return input.privateKey !== undefined || input.keyPath !== undefined || input.token !== undefined || input.passphrase !== undefined
}
/** ssh 必须有私钥，https 必须有令牌。 */
function complete(kind: 'ssh' | 'https', material: SecretMaterial): boolean {
  return kind === 'ssh' ? Boolean(material.privateKey) : Boolean(material.token)
}
function hint(kind: 'ssh' | 'https', material: SecretMaterial): string {
  if (kind === 'ssh') return KEY_PATTERN.test(material.privateKey ?? '') ? 'private key' : ''
  return mask(material.token ?? '')
}
function redact(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\/\/[^/@\s]+@/g, '//***@')
}

/** Git 凭据服务：元数据写入 SQLite，材料写入加密存储；校验端点与飞书凭据各自独立。 */
export class GitCredentials extends CredentialService<GitCredential, GitCredentialInput, GitCredentialView> {
  constructor(private readonly options: GitCredentialsOptions) {
    super({
      area: 'git',
      records: options.credentials,
      vault: options.vault,
      codes: { exists: 'gitCredentialExists', notInstalled: 'gitCredentialNotInstalled',
        material: 'gitCredentialMaterial', inUse: 'gitCredentialInUse' },
      references: () => Object.values(options.projects()).flatMap(project => project.gitCredential ? [project.gitCredential] : []),
      parseInput: input => GitCredentialInputSchema.parse(input),
      parsePartial: input => GitCredentialInputSchema.partial().parse(input),
      materialOf: materialOfInput,
      replaces: hasMaterial,
      complete: (record, secret) => complete(record.kind, secret),
      createRecord: (id, input, at) => GitCredentialSchema.parse({ id, name: input.name, kind: input.kind, provider: input.provider,
        username: input.username ?? '', note: input.note ?? '', origin: input.keyPath ? 'file' : 'pasted',
        keyPath: input.keyPath ?? '', revision: 1, updatedAt: at, lastVerifiedAt: '' }),
      mergeRecord: (current, input, at) => GitCredentialSchema.parse({ ...current, name: input.name, kind: input.kind,
        provider: input.provider, username: input.username ?? current.username, note: input.note ?? current.note,
        origin: input.keyPath ? 'file' : hasMaterial(input) ? 'pasted' : current.origin, keyPath: input.keyPath ?? current.keyPath,
        revision: current.revision + 1, updatedAt: at }),
      rotateRecord: (current, input, at) => GitCredentialSchema.parse({ ...current, revision: current.revision + 1, updatedAt: at,
        origin: input.keyPath ? 'file' : 'pasted', keyPath: input.keyPath ?? current.keyPath }),
      viewOf: (record, secret, readable) => {
        const configured = readable && complete(record.kind, secret)
        const text = record.kind === 'ssh' ? secret.privateKey ?? '' : secret.token ?? ''
        return { id: record.id, name: record.name, kind: record.kind, provider: record.provider, username: record.username,
          note: record.note, origin: record.origin, keyPath: record.keyPath, revision: record.revision,
          updatedAt: record.updatedAt, lastVerifiedAt: record.lastVerifiedAt, configured,
          fingerprint: text ? fingerprint(text) : '', hint: readable ? hint(record.kind, secret) : '' }
      },
      now: options.now,
    })
  }

  /** 只给出认证方式与账号名，供解析项目仓库时使用；不接触材料。 */
  metaOf(id: string): { kind: 'ssh' | 'https'; username: string } | undefined {
    const record = this.options.credentials.get(id)
    return record ? { kind: record.kind, username: record.username || 'git' } : undefined
  }
  /** 供项目同步使用的一次性材料；未安装、材料缺失或不可读时返回 undefined。 */
  authOf(id: string): GitAuth | undefined {
    const record = this.options.credentials.get(id)
    if (!record) return undefined
    let material: SecretMaterial
    try { material = this.options.vault.read('git', id) ?? {} } catch { return undefined }
    if (!complete(record.kind, material)) return undefined
    return { kind: record.kind, material: { username: record.username || 'x-access-token',
      token: material.token ?? '', privateKey: material.privateKey ?? '' } }
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
      material = materialOfInput(parsed)
    }
    if (!complete(kind, material)) return [credentialCheck('material', false, 'gitCredentialMaterialMissing')]
    checks.push(credentialCheck('material', true, 'gitCredentialMaterialOk', { hint: hint(kind, material) }))
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
      checks.push(credentialCheck('repository', false, classifyProbeError(error), { error: redact(error) }))
    }
    return checks
  }
}
