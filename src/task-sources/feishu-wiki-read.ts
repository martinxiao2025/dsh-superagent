/**
 * 飞书知识库遍历：根节点顺序 → 目录顺序 → 表出现顺序；文件夹递归、快捷方式解引用、visited 防环。
 * 只有 docx 的任务表与多维表格产生任务；其他节点类型跳过并计数，单份文档失败不影响其他文档。
 */
import type { FeishuWikiApi, WikiNodeRef, WikiRecord } from './feishu-api.ts'
import { importTasks, type RawTask, type TaskRow } from './tasks.ts'
import type { TaskFieldMap } from './kind.ts'

export interface WikiBinding { spaceId: string; roots: readonly string[]; strict: boolean }
export interface WikiDocIssue { nodeToken: string; title: string; reason: string }
export interface WikiReadResult {
  tasks: RawTask[]
  /** 实际读取的任务文档与多维表格数量。 */
  documents: number
  bitables: number
  /** 命中的任务表数量。 */
  tables: number
  /** 按节点类型统计的跳过数量，例如 `sheet`、`docx:no-task-table`。 */
  skipped: Record<string, number>
  /** 单份文档/节点的失败，已隔离，不影响其他文档。 */
  issues: WikiDocIssue[]
}

/** 节点数上限：防止错误配置把整棵巨树拖进一次轮询。 */
const MAX_NODES = 2000

/** 严格模式下同一任务编号跨文档出现：整次同步拒绝。 */
export class WikiStrictConflict extends Error {
  constructor(readonly taskId: string, readonly first: WikiDocIssue, readonly second: WikiDocIssue) {
    super(`严格模式：任务编号 ${taskId} 同时出现在「${first.title || first.nodeToken}」与「${second.title || second.nodeToken}」`)
    this.name = 'WikiStrictConflict'
  }
}

export interface ParsedTable { header: string[]; rows: TaskRow[] }

const splitRow = (line: string): string[] => line.slice(1, -1).split('|').map(cell => cell.trim())

/** 解析文档纯文本中的全部 Markdown 表格，保留出现顺序与行号。 */
export function documentTables(content: string): ParsedTable[] {
  const lines = content.split(/\r?\n/).map(line => line.trim())
  const tables: ParsedTable[] = []
  for (let index = 0; index < lines.length;) {
    if (!lines[index]!.startsWith('|')) { index += 1; continue }
    const separator = lines[index + 1] ?? ''
    if (!/^\|?[\s:|-]+\|?$/.test(separator) || !separator.includes('-')) { index += 1; continue }
    const header = splitRow(lines[index]!)
    const rows: TaskRow[] = []
    let cursor = index + 2
    for (; cursor < lines.length && lines[cursor]!.startsWith('|'); cursor += 1) {
      const cells = splitRow(lines[cursor]!)
      rows.push({ number: cursor + 1, values: Object.fromEntries(header.map((name, position) => [name, cells[position] ?? ''])) })
    }
    tables.push({ header, rows })
    index = cursor
  }
  return tables
}

/** 多维表格单元格转文本：文本片段取 `text`，数组拼接，其余按 JSON 保留。 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(', ')
  if (typeof value === 'object') {
    const text = (value as { text?: unknown }).text
    return typeof text === 'string' ? text : JSON.stringify(value)
  }
  return String(value)
}

/** 用记录字段的并集作为表头，保持首次出现的顺序。 */
function tableOf(records: readonly WikiRecord[]): ParsedTable {
  const header: string[] = []
  for (const record of records) for (const key of Object.keys(record.fields)) if (!header.includes(key)) header.push(key)
  return { header, rows: records.map((record, index) => ({ number: index + 1,
    values: Object.fromEntries(header.map(key => [key, cellText(record.fields[key])])) })) }
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** 读取整棵知识库子树并规范化任务；单份文档的问题进入 `issues`，严格模式的编号冲突直接抛出。 */
export async function readWikiTasks(api: FeishuWikiApi, binding: WikiBinding, columns: TaskFieldMap): Promise<WikiReadResult> {
  const result: WikiReadResult = { tasks: [], documents: 0, bitables: 0, tables: 0, skipped: {}, issues: [] }
  const skip = (key: string): void => { result.skipped[key] = (result.skipped[key] ?? 0) + 1 }
  const origin = new Map<string, WikiDocIssue>()
  const visited = new Set<string>()

  const roots: WikiNodeRef[] = []
  if (binding.roots.length) {
    for (const token of binding.roots) {
      try { roots.push(await api.node(token)) } catch (error) {
        result.issues.push({ nodeToken: token, title: '', reason: reason(error) })
      }
    }
    if (!roots.length) throw new Error('所有根节点都无法读取，请检查知识库 ID 与凭据权限')
  } else {
    roots.push(...await api.children(binding.spaceId, ''))
  }

  /** 严格模式下登记任务编号的来源文档；不同文档出现同一编号即整次同步失败。 */
  const checkStrict = (node: WikiNodeRef, taskId: string): void => {
    if (!binding.strict) return
    const issue = { nodeToken: node.nodeToken, title: node.title, reason: '' }
    const first = origin.get(taskId)
    if (first && first.nodeToken !== node.nodeToken) throw new WikiStrictConflict(taskId, first, issue)
    if (!first) origin.set(taskId, issue)
  }
  /** 逐条登记文档任务：编号带节点前缀。 */
  const commit = (node: WikiNodeRef, tasks: readonly RawTask[]): void => {
    for (const task of tasks) {
      checkStrict(node, task.id)
      result.tasks.push({ ...task, id: `feishu:${node.nodeToken}:${task.id}` })
    }
  }

  const stack = [...roots].reverse()
  while (stack.length) {
    const node = stack.pop()!
    if (visited.has(node.nodeToken)) continue
    visited.add(node.nodeToken)
    if (visited.size > MAX_NODES) throw new Error(`知识库节点超过 ${MAX_NODES} 个，已停止读取`)
    if (node.spaceId && binding.spaceId && node.spaceId !== binding.spaceId) {
      result.issues.push({ nodeToken: node.nodeToken, title: node.title, reason: `节点属于其他知识空间：${node.spaceId}` })
      continue
    }
    try {
      if (node.objType === 'shortcut') {
        stack.push(await api.node(node.objToken))
        continue
      }
      if (node.objType === 'folder') {
        stack.push(...(await api.children(binding.spaceId, node.nodeToken)).reverse())
        continue
      }
      if (node.objType === 'docx') {
        const tables = documentTables(await api.document(node.objToken))
          .filter(table => table.header.includes(columns.id) && table.header.includes(columns.title))
        if (!tables.length) { skip('docx:no-task-table'); continue }
        // 先解析整份文档：任何一张表不合规都整份隔离，不留下半份任务。
        const tasks = tables.flatMap(table => importTasks(table, columns))
        result.documents += 1
        result.tables += tables.length
        commit(node, tasks)
        continue
      }
      if (node.objType === 'bitable') {
        // 整个节点原子提交：任何一张表出错都不登记，避免留下半个多维表格。
        const pairs: { task: RawTask; id: string }[] = []
        let used = 0
        for (const table of await api.tables(node.objToken)) {
          const records = await api.records(node.objToken, table.tableId)
          if (!records.length) { skip('bitable:empty-table'); continue }
          const parsed = tableOf(records)
          if (!parsed.header.includes(columns.id) || !parsed.header.includes(columns.title)) { skip('bitable:non-task-table'); continue }
          const tasks = importTasks(parsed, columns)
          used += 1
          for (const [index, task] of tasks.entries()) {
            pairs.push({ task, id: `feishu-bitable:${node.nodeToken}:${table.tableId}:${records[index]!.recordId}` })
          }
        }
        if (used) {
          for (const pair of pairs) checkStrict(node, pair.task.id)
          result.bitables += 1
          result.tables += used
          result.tasks.push(...pairs.map(pair => ({ ...pair.task, id: pair.id })))
        }
        continue
      }
      skip(node.objType || 'unknown')
    } catch (error) {
      // 严格模式的冲突属于整次同步失败，不能被当作单份文档的问题隔离。
      if (error instanceof WikiStrictConflict) throw error
      // 整份文档未导入：记录问题并继续读取其他文档；表头缺列与行级问题同样走这里。
      result.issues.push({ nodeToken: node.nodeToken, title: node.title, reason: reason(error) })
    }
  }
  return result
}

/** 任务表的问题转成预检可读的摘要。 */
export function issuesText(issues: readonly WikiDocIssue[]): string {
  return issues.slice(0, 3).map(issue => `${issue.title || issue.nodeToken}: ${issue.reason}`).join('；')
    + (issues.length > 3 ? `；另有 ${issues.length - 3} 处未列出` : '')
}
