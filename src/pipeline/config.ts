/** 流水线记录配置：代码源、任务源、时间表、执行与回写。 */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { LIMITS } from '../limits.ts'

/** 非空时必须是绝对路径，避免相对路径随进程工作目录漂移。 */
const AbsolutePath = z.string().trim().refine(value => value === '' || isAbsolute(value), { message: '必须是绝对路径' })

/**
 * 判断远端地址是否内嵌了用户名与密码。
 * `https://user:pass@host/repo` 会把凭据写进配置文件，因此一律拒绝；`git@host:path` 这类 SSH 地址不受影响。
 */
export function hasEmbeddedCredentials(remote: string): boolean {
  return /[^/@\s]+:[^/@\s]+@/.test(remote)
}

/** 可选远端地址：为空表示按来源记录生成，非空时拒绝内嵌凭据。 */
const RemoteUrl = z.string().trim().max(500)
  .refine(value => !hasEmbeddedCredentials(value), { message: '远端地址不能包含用户名或密码' })

/**
 * 一条 `pipeline` 来源记录的配置。字段保持扁平，便于面板按字段键直接读写；
 * 空值表示尚未配置，由 `pipelineProblems` 在运行时给出具体问题。
 */
export const PipelineConfigSchema = z.object({
  codeSource: z.string().trim().max(64).default(''),
  /** 可选远端地址；为空时按代码来源记录生成 HTTPS 地址。 */
  remoteUrl: RemoteUrl.default(''),
  branch: z.string().trim().max(200).default(''),
  directory: AbsolutePath.default(''),
  taskKind: z.enum(['excel', 'feishu']).default('excel'),
  /** 读取飞书知识库所用的飞书来源记录；读取凭据来自该记录的机器人 CLI。 */
  feishuSource: z.string().trim().max(64).default(''),
  taskFile: AbsolutePath.default(''),
  taskSheet: z.string().trim().max(100).default(''),
  wikiUrl: z.string().trim().max(500).default(''),
  columnId: z.string().trim().max(100).default('id'),
  columnTitle: z.string().trim().max(100).default('title'),
  columnDescription: z.string().trim().max(100).default('description'),
  columnStatus: z.string().trim().max(100).default('status'),
  columnPriority: z.string().trim().max(100).default('priority'),
  pendingStatuses: z.string().trim().max(300).default('待处理,todo,pending,open'),
  intervalMinutes: z.number().int().min(1).max(1440).default(30),
  runOnStart: z.boolean().default(true),
  concurrency: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(1),
  maxRetries: z.number().int().min(0).max(10).default(2),
  retryBackoffSeconds: z.number().int().min(0).max(3600).default(60),
  doneStatus: z.string().trim().max(100).default('已完成'),
  failedStatus: z.string().trim().max(100).default('失败'),
}).strict()
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>

/** 表头到任务字段的映射；空映射表示该字段不读取。 */
export interface TaskColumns {
  id: string
  title: string
  description: string
  status: string
  priority: string
}

/** 从流水线配置中取出任务源列映射。 */
export const taskColumns = (config: PipelineConfig): TaskColumns => ({ id: config.columnId, title: config.columnTitle,
  description: config.columnDescription, status: config.columnStatus, priority: config.columnPriority })

/** 待办状态集合；逗号分隔，忽略空白项。 */
export const pendingStatuses = (config: PipelineConfig): string[] =>
  config.pendingStatuses.split(',').map(item => item.trim()).filter(Boolean)

/** 返回配置中仍然缺失或不可用的项，用于让记录进入 `problem` 而不是静默停用。 */
export function pipelineProblems(config: PipelineConfig, codeKinds: Readonly<Record<string, string>>): string[] {
  const problems: string[] = []
  if (!config.codeSource) problems.push('未选择代码来源记录')
  else if (codeKinds[config.codeSource] !== 'github' && codeKinds[config.codeSource] !== 'gitlab') {
    problems.push('代码来源记录不存在或不是 GitHub / GitLab')
  }
  if (config.taskKind === 'excel') {
    if (!config.taskFile) problems.push('未填写任务清单文件')
    else if (!isAbsolute(config.taskFile)) problems.push('任务清单文件必须是绝对路径')
  } else {
    if (!config.wikiUrl) problems.push('未填写飞书知识库地址')
    if (!config.feishuSource) problems.push('未选择飞书来源记录')
    else if (codeKinds[config.feishuSource] !== 'feishu') problems.push('飞书来源记录不存在或类型不是飞书')
  }
  if (!config.columnId || !config.columnTitle) problems.push('任务编号与标题的列名不能为空')
  return problems
}
