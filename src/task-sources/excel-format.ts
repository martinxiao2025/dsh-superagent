/**
 * 016 标准任务格式：标准列契约、状态与优先级枚举、行级校验与状态写回映射。
 * Excel / CSV / TSV 与飞书任务表共用同一套列名，界面语言不影响表头。
 */
import type { TaskFieldMap } from './kind.ts'
import { TaskListError, type RawTask, type TaskIssue } from './tasks.ts'

/** 标准任务表的工作表名；CSV / TSV 等价于只有这一张表。 */
export const TASK_SHEET = 'tasks'
/** 元数据工作表名；只读，不参与任务解析。 */
export const META_SHEET = '_meta'
/** 当前支持的标准格式主版本。 */
export const TASK_FORMAT_VERSION = 1
/** 标准列名与任务字段的固定映射。 */
export const STANDARD_TASK_FIELDS: TaskFieldMap = {
  id: 'task_id', title: 'title', status: 'status', description: 'description', priority: 'priority',
}
/** 标准状态枚举（小写）。 */
export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const
/** 标准优先级枚举（大写），P0 最高。 */
export const TASK_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
/** 标准表头：必填列在前，其余为可选列；未列出的列按未知列忽略并警告。 */
export const STANDARD_COLUMNS = ['task_id', 'title', 'status', 'description', 'priority', 'owner', 'acceptance', 'depends_on', 'tags', 'updated_at'] as const
/** 必填列。 */
export const REQUIRED_COLUMNS = ['task_id', 'title', 'status'] as const

/** 标准格式错误码，预检按码给出不同提示。 */
export type TaskFormatCode = 'taskHeaderMissing' | 'taskSchemaUnsupported' | 'taskRowInvalid'

/** 标准格式被拒绝；携带行级问题，便于回到表格修正。 */
export class TaskFormatError extends TaskListError {
  constructor(readonly code: TaskFormatCode, message: string, issues: readonly TaskIssue[] = []) {
    super(message, issues)
    this.name = 'TaskFormatError'
  }
}

/** 一次标准表解析结果。 */
export interface StandardResult {
  tasks: RawTask[]
  /** 只有表头、没有数据行；不是错误。 */
  empty: boolean
  /** 无法映射到标准列的表头，已忽略。 */
  unknown: string[]
}

/** 按 016 §1.2 / §1.3 校验一张标准任务表；问题汇总后整表拒绝。 */
export function parseStandardTasks(input: { header: readonly string[]; rows: readonly { number: number; values: Record<string, string> }[] }): StandardResult {
  const columns = input.header.map(cell => cell.trim())
  const duplicated = columns.filter((name, index) => name && columns.indexOf(name) !== index)
  if (duplicated.length) {
    throw new TaskFormatError('taskHeaderMissing', `任务表存在重复列名：${[...new Set(duplicated)].join('、')}，请先删除重复列`)
  }
  const missing = REQUIRED_COLUMNS.filter(name => !columns.includes(name))
  if (missing.length) {
    const actual = columns.filter(Boolean).join('、') || '空'
    throw new TaskFormatError('taskHeaderMissing', `任务表缺少必填列：${missing.join('、')}（当前表头：${actual}）。标准表头见 docs/016-task-format.md`)
  }
  const unknown = [...new Set(columns.filter(name => name && !(STANDARD_COLUMNS as readonly string[]).includes(name)))]
  if (!input.rows.length) return { tasks: [], empty: true, unknown }
  const issues: TaskIssue[] = []
  const seen = new Map<string, number>()
  const tasks: RawTask[] = []
  for (const row of input.rows) {
    const value = (name: string): string => (row.values[name] ?? '').trim()
    const id = value(STANDARD_TASK_FIELDS.id), title = value(STANDARD_TASK_FIELDS.title)
    const rawStatus = value(STANDARD_TASK_FIELDS.status), rawPriority = value(STANDARD_TASK_FIELDS.priority)
    if (!id) { issues.push({ row: row.number, reason: `缺少任务编号（列 ${STANDARD_TASK_FIELDS.id} 不能为空）` }); continue }
    const first = seen.get(id)
    if (first !== undefined) { issues.push({ row: row.number, reason: `任务编号 ${id} 与第 ${first} 行重复` }); continue }
    if (!title) { issues.push({ row: row.number, reason: `缺少标题（列 ${STANDARD_TASK_FIELDS.title} 不能为空）` }); continue }
    const status = rawStatus.toLowerCase()
    if (!(TASK_STATUSES as readonly string[]).includes(status)) {
      issues.push({ row: row.number, reason: `状态“${rawStatus}”无效（列 ${STANDARD_TASK_FIELDS.status}），只允许 ${TASK_STATUSES.join(' / ')}` })
      continue
    }
    const priority = rawPriority.toUpperCase()
    if (rawPriority && !(TASK_PRIORITIES as readonly string[]).includes(priority)) {
      issues.push({ row: row.number, reason: `优先级“${rawPriority}”无效（列 ${STANDARD_TASK_FIELDS.priority}），只允许 ${TASK_PRIORITIES.join(' / ')}` })
      continue
    }
    seen.set(id, row.number)
    tasks.push({ id, title, description: value(STANDARD_TASK_FIELDS.description), status,
      ...(priority ? { priority } : {}) })
  }
  if (issues.length) {
    const shown = issues.slice(0, 5).map(issue => `第 ${issue.row} 行 ${issue.reason}`)
    const rest = issues.length - shown.length
    throw new TaskFormatError('taskRowInvalid', `任务表未导入，${issues.length} 处问题：${shown.join('；')}${rest > 0 ? `；另有 ${rest} 处未列出` : ''}`, issues)
  }
  return { tasks, empty: false, unknown }
}

/** 检查 `_meta` 中的版本号；高于当前支持的主版本直接拒绝，不做尽力解析。 */
export function checkFormatVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new TaskFormatError('taskSchemaUnsupported', `_meta 的 schema_version 不是正整数：${version}`)
  }
  if (version > TASK_FORMAT_VERSION) {
    throw new TaskFormatError('taskSchemaUnsupported', `任务清单版本 ${version} 高于当前支持的 ${TASK_FORMAT_VERSION}，请升级 dsh-superagent`)
  }
}

/** 标准状态写回候选：项目策略里的完成/失败状态按语义映射到枚举，其他值必须已是枚举。 */
export function standardStatus(status: string): string {
  const text = status.trim()
  const lower = text.toLowerCase()
  if ((TASK_STATUSES as readonly string[]).includes(lower)) return lower
  if (/^(?:done|complete|completed|完成|已完成)$/.test(lower)) return 'done'
  if (/^(?:fail|failed|cancel|cancelled|canceled|失败|取消|已失败)$/.test(lower)) return 'cancelled'
  throw new TaskListError(`标准格式只接受状态 ${TASK_STATUSES.join(' / ')}，无法写回“${status}”；`
    + '请把项目任务策略里的完成/失败状态改为 done / cancelled')
}
