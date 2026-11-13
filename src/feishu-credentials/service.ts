/** 飞书凭据的增删改查、轮换与身份校验；应用密钥只经过加密存储层。 */
import { SecretVault, fingerprint, mask, type SecretMaterial } from '../secrets/vault.ts'
import { credentialCheck, type CredentialCheck } from '../secrets/check.ts'
import { CredentialService } from '../secrets/credential-service.ts'
import { feishuFailureCode } from '../feishu-transport.ts'
import { FeishuCredentialInputSchema, FeishuCredentialSchema, type FeishuCredential, type FeishuCredentialInput,
  type FeishuCredentialView } from './kind.ts'

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

/** 把探测错误归入面板可本地化的失败原因；语义判定由传输层的分类表单点维护。 */
export function classifyFeishuError(error: unknown): string {
  return feishuFailureCode(error, { forbidden: 'feishuCredentialForbidden', rateLimited: 'feishuCredentialRateLimited',
    unreachable: 'feishuCredentialUnreachable', missing: 'feishuCredentialSpaceMissing', fallback: 'feishuCredentialProbeFailed' })
}

/** 应用密钥是飞书域唯一的材料字段；空值不落盘。 */
const materialOf = (input: Partial<FeishuCredentialInput>): SecretMaterial => {
  const material: SecretMaterial = {}
  if (input.appSecret) material.appSecret = input.appSecret.trim()
  return material
}
/** 应用模式必须有 App ID 与密钥；CLI 模式必须给出可执行文件。 */
const complete = (record: Pick<FeishuCredential, 'mode' | 'appId' | 'cli'>, material: SecretMaterial): boolean =>
  record.mode === 'app' ? Boolean(record.appId && material.appSecret) : Boolean(record.cli)

/** 飞书凭据服务：元数据写入 SQLite，应用密钥写入加密存储；与 Git 凭据互不复用路由或材料。 */
export class FeishuCredentials extends CredentialService<FeishuCredential, FeishuCredentialInput, FeishuCredentialView> {
  constructor(private readonly options: FeishuCredentialsOptions) {
    super({
      area: 'feishu',
      records: options.credentials,
      vault: options.vault,
      codes: { exists: 'feishuCredentialExists', notInstalled: 'feishuCredentialNotInstalled',
        material: 'feishuCredentialMaterial', inUse: 'feishuCredentialInUse' },
      references: () => options.references(),
      parseInput: input => FeishuCredentialInputSchema.parse(input),
      parsePartial: input => FeishuCredentialInputSchema.partial().parse(input),
      materialOf,
      replaces: input => input.appSecret !== undefined,
      complete,
      createRecord: (id, input, at) => FeishuCredentialSchema.parse({ id, name: input.name, mode: input.mode,
        appId: input.appId ?? '', cli: input.cli ?? '', note: input.note ?? '', revision: 1, updatedAt: at, lastVerifiedAt: '' }),
      mergeRecord: (current, input, at) => FeishuCredentialSchema.parse({ ...current, name: input.name, mode: input.mode,
        appId: input.appId ?? current.appId, cli: input.cli ?? current.cli, note: input.note ?? current.note,
        revision: current.revision + 1, updatedAt: at }),
      rotateRecord: (current, input, at) => FeishuCredentialSchema.parse({ ...current, appId: input.appId ?? current.appId,
        cli: input.cli ?? current.cli, revision: current.revision + 1, updatedAt: at }),
      viewOf: (record, material, readable) => {
        const configured = readable && complete(record, material)
        return { id: record.id, name: record.name, mode: record.mode, appId: record.appId, cli: record.cli, note: record.note,
          revision: record.revision, updatedAt: record.updatedAt, lastVerifiedAt: record.lastVerifiedAt, configured,
          fingerprint: record.mode === 'app' && material.appSecret ? fingerprint(material.appSecret) : '',
          hint: record.mode === 'app' && readable ? mask(material.appSecret ?? '') : '' }
      },
      now: options.now,
    })
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
      material = materialOf(parsed)
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
}
