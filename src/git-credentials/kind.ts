/** Git 凭据：独立于代码仓库记录存储，材料在 `<stateDir>/secrets/git` 加密保存。 */
import { z } from 'zod'
import { LIMITS } from '../limits.ts'
import { CredentialIdSchema } from '../secrets/id.ts'

/** 认证方式：SSH 私钥或 HTTPS 访问令牌。 */
export const GIT_CREDENTIAL_KINDS = ['ssh', 'https'] as const
/** 托管平台；`generic` 表示自建或未识别的站点。 */
export const GIT_CREDENTIAL_PROVIDERS = ['github', 'gitlab', 'generic'] as const

/** 记录元数据（写入 SQLite）；私钥与令牌不在其中。 */
export const GitCredentialSchema = z.object({
  id: CredentialIdSchema,
  name: z.string().trim().min(1).max(LIMITS.sourceName),
  kind: z.enum(GIT_CREDENTIAL_KINDS),
  provider: z.enum(GIT_CREDENTIAL_PROVIDERS).default('generic'),
  /** HTTPS 的用户名；SSH 留空。 */
  username: z.string().trim().max(200).default(''),
  note: z.string().trim().max(500).default(''),
  /** 材料来源：粘贴，或从本机路径读取后同样加密保存。 */
  origin: z.enum(['pasted', 'file']).default('pasted'),
  /** 仅作展示；私钥内容不会保存在这里。 */
  keyPath: z.string().trim().max(1000).default(''),
  revision: z.number().int().nonnegative().default(1),
  updatedAt: z.string().default(''),
  lastVerifiedAt: z.string().default(''),
}).strict()
export type GitCredential = z.infer<typeof GitCredentialSchema>

/** 创建、更新与轮换时提交的材料；字段按认证方式取用。 */
export const GitCredentialInputSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.sourceName),
  kind: z.enum(GIT_CREDENTIAL_KINDS),
  provider: z.enum(GIT_CREDENTIAL_PROVIDERS).default('generic'),
  username: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
  /** 粘贴的 OpenSSH/PEM 私钥。 */
  privateKey: z.string().max(100_000).optional(),
  /** 本机私钥路径；保存时读取内容并按材料加密，路径只作展示。 */
  keyPath: z.string().trim().max(1000).optional(),
  /** 私钥口令；留空表示无口令。 */
  passphrase: z.string().max(10_000).optional(),
  /** HTTPS 访问令牌。 */
  token: z.string().max(10_000).optional(),
}).strict()
export type GitCredentialInput = z.infer<typeof GitCredentialInputSchema>

/** 提交给面板的凭据视图；只含指纹、掩码与可用性，不含材料。 */
export interface GitCredentialView {
  id: string
  name: string
  kind: 'ssh' | 'https'
  provider: 'github' | 'gitlab' | 'generic'
  username: string
  note: string
  origin: 'pasted' | 'file'
  keyPath: string
  revision: number
  updatedAt: string
  lastVerifiedAt: string
  /** 材料是否可读且完整。 */
  configured: boolean
  /** 材料指纹（轮换后变化）；空表示没有材料。 */
  fingerprint: string
  /** 材料的掩码提示，例如 `••••abcd` 或 `ed25519`。 */
  hint: string
}
