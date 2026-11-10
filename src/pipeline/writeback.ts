/**
 * 任务结果回写：只更新任务源中匹配行的状态列。
 * 目前支持 `.csv` / `.tsv`；`.xlsx` 与飞书文档需要保留样式或块结构，明确报为未支持而不是猜测写入。
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseDelimited } from './excel.ts'
import type { PipelineConfig } from './config.ts'

/** 回写目标：任务编号与原始标题，用于在清单中定位唯一一行。 */
export interface WriteTarget { taskId: string; taskTitle: string }

/**
 * 把任务状态写回清单。
 * @throws 当文件格式不支持、找不到对应行或写入失败时。
 */
export async function writeTaskStatus(config: PipelineConfig, target: WriteTarget, status: string): Promise<void> {
  if (config.taskKind === 'feishu') throw new Error('飞书回写需要文档块接口，当前未验证，未写入')
  const extension = extname(config.taskFile).toLowerCase()
  if (extension === '.xlsx') throw new Error('暂不支持回写 .xlsx；请使用 .csv/.tsv 清单或手动回填')
  if (extension !== '.csv' && extension !== '.tsv') throw new Error(`不支持的任务清单格式：${extension || '(无扩展名)'}`)
  const delimiter = extension === '.tsv' ? '\t' : ','
  const table = parseDelimited((await readFile(config.taskFile, 'utf8')).replace(/^\uFEFF/, ''), delimiter)
  const [header, ...body] = table
  if (!header?.length) throw new Error('任务清单缺少表头')
  const idIndex = header.findIndex(name => name.trim() === config.columnId)
  const titleIndex = header.findIndex(name => name.trim() === config.columnTitle)
  const statusIndex = header.findIndex(name => name.trim() === config.columnStatus)
  if (statusIndex < 0) throw new Error(`任务清单缺少状态列：${config.columnStatus}`)
  const row = body.find(cells => (idIndex >= 0 && cells[idIndex] === target.taskId)
    || (titleIndex >= 0 && cells[titleIndex] === target.taskTitle))
  if (!row) throw new Error(`任务清单中找不到任务：${target.taskId}`)
  while (row.length <= statusIndex) row.push('')
  row[statusIndex] = status
  const temporary = `${config.taskFile}.${process.pid}.tmp`
  await writeFile(temporary, serialize([header, ...body], delimiter), 'utf8')
  await rename(temporary, config.taskFile)
}

/** 把表格序列化为 CSV/TSV，按需加引号并转义。 */
export function serialize(table: readonly (readonly string[])[], delimiter: string): string {
  const cell = (value: string): string => {
    const text = value ?? ''
    return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return `${table.map(row => row.map(cell).join(delimiter)).join('\n')}\n`
}
