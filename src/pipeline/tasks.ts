/** 任务项模型、清单规范化、拆解与规划：均为纯函数，便于独立验证。 */
import { key } from '../core/index.ts'
import type { TaskColumns } from './config.ts'

/** 任务源读出的一行，字段已按列映射规范化。 */
export interface RawTask {
  /** 任务源提供的稳定编号；缺省时由标题与描述摘要生成。 */
  id: string
  title: string
  description: string
  status: string
  priority?: string
}

/** 一条任务项拆出的可独立执行工作项。 */
export interface WorkItem {
  /** 由流水线记录、任务编号与子项序号派生的稳定键。 */
  key: string
  taskId: string
  /** 任务项的原始标题，用于回写时定位清单行。 */
  taskTitle: string
  title: string
  text: string
}

/** 清单中的一行：行号用于把导入问题定位回原表，`values` 已按表头映射。 */
export interface TaskRow { number: number; values: Record<string, string> }

/** 一次导入的原始输入：表头与数据行。 */
export interface TaskTableInput { header: readonly string[]; rows: readonly TaskRow[] }

/** 一条导入问题：定位到具体行，便于用户回到表格修正后重新导入。 */
export interface TaskIssue { row: number; reason: string }

/**
 * 清单不满足导入契约时抛出：携带全部问题，整批拒绝。
 * 用显式错误替代“成功导入 0 条”或静默丢行，调用方把 message 直接写进运行状态与健康详情。
 */
export class TaskListError extends Error {
  readonly issues: TaskIssue[]
  constructor(message: string, issues: readonly TaskIssue[] = []) {
    super(message)
    this.name = 'TaskListError'
    this.issues = [...issues]
  }
}

/** 工作项在流水线中的状态；工单自身的状态仍由引擎维护。 */
export type ItemState = 'queued' | 'running' | 'succeeded' | 'failed' | 'written-back' | 'writeback-failed'
/** 持久化到 KV 的单条工作项记录。 */
export interface ItemRecord {
  state: ItemState
  /** 已创建的工单 ID，用于续跑与回写。 */
  ticket?: string
  /** 已尝试次数，达到上限后不再自动准入。 */
  attempts: number
  at: string
  /** 失败或跳过的原因文本。 */
  reason?: string
}
export type ItemRecords = Record<string, ItemRecord>

/** 问题摘要里最多逐条列出的行数。 */
const ISSUE_LIMIT = 5

/** 把多条问题压成一句可直接展示的摘要；超出上限时注明剩余条数，避免日志被长表格淹没。 */
function describe(issues: readonly TaskIssue[]): string {
  const shown = issues.slice(0, ISSUE_LIMIT).map(issue => `第 ${issue.row} 行 ${issue.reason}`)
  const rest = issues.length - shown.length
  return `${issues.length} 处问题：${shown.join('；')}${rest > 0 ? `；另有 ${rest} 处未列出` : ''}`
}

/**
 * 校验并规范化清单：编号与标题列必须存在，每行必须有非空编号与标题，编号在整张表内唯一。
 * 任一条件不满足即整批拒绝，并把问题按行号汇总，避免“成功导入 0 条”或静默丢行。
 * @throws TaskListError 表头缺列、没有数据行或存在行级问题时。
 */
export function importTasks(input: TaskTableInput, columns: TaskColumns): RawTask[] {
  if (!columns.id || !columns.title) throw new TaskListError('任务编号列与标题列不能为空，请先填写列名')
  const missing = [columns.id, columns.title].filter(name => !input.header.some(cell => cell.trim() === name))
  if (missing.length) {
    const header = input.header.filter(Boolean).join('、') || '空'
    throw new TaskListError(`任务清单缺少必填列：${missing.join('、')}（当前表头：${header}）。`
      + '请修正表头拼写，或在流水线记录里把编号列、标题列改成实际表头。')
  }
  if (!input.rows.length) throw new TaskListError('任务清单只有表头、没有数据行，本次未导入任何任务')

  const issues: TaskIssue[] = []
  const seen = new Map<string, number>()
  const tasks: RawTask[] = []
  for (const row of input.rows) {
    const value = (name: string): string => (row.values[name] ?? '').trim()
    const id = value(columns.id)
    const title = value(columns.title)
    if (!id) { issues.push({ row: row.number, reason: `缺少任务编号（列 ${columns.id} 不能为空）` }); continue }
    const first = seen.get(id)
    if (first !== undefined) { issues.push({ row: row.number, reason: `任务编号 ${id} 与第 ${first} 行重复` }); continue }
    if (!title) { issues.push({ row: row.number, reason: `缺少标题（列 ${columns.title} 不能为空）` }); continue }
    seen.set(id, row.number)
    const description = value(columns.description)
    const priority = value(columns.priority)
    tasks.push({ id, title, description, status: value(columns.status), ...(priority ? { priority } : {}) })
  }
  if (issues.length) throw new TaskListError(`任务清单未导入，${describe(issues)}`, issues)
  return tasks
}

const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+(.+)$/
const NUMBERED = /^\s*\d+[.)]\s+(.+)$/

/**
 * 把一条任务拆成工作项：优先取 Markdown 复选框，其次是至少两项的编号列表，否则整条任务即一项。
 * 描述中的空行与标题行不产生工作项。
 */
export function splitTask(task: RawTask): Omit<WorkItem, 'key'>[] {
  const lines = task.description.split(/\r?\n/)
  const boxes = lines.flatMap(line => { const match = CHECKBOX.exec(line); return match ? [match[1]!.trim()] : [] })
  const numbered = lines.flatMap(line => { const match = NUMBERED.exec(line); return match ? [match[1]!.trim()] : [] })
  const parts = boxes.length ? boxes : numbered.length >= 2 ? numbered : []
  if (!parts.length) return [{ taskId: task.id, taskTitle: task.title, title: task.title, text: compose(task) }]
  return parts.map(part => ({ taskId: task.id, taskTitle: task.title, title: `${task.title} / ${part}`, text: compose(task, part) }))
}

/** 组装工作项交给执行器的正文：子项、任务标题与完整描述。 */
function compose(task: RawTask, part?: string): string {
  const head = part ? `${part}\n\n任务：${task.title}` : task.title
  return [head, task.description].filter((text, position) => text && (position === 0 || text !== head)).join('\n\n')
}

/** 由任务项得到工作项，键在同样输入下保持稳定。 */
export function workItems(tasks: readonly RawTask[], pipeline: string): WorkItem[] {
  return tasks.flatMap(task => splitTask(task).map((item, index) => ({ ...item, key: key('pipeline-item', pipeline, task.id, String(index)) })))
}

/**
 * 选出本轮应准入的工作项：从未记录过的工作项、失败但未达重试上限的工作项。
 * 已成功、已回写、已达上限、或仍在排队/运行的工作项不重复准入。
 */
export function plannable(items: readonly WorkItem[], records: ItemRecords, maxRetries: number): WorkItem[] {
  return items.filter(item => {
    const record = records[item.key]
    if (!record) return true
    if (record.state === 'failed') return record.attempts <= maxRetries
    return false
  })
}

/** 连续失败超过上限后进入终态，等待人工处理。 */
export const finalFailure = (record: ItemRecord, maxRetries: number): boolean => record.state === 'failed' && record.attempts > maxRetries

/** 简单的 32 位摘要，仅用于缺少编号时生成稳定键。 */
export function simpleHash(text: string): string {
  let hash = 0
  for (const char of text) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0
  return hash.toString(36)
}
