/**
 * 飞书知识库任务源：解析节点、读取文档纯文本，再按 Markdown 表格或复选框还原任务项。
 * 该实现未在本机凭据下验证；接口与错误路径与现有飞书来源保持一致，不读取或外传任何 token。
 */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import type { TaskColumns, PipelineConfig } from './config.ts'
import { importTasks, simpleHash, type RawTask } from './tasks.ts'

const nodeSchema = z.object({ node: z.object({ obj_token: z.string(), obj_type: z.string() }) })
const contentSchema = z.object({ content: z.string() })

/** 从知识库 URL、文档 URL 或裸 token 中取出 token。 */
export function feishuToken(url: string): { kind: 'wiki' | 'docx'; token: string } {
  const trimmed = url.trim()
  const wiki = /\/wiki\/([\w-]+)/.exec(trimmed)
  if (wiki) return { kind: 'wiki', token: wiki[1]! }
  const docx = /\/docx\/([\w-]+)/.exec(trimmed)
  if (docx) return { kind: 'docx', token: docx[1]! }
  if (/^[\w-]+$/.test(trimmed)) return { kind: 'docx', token: trimmed }
  throw new Error('无法从地址中解析飞书知识库节点')
}

/**
 * 读取飞书任务清单。
 * @param commands 已切换到 `config.feishuSource` 记录的命令入口。
 */
export async function readFeishuTasks(commands: Commands, config: PipelineConfig, columns: TaskColumns): Promise<RawTask[]> {
  const reference = feishuToken(config.wikiUrl)
  const token = reference.kind === 'wiki' ? await resolveWikiNode(commands, reference.token) : reference.token
  const { content } = contentSchema.parse(await commands.lark(['api', 'GET', `/open-apis/docx/v1/documents/${token}/raw_content`]))
  const table = tableRows(content)
  if (table.length && Object.hasOwn(table[0]!, columns.title)) {
    const header = Object.keys(table[0]!)
    return importTasks({ header, rows: table.map((values, index) => ({ number: index + 2, values })) }, columns)
  }
  return checklistTasks(content)
}

/** 把知识库节点解析为文档 token；非文档节点给出明确错误。 */
async function resolveWikiNode(commands: Commands, token: string): Promise<string> {
  const params = JSON.stringify({ token })
  const { node } = nodeSchema.parse(await commands.lark(['api', 'GET', '/open-apis/wiki/v2/spaces/get_node', '--params', params]))
  if (node.obj_type !== 'docx') throw new Error(`知识库节点不是文档：${node.obj_type}`)
  return node.obj_token
}

/** 解析纯文本中的第一张 Markdown 表格；没有表格时返回空数组。 */
export function tableRows(content: string): Record<string, string>[] {
  const lines = content.split(/\r?\n/).map(line => line.trim())
  const start = lines.findIndex(line => line.startsWith('|') && line.endsWith('|'))
  if (start < 0) return []
  const cells = (line: string): string[] => line.slice(1, -1).split('|').map(cell => cell.trim())
  const header = cells(lines[start]!)
  const separator = lines[start + 1] ?? ''
  if (!/^\|?[\s:|-]+\|?$/.test(separator)) return []
  const rows: string[][] = []
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break
    rows.push(cells(line))
  }
  return rows.map(row => Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])))
}

/** 没有表格时，把 `- [ ]` 复选框行当作任务项。 */
export function checklistTasks(content: string): RawTask[] {
  return content.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+(.+)$/.exec(line)
    if (!match) return []
    const title = match[1]!.trim()
    return [{ id: `line-${simpleHash(title)}`, title, description: '', status: '' }]
  })
}
