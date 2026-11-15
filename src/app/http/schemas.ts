/** 管理 API 的请求校验 schema：每条路由的查询串与请求体在此集中定义，与 `Api` 类型契约一一对应。 */
import { z } from 'zod'
import { LIMITS } from '../../limits.ts'
import { THREAD_FILTERS, TICKET_FILTERS } from '../api.ts'
import { GitCredentialInputSchema } from '../../git-credentials/kind.ts'
import { FeishuCredentialInputSchema } from '../../feishu-credentials/kind.ts'

const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
export const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
export const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
export const QueueQuery = z.object({ offset, limit: limit(200, 1000) })
export const ProjectTasksQuery = z.object({ offset, limit: limit(50, 1000) })
export const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
export const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
export const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const RecordBlock = z.templateLiteral([z.enum(['source', 'project']), ':', z.string().regex(/^[a-z][a-z0-9-]*$/)])
export const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor', 'models']), RecordBlock])
export const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })
const ResourceId = z.string().regex(/^[a-z][a-z0-9-]*$/)
export const CreateProjectRequest = z.object({ id: ResourceId.optional() }).passthrough()
export const CreateSourceRequest = z.object({ kind: ResourceId, id: ResourceId.optional(),
  name: z.string().trim().min(1).max(LIMITS.sourceName), config: z.unknown().optional() })
export const VerifySourceRequest = z.object({ kind: ResourceId, id: ResourceId.optional(),
  name: z.string().trim().max(LIMITS.sourceName).optional(), config: z.unknown().optional(), field: z.string().max(40).optional() })
const ProjectRepoSchema = z.object({ kind: z.enum(['github', 'gitlab']), config: z.record(z.string(), z.unknown()).default({}) })
export const VerifyCodeRepoRequest = z.object({ kind: z.enum(['github', 'gitlab']), config: z.unknown().optional(),
  field: z.string().max(40).optional(), gitCredential: z.string().trim().max(60).optional() })
export const VerifyTaskSourceRequest = z.object({ kind: z.string().regex(/^[a-z][a-z0-9-]*$/), config: z.unknown().optional(),
  field: z.string().max(40).optional(), projectId: ResourceId.optional(), repo: ProjectRepoSchema.optional(),
  gitCredential: z.string().trim().max(60).optional(), feishuCredential: z.string().trim().max(60).optional() })
export const CreateGitCredentialRequest = z.object({ id: ResourceId.optional(), value: GitCredentialInputSchema })
export const UpdateGitCredentialRequest = z.object({ value: GitCredentialInputSchema, revision: z.number().int().nonnegative() })
export const RotateGitCredentialRequest = GitCredentialInputSchema.partial()
export const VerifyGitCredentialRequest = z.object({ id: ResourceId.optional(), value: GitCredentialInputSchema.partial().optional(),
  repository: z.string().trim().max(2000).optional() })
export const CreateFeishuCredentialRequest = z.object({ id: ResourceId.optional(), value: FeishuCredentialInputSchema })
export const UpdateFeishuCredentialRequest = z.object({ value: FeishuCredentialInputSchema, revision: z.number().int().nonnegative() })
export const RotateFeishuCredentialRequest = FeishuCredentialInputSchema.partial()
export const VerifyFeishuCredentialRequest = z.object({ id: ResourceId.optional(), value: FeishuCredentialInputSchema.partial().optional(),
  spaceId: z.string().trim().max(80).optional() })
export const FeishuImChatsRequest = z.object({ credential: z.string().trim().max(60) })
export const PauseRequest = z.object({ paused: z.boolean() })
export const SavePromptsRequest = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() })
export const ResetRequest = z.object({ confirm: z.literal('RESET') })
