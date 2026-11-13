/** 任务来源记录与驱动契约：来源位置、字段映射、真实预检与任务读取都由驱动自己负责。 */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import { LIMITS } from '../limits.ts'
import type { RawTask } from './tasks.ts'
import type { FeishuWikiApi } from './feishu-api.ts'
import type { FeishuImApi } from './feishu-im-api.ts'
import type { WriteTarget } from './writeback.ts'
import type { FieldSpec, Localized } from '../sources/kind.ts'
import { checkFailed, checkPassed, type SourceCheck } from '../setup.ts'

/** 驱动注册名：小写字母开头，允许数字与连字符。内置 `excel`、`feishu-im` 与 `feishu-wiki`。 */
export const TaskSourceKindSchema = z.string().trim().regex(/^[a-z][a-z0-9-]*$/, '任务来源类型')
export const TaskSourceRecordSchema = z.object({
  kind: TaskSourceKindSchema,
  /** 面板显示的名称，必填。 */
  name: z.string().trim().min(1).max(LIMITS.sourceName),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict()
export type TaskSourceRecord = z.infer<typeof TaskSourceRecordSchema>

/** 外部清单的列名到任务字段的映射。 */
export const TaskFieldMapSchema = z.object({
  id: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(100),
  status: z.string().trim().max(100),
  priority: z.string().trim().max(100),
}).strict()
export type TaskFieldMap = z.infer<typeof TaskFieldMapSchema>

/** 标准任务列（016 与 013 §3.3 共用）：界面语言不影响表头。 */
export const DEFAULT_TASK_FIELDS: TaskFieldMap = { id: 'task_id', title: 'title', description: 'description', status: 'status', priority: 'priority' }

/** 面板扁平列字段：任务来源记录按字段键直接保存，避免嵌套配置难以逐字段预检。 */
export interface TaskColumnConfig {
  idColumn: string
  titleColumn: string
  descriptionColumn: string
  statusColumn: string
  priorityColumn: string
}
/** 把扁平列字段转成任务字段映射。 */
export const taskColumnsOf = (config: TaskColumnConfig): TaskFieldMap => ({ id: config.idColumn, title: config.titleColumn,
  description: config.descriptionColumn, status: config.statusColumn, priority: config.priorityColumn })
/** 可复用的列字段 schema 定义。 */
export const taskColumnShape = {
  idColumn: z.string().trim().max(100).default(DEFAULT_TASK_FIELDS.id),
  titleColumn: z.string().trim().max(100).default(DEFAULT_TASK_FIELDS.title),
  descriptionColumn: z.string().trim().max(100).default(DEFAULT_TASK_FIELDS.description),
  statusColumn: z.string().trim().max(100).default(DEFAULT_TASK_FIELDS.status),
  priorityColumn: z.string().trim().max(100).default(DEFAULT_TASK_FIELDS.priority),
}

/** 代码仓库工作副本相关问题：驱动据此给出「未选择 / 记录不存在 / 未就绪 / 空仓库 / 同步失败」的不同提示。 */
export class TaskRepoError extends Error {
  constructor(readonly code: 'repoUnset' | 'repoMissing' | 'repoNotReady' | 'repoEmpty' | 'syncFailed', message: string) {
    super(message)
    this.name = 'TaskRepoError'
  }
}

/** 预检依赖：真实读取外部来源所需的能力，由宿主注入；预检本身不写设置、不重启。 */
export interface TaskSourceVerifyDeps {
  /** 按飞书凭据 ID 取得知识库读取能力；凭据不存在或材料不可用时返回 undefined。 */
  feishu?(credential: string): Promise<FeishuWikiApi | undefined>
  /** 按飞书凭据 ID 取得群消息读取能力；飞书消息驱动使用。 */
  feishuIm?(credential: string): Promise<FeishuImApi | undefined>
  /** 同步项目代码仓库并返回本地工作副本目录。 */
  syncRepo(): Promise<string>
  /** 绑定到代码仓库记录的 git 命令入口；Excel 驱动在清单缺失时用它提交初始版本。 */
  git?(args: string[], cwd: string): Promise<string>
}

/** 读取任务时的上下文：`syncRepo` 由项目调度或预检注入，Excel 驱动在读取前调用它。 */
export interface TaskSourceRunContext {
  signal: AbortSignal
  /** 已绑定到任务来源所需记录的宿主命令入口。 */
  commands: Commands
  /** 同步并返回项目代码仓库的本地工作副本；Excel 驱动读取仓库内清单时必须提供。 */
  syncRepo?(): Promise<string>
  /** 按飞书凭据 ID 取得知识库读取能力；飞书知识库驱动使用。 */
  feishu?(credential: string): Promise<FeishuWikiApi | undefined>
  /** 按飞书凭据 ID 取得群消息读取能力；飞书消息驱动使用。 */
  feishuIm?(credential: string): Promise<FeishuImApi | undefined>
}

/** 回写上下文：回写前同样需要代码仓库工作副本，但不需要读取任务。 */
export interface TaskSourceWriteContext {
  signal?: AbortSignal
  syncRepo?(): Promise<string>
  /** 绑定到代码仓库记录的命令入口；用于在回写后把工作副本恢复干净。 */
  commands?: Commands
}

/** 推送上下文：与回写共用工作副本与命令入口。 */
export type TaskSourcePushContext = TaskSourceWriteContext

/** 把异常压成可读文本，用于预检结果的 `output`。 */
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** 把代码仓库异常映射为字段级结果；未知异常按同步失败处理。 */
export function repoCheck(field: string, error: unknown): SourceCheck {
  if (error instanceof TaskRepoError) {
    const code = { repoUnset: 'taskRepoUnset', repoMissing: 'taskRepoMissing', repoNotReady: 'taskRepoNotReady',
      repoEmpty: 'taskRepoEmpty', syncFailed: 'taskRepoSyncFailed' }[error.code]
    return checkFailed(field, code, { output: error.message })
  }
  return checkFailed(field, 'taskRepoSyncFailed', { output: errorText(error) })
}

/**
 * 任务来源驱动：只负责「列出任务」与可选回写，不拆解、不判重、不做业务过滤。
 * 新增来源只需实现本接口并在 `src/task-sources/index.ts` 注册。
 */
export interface TaskSourceDriver<C extends Record<string, unknown> = Record<string, unknown>> {
  /** 注册名；任务来源记录按这个值选择驱动。 */
  kind: string
  title: Localized
  description: Localized
  /** 校验已存储和提交的配置并填充默认值。 */
  schema: z.ZodType<C>
  /** 面板字段；`advanced` 字段不参与「全部验证」，但可以逐字段验证。 */
  fields: FieldSpec[]
  /** 默认字段映射与必须映射的字段；用户可在记录配置里覆盖。 */
  fieldMap: { defaults: TaskFieldMap; required: readonly (keyof TaskFieldMap)[] }
  /** 驱动独占的外部范围（如飞书 `spaceId`）；同一范围只能绑定一个任务来源。 */
  knowledgeBase?(config: C): string
  /** 真实访问来源做字段级预检；`field` 是驱动字段键，不处理 `name` / `id` / `kind`。 */
  verify(config: C, field: string, deps: TaskSourceVerifyDeps): Promise<SourceCheck[]>
  /** 列出任务；只读取与规范化。 */
  list(config: C, ctx: TaskSourceRunContext): Promise<RawTask[]>
  /** 可选能力：把状态写回外部清单；默认只提交本地工作副本，不推送远端。 */
  writeback?(config: C, target: WriteTarget, status: string, ctx: TaskSourceWriteContext): Promise<void>
  /**
   * 后续能力：把回写产生的本地提交推送到远端。
   * 当前没有驱动实现，调度器不会调用；接口与健康度分类先留位，接入时只需在驱动内实现并在副作用中登记。
   */
  push?(config: C, ctx: TaskSourcePushContext): Promise<void>
}
