/** 本地任务清单读取：`.csv` / `.tsv` 直接解析，`.xlsx` 用 Node 内置 zlib 解包读取，不引入第三方库。 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** 读取一行之后的最小错误类型，调用方据此把记录标为异常而不中断其他来源。 */
export class TaskFileError extends Error {}

/**
 * 读取清单并返回以表头为键的行；第一张表或 `sheet` 指定的表。
 * @throws TaskFileError 当文件不可读、格式不支持或缺少表头时。
 */
export async function readTaskRows(file: string, sheet: string): Promise<Record<string, string>[]> {
  const extension = extname(file).toLowerCase()
  const buffer = await readFile(file).catch(error => { throw new TaskFileError(`无法读取任务清单：${messageOf(error)}`) })
  if (extension === '.xlsx') return rowsOf(sheetRows(buffer, sheet))
  if (extension === '.csv' || extension === '.tsv') {
    const delimiter = extension === '.tsv' ? '\t' : ','
    return rowsOf(parseDelimited(buffer.toString('utf8').replace(/^\uFEFF/, ''), delimiter))
  }
  throw new TaskFileError(`不支持的任务清单格式：${extension || '(无扩展名)'}`)
}

/** 第一行作为表头；缺少表头或只有表头时返回空数组。 */
export function rowsOf(table: readonly (readonly string[])[]): Record<string, string>[] {
  const [header, ...body] = table
  if (!header?.length) return []
  return body.filter(row => row.some(cell => cell.trim())).map(row => {
    const record: Record<string, string> = {}
    header.forEach((name, index) => { if (name.trim()) record[name.trim()] = row[index] ?? '' })
    return record
  })
}

/** 解析带引号的 CSV/TSV；支持双引号转义与字段内换行。 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++ }
      else if (char === '"') quoted = false
      else field += char
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === delimiter) { row.push(field); field = ''; continue }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(field); rows.push(row); row = []; field = ''
      continue
    }
    field += char
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

/** ZIP 中央目录中的一项；只需要读取未加密的 deflate 或 stored 条目。 */
interface ZipEntry { name: string; method: number; compressedSize: number; offset: number }

/** 从 xlsx（ZIP）中取出指定文档的文本；`sheet` 为空时取第一张表。 */
function sheetRows(buffer: Buffer, sheet: string): string[][] {
  const entries = zipEntries(buffer)
  const entry = (name: string): Buffer | undefined => {
    const found = entries.find(item => item.name === name)
    return found ? zipRead(buffer, found) : undefined
  }
  const shared = sharedStrings(entry('xl/sharedStrings.xml')?.toString('utf8') ?? '')
  const workbook = entry('xl/workbook.xml')?.toString('utf8') ?? ''
  const rels = entry('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const target = sheetPath(workbook, rels, sheet)
  const xml = entry(target)?.toString('utf8')
  if (!xml) throw new TaskFileError(`找不到工作表：${sheet || '(第一张表)'}`)
  return xmlRows(xml, shared)
}

/** 读取 ZIP 中央目录；不支持 ZIP64 与加密条目。 */
function zipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = lastIndex(buffer, [0x50, 0x4b, 0x05, 0x06])
  if (eocd < 0) throw new TaskFileError('不是有效的 xlsx 文件：缺少 ZIP 目录')
  const count = buffer.readUInt16LE(eocd + 10)
  let at = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) break
    const method = buffer.readUInt16LE(at + 10)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extra = buffer.readUInt16LE(at + 30)
    const comment = buffer.readUInt16LE(at + 32)
    const offset = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    entries.push({ name, method, compressedSize, offset })
    at += 46 + nameLength + extra + comment
  }
  return entries
}

/** 读取一个 ZIP 条目并解压。 */
function zipRead(buffer: Buffer, entry: ZipEntry): Buffer {
  if (buffer.readUInt32LE(entry.offset) !== 0x04034b50) throw new TaskFileError(`损坏的 xlsx 条目：${entry.name}`)
  const nameLength = buffer.readUInt16LE(entry.offset + 26)
  const extra = buffer.readUInt16LE(entry.offset + 28)
  const start = entry.offset + 30 + nameLength + extra
  const data = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRawSync(data)
  throw new TaskFileError(`不支持的 xlsx 压缩方式：${entry.method}`)
}

/** 解析共享字符串表。 */
function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => textsOf(match[1]!))
}

/** 把一个 XML 片段里的 `<t>` 文本拼接起来并反转义。 */
function textsOf(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1]!)).join('')
}

/** 由工作簿与关系文件得到工作表 XML 的路径。 */
function sheetPath(workbook: string, rels: string, sheet: string): string {
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map(match => attributes(match[1]!))
  const picked = sheet ? sheets.find(item => item.name === sheet) : sheets[0]
  if (!picked) throw new TaskFileError(`找不到工作表：${sheet}`)
  const id = picked['r:id'] ?? ''
  const relation = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(match => attributes(match[1]!))
    .find(item => item.Id === id)?.Target ?? ''
  if (!relation) throw new TaskFileError(`工作表缺少关系：${sheet}`)
  const path = relation.startsWith('/') ? relation.slice(1) : `xl/${relation}`
  return path.replace(/^xl\/xl\//, 'xl/')
}

/** 解析工作表行；单元格按 `r` 属性的列字母定位，空缺列留空。 */
function xmlRows(xml: string, shared: readonly string[]): string[][] {
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(match => {
    const cells: string[] = []
    for (const cell of match[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = attributes(cell[1]!)
      const index = columnIndex(attrs.r ?? '')
      const type = attrs.t
      const body = cell[2]!
      const value = type === 'inlineStr' ? textsOf(body) : type === 's'
        ? shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1)] ?? ''
        : decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
      while (cells.length < index) cells.push('')
      cells[index] = value
    }
    return cells
  })
}

/** 解析 XML 属性为对象。 */
function attributes(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/([\w:]+)="([^"]*)"/g)].map(match => [match[1]!, decodeXml(match[2]!)]))
}

/** 把列字母（A、AA）转换为从 0 开始的列序号。 */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? ''
  let value = 0
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64
  return Math.max(0, value - 1)
}

/** 反转义 xlsx 文本中常见的 XML 实体。 */
function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_match, entity: string) => {
    if (entity === 'amp') return '&'
    if (entity === 'lt') return '<'
    if (entity === 'gt') return '>'
    if (entity === 'quot') return '"'
    if (entity === 'apos') return "'"
    return String.fromCodePoint(entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
  })
}

/** 从缓冲区尾部向前查找字节序列。 */
function lastIndex(buffer: Buffer, bytes: readonly number[]): number {
  for (let index = buffer.length - bytes.length; index >= 0; index--) {
    if (bytes.every((byte, offset) => buffer[index + offset] === byte)) return index
  }
  return -1
}

/** 提取错误消息文本，避免把堆栈或凭据写进健康详情。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
