/** 项目：交付单元，自带代码仓库与任务来源，并声明轮询、重试与任务状态策略。 */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { CodeRepoKindSchema } from '../code-repos/kind.ts'
import { LIMITS } from '../limits.ts'
import { TaskSourceKindSchema } from '../task-sources/kind.ts'

/** 项目标识：与来源记录使用同一套命名规则。 */
export const ProjectIdSchema = z.string().trim().regex(/^[a-z][a-z0-9-]*$/, '项目 ID')

/** 项目内嵌的代码仓库配置：类型与配置一起保存，不再引用独立的仓库记录。 */
export const ProjectRepoSchema = z.object({
  /** 仓库类型；GitHub 与 GitLab 只负责克隆、同步与凭据，不产生任务。 */
  kind: CodeRepoKindSchema.default('github'),
  /** 类型各自的配置（实例地址、仓库路径、CLI 与远端地址），由类型 schema 在保存时校验。 */
  config: z.record(z.string(), z.unknown()).default({}),
}).strict()
export type ProjectRepo = z.infer<typeof ProjectRepoSchema>

/** 项目内嵌的任务来源配置：类型与配置一起保存，不再引用独立的来源记录。 */
export const ProjectTaskSourceSchema = z.object({
  /** 任务来源驱动名；保存时要求驱动已注册。 */
  kind: TaskSourceKindSchema.default('excel'),
  /** 驱动配置；飞书凭据与仓库位置由项目统一注入，不从配置读取。 */
  config: z.record(z.string(), z.unknown()).default({}),
}).strict()
export type ProjectTaskSource = z.infer<typeof ProjectTaskSourceSchema>

/** 项目仓库解析到部署来源时使用的标识；带前缀以避免与消息来源记录 ID 冲突，同时可作为目录名。 */
export const projectRepoId = (projectId: string): string => `repo-${projectId}`

export const ProjectSchema = z.object({
  /** 面板与执行目录使用的名称，必填。 */
  name: z.string().trim().min(1).max(LIMITS.sourceName),
  enabled: z.boolean().default(true),
  /** 代码仓库：每个项目自带一个，直接使用项目选择的 Git 凭据访问。 */
  codeRepo: ProjectRepoSchema.default(() => ({ kind: 'github' as const, config: {} })),
  /** 任务来源：每个项目自带一个，飞书类来源使用项目选择的飞书凭据。 */
  taskSource: ProjectTaskSourceSchema.default(() => ({ kind: 'excel', config: {} })),
  /** Git 凭据记录 ID；凭据材料不在设置快照里，这里只保存引用。 */
  gitCredential: z.string().trim().max(60).default(''),
  /** 飞书凭据记录 ID；飞书类任务来源统一使用它，配置里不再保存凭据 ID。 */
  feishuCredential: z.string().trim().max(60).default(''),
  execution: z.object({
    directory: z.string().trim().refine(path => path === '' || isAbsolute(path), 'An absolute path, or empty for <stateDir>/work').default(''),
    branch: z.string().trim().max(200).default(''),
  }).strict().default(() => ({ directory: '', branch: '' })),
  schedule: z.object({
    intervalMinutes: z.number().int().min(LIMITS.projectIntervalMinutes.min).max(LIMITS.projectIntervalMinutes.max).default(30),
    runOnStart: z.boolean().default(true),
  }).strict().default(() => ({ intervalMinutes: 30, runOnStart: true })),
  retry: z.object({
    maxRetries: z.number().int().min(LIMITS.projectMaxRetries.min).max(LIMITS.projectMaxRetries.max).default(2),
    retryBackoffSeconds: z.number().int().min(LIMITS.projectRetryBackoffSeconds.min).max(LIMITS.projectRetryBackoffSeconds.max).default(60),
  }).strict().default(() => ({ maxRetries: 2, retryBackoffSeconds: 60 })),
  taskPolicy: z.object({
    /** 只有这些状态的任务会被准入；逗号分隔的配置在保存时已转成数组。 */
    pendingStatuses: z.array(z.string().trim().min(1).max(100)).min(1).default(['待处理', 'todo', 'pending', 'open']),
    doneStatus: z.string().trim().min(1).max(100).default('已完成'),
    failedStatus: z.string().trim().min(1).max(100).default('失败'),
  }).strict().default(() => ({ pendingStatuses: ['待处理', 'todo', 'pending', 'open'], doneStatus: '已完成', failedStatus: '失败' })),
}).strict()
export type Project = z.infer<typeof ProjectSchema>
