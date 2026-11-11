/**
 * 任务结果回写：只更新任务源中匹配行的状态列。
 * 支持 `.csv` / `.tsv` 与 `.xlsx`；`.xlsx` 保留原单元格样式与其他 ZIP 条目，飞书文档明确报为未支持。
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseDelimited, writeXlsxStatus } from './table.ts'
import type { TaskFieldMap } from './kind.ts'

/** 回写目标：任务编号与原始标题，用于在清单中定位唯一一行。 */
export interface WriteTarget { taskId: string; taskTitle: string }

/**
 * 把任务状态写入指定清单文件；任务来源驱动据此回写工作副本。
 * @throws 当文件格式不支持、找不到对应行或写入失败时。
 */
export async function writeTaskStatusAt(
  file: string,
  sheet: string,
  columns: TaskFieldMap,
  target: WriteTarget,
  status: string,
): Promise<void> {
  const extension = extname(file).toLowerCase()
  if (extension === '.xlsx') {
    const updated = writeXlsxStatus(await readFile(file), {
      sheet,
      columns: { id: columns.id, title: columns.title, status: columns.status },
      target,
      status,
    })
    await replaceFile(file, updated)
    return
  }
  if (extension !== '.csv' && extension !== '.tsv') throw new Error(`不支持的任务清单格式：${extension || '(无扩展名)'}`)
  const delimiter = extension === '.tsv' ? '\t' : ','
  const table = parseDelimited((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''), delimiter)
  const [header, ...body] = table
  if (!header?.length) throw new Error('任务清单缺少表头')
  const idIndex = header.findIndex(name => name.trim() === columns.id)
  const titleIndex = header.findIndex(name => name.trim() === columns.title)
  const statusIndex = header.findIndex(name => name.trim() === columns.status)
  if (statusIndex < 0) throw new Error(`任务清单缺少状态列：${columns.status}`)
  const row = body.find(cells => (idIndex >= 0 && cells[idIndex] === target.taskId)
    || (titleIndex >= 0 && cells[titleIndex] === target.taskTitle))
  if (!row) throw new Error(`任务清单中找不到任务：${target.taskId}`)
  while (row.length <= statusIndex) row.push('')
  row[statusIndex] = status
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, serialize([header, ...body], delimiter), 'utf8')
  await rename(temporary, file)
}

/** 先写临时文件再原子替换，避免回写中断留下半个文件。 */
async function replaceFile(file: string, content: Buffer): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, file)
}

/** 把表格序列化为 CSV/TSV，按需加引号并转义。 */
export function serialize(table: readonly (readonly string[])[], delimiter: string): string {
  const cell = (value: string): string => {
    const text = value ?? ''
    return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return `${table.map(row => row.map(cell).join(delimiter)).join('\n')}\n`
}
