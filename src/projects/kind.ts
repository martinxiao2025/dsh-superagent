/** 项目：交付单元，引用一个代码仓库与一个任务来源，并声明轮询、重试与任务状态策略。 */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { LIMITS } from '../limits.ts'

/** 项目标识：与来源记录使用同一套命名规则。 */
export const ProjectIdSchema = z.string().trim().regex(/^[a-z][a-z0-9-]*$/, '项目 ID')
export const ProjectSchema = z.object({
  /** 面板与执行目录使用的名称，必填。 */
  name: z.string().trim().min(1).max(LIMITS.sourceName),
  enabled: z.boolean().default(true),
  /** 代码仓库记录 ID（一对一）。 */
  codeRepo: z.string().trim().min(1),
  /** 任务来源记录 ID。 */
  taskSource: z.string().trim().min(1),
  /** Git 凭据记录 ID；凭据材料不在设置快照里，这里只保存引用。 */
  gitCredential: z.string().trim().max(60).default(''),
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
