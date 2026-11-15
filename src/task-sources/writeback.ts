/**
 * 任务结果回写：只更新任务源中匹配行的状态列。
 * 支持 `.csv` / `.tsv` 与 `.xlsx`；`.xlsx` 保留原单元格样式与其他 ZIP 条目，飞书文档明确报为未支持。
 * 文本清单保留原文件的 BOM 与换行风格，避免产生与状态无关的整文件 diff。
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { TASK_SHEET } from './excel-format.ts'
import { locateRow } from './locate.ts'
import { parseDelimited, writeXlsxStatus } from './table.ts'
import type { TaskFieldMap } from './kind.ts'

/** 回写目标：任务编号与原始标题用于定位唯一一行；`expectedStatus` 是写入前的 CAS 期望值（评审 C3）。 */
export interface WriteTarget { taskId: string; taskTitle: string; expectedStatus?: string }

/** 文本清单的字节风格：BOM、换行符与文件末尾是否有换行。 */
export interface TextStyle { bom: boolean; eol: '\n' | '\r\n'; finalNewline: boolean }

/** 探测文本清单的 BOM、主换行风格与末尾换行；混合换行按出现更多的风格统一。 */
export function detectStyle(buffer: Buffer): TextStyle {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return { bom, eol: crlf > lf ? '\r\n' : '\n', finalNewline: /\r?\n$/.test(text) }
}

/**
 * 把任务状态写入指定清单文件；任务来源驱动据此回写工作副本。
 * xlsx 固定写 `tasks` 工作表；文本清单保留原文件字节风格。
 * 提供 `expectedStatus` 时执行 CAS 校验（评审 C3）：目标行当前状态必须与之匹配，
 * 不匹配抛错——人工在结算间隙改过清单时写入被拒绝，由人工仲裁而不是无提示覆盖。
 * @throws 当文件格式不支持、找不到对应行、CAS 不匹配或写入失败时。
 */
export async function writeTaskStatusAt(
  file: string,
  columns: TaskFieldMap,
  target: WriteTarget,
  status: string,
  expectedStatus?: string,
): Promise<void> {
  const extension = extname(file).toLowerCase()
  if (extension === '.xlsx') {
    const updated = writeXlsxStatus(await readFile(file), {
      sheet: TASK_SHEET,
      columns: { id: columns.id, title: columns.title, status: columns.status },
      target,
      status,
      expectedStatus,
    })
    await replaceFile(file, updated)
    return
  }
  if (extension !== '.csv' && extension !== '.tsv') throw new Error(`不支持的任务清单格式：${extension || '(无扩展名)'}`)
  const delimiter = extension === '.tsv' ? '\t' : ','
  const original = await readFile(file)
  const style = detectStyle(original)
  const table = parseDelimited(original.toString('utf8').replace(/^\uFEFF/, ''), delimiter)
  const [header, ...body] = table
  if (!header?.length) throw new Error('任务清单缺少表头')
  const idIndex = header.findIndex(name => name.trim() === columns.id)
  const titleIndex = header.findIndex(name => name.trim() === columns.title)
  const statusIndex = header.findIndex(name => name.trim() === columns.status)
  if (statusIndex < 0) throw new Error(`任务清单缺少状态列：${columns.status}`)
  // 行定位与 CAS（评审 S6/C3）共用 locate.ts 单源：单元格 trim 后比较，ID 优先、标题兜底、多行拒绝。
  const cell = (cells: readonly string[], index: number): string => index >= 0 ? (cells[index] ?? '').trim() : ''
  const row = locateRow(body.map(cells => ({ row: cells, id: cell(cells, idIndex), title: cell(cells, titleIndex), status: cell(cells, statusIndex) })),
    target, expectedStatus, (reason, { count, current }) => reason === 'duplicate'
      ? new Error(`任务清单中「${target.taskId}」匹配到 ${count} 行，回写被拒绝；请修正清单使目标行唯一`)
      : reason === 'missing' ? new Error(`任务清单中找不到任务：${target.taskId}`)
        : new Error(`任务清单的状态已不是「${expectedStatus}」（当前为「${current}」），回写被拒绝；请人工确认该任务的最终状态`))
  while (row.length <= statusIndex) row.push('')
  row[statusIndex] = status
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, serialize([header, ...body], delimiter, style), 'utf8')
  await rename(temporary, file)
}

/** 先写临时文件再原子替换，避免回写中断留下半个文件。 */
async function replaceFile(file: string, content: Buffer): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, file)
}

/** 把表格序列化为 CSV/TSV，按需加引号并转义；BOM 与换行沿用原文件。 */
export function serialize(table: readonly (readonly string[])[], delimiter: string, style: TextStyle = { bom: false, eol: '\n', finalNewline: true }): string {
  const cell = (value: string): string => {
    const text = value ?? ''
    return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  const text = table.map(row => row.map(cell).join(delimiter)).join(style.eol) + (style.finalNewline ? style.eol : '')
  return `${style.bom ? '\uFEFF' : ''}${text}`
}
