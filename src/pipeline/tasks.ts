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

/** 工作项在流水线中的状态；工单自身的状态仍由引擎维护。 */
export type ItemState = 'queued' | 'running' | 'succeeded' | 'failed' | 'written-back' | 'writeback-failed' | 'skipped'
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

/** 把一行按列映射规范化；编号缺失时用标题与描述的摘要补齐。 */
function normalizeRow(row: Record<string, string>, columns: TaskColumns): RawTask | undefined {
  const title = (row[columns.title] ?? '').trim()
  if (!title) return undefined
  const description = (row[columns.description] ?? '').trim()
  const id = (row[columns.id] ?? '').trim() || `row-${simpleHash(`${title}\n${description}`)}`
  return { id, title, description, status: (row[columns.status] ?? '').trim(),
    ...(row[columns.priority]?.trim() ? { priority: row[columns.priority]!.trim() } : {}) }
}

/** 规范化全部行，丢弃没有标题的行并保持原顺序。 */
export function normalizeTasks(rows: readonly Record<string, string>[], columns: TaskColumns): RawTask[] {
  return rows.flatMap(row => { const task = normalizeRow(row, columns); return task ? [task] : [] })
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
