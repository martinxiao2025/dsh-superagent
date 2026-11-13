/** 飞书凭据：独立于飞书来源记录存储，应用密钥在 `<stateDir>/secrets/feishu` 加密保存。 */
import { z } from 'zod'
import { LIMITS } from '../limits.ts'
import { CredentialIdSchema } from '../secrets/id.ts'

/** 身份来源：自建应用（App ID/Secret）或本机 lark CLI 的登录态。 */
export const FEISHU_CREDENTIAL_MODES = ['app', 'cli'] as const

/** 记录元数据（写入 SQLite）；应用密钥不在其中。 */
export const FeishuCredentialSchema = z.object({
  id: CredentialIdSchema,
  name: z.string().trim().min(1).max(LIMITS.sourceName),
  mode: z.enum(FEISHU_CREDENTIAL_MODES).default('app'),
  /** 自建应用身份；`cli` 模式留空。 */
  appId: z.string().trim().max(200).default(''),
  /** `cli` 模式下使用的 lark CLI 可执行文件；`app` 模式留空。 */
  cli: z.string().trim().max(1000).default(''),
  note: z.string().trim().max(500).default(''),
  revision: z.number().int().nonnegative().default(1),
  updatedAt: z.string().default(''),
  lastVerifiedAt: z.string().default(''),
}).strict()
export type FeishuCredential = z.infer<typeof FeishuCredentialSchema>

/** 创建与更新时提交的材料；`appSecret` 只在应用模式下必填。 */
export const FeishuCredentialInputSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.sourceName),
  mode: z.enum(FEISHU_CREDENTIAL_MODES).default('app'),
  appId: z.string().trim().max(200).optional(),
  appSecret: z.string().max(10_000).optional(),
  cli: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(500).optional(),
}).strict()
export type FeishuCredentialInput = z.infer<typeof FeishuCredentialInputSchema>

/** 提交给面板的凭据视图；只含掩码与可用性，不含应用密钥。 */
export interface FeishuCredentialView {
  id: string
  name: string
  mode: 'app' | 'cli'
  appId: string
  cli: string
  note: string
  revision: number
  updatedAt: string
  lastVerifiedAt: string
  configured: boolean
  fingerprint: string
  hint: string
}
