/** 本地任务清单读取：`.csv` / `.tsv` 直接解析，`.xlsx` 用 Node 内置 zlib 解包读取，不引入第三方库。 */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { inflateRawSync, deflateRawSync } from 'node:zlib'
import { META_SHEET, TASK_SHEET, checkFormatVersion } from './excel-format.ts'

/** 读取一行之后的最小错误类型，调用方据此把记录标为异常而不中断其他来源。 */
export class TaskFileError extends Error {}

/** 回写目标：任务编号与原始标题，用于定位唯一一行。 */
export interface XlsxTarget { taskId: string; taskTitle: string }

/** 回写所需的列映射；只用到定位行与状态列。 */
export interface XlsxColumns { id: string; title: string; status: string }

/** 清单中的一行：`number` 是表内物理行号（表头为第 1 行），用于把导入问题定位回原表。 */
export interface TaskTableRow { number: number; values: Record<string, string> }
/** 清单的首行表头与其余非空数据行。 */
export interface TaskTable { header: string[]; rows: TaskTableRow[] }

/** 表格的原始形态：保留行号与未映射的单元格，供表头校验与行号定位共用。 */
interface NumberedCells { number: number; cells: string[] }

/**
 * 读取清单为带行号的表格；第一张表或 `sheet` 指定的表。
 * @throws TaskFileError 当文件不可读、格式不支持或缺少表头时。
 */
export async function readTaskTable(file: string, sheet: string): Promise<TaskTable> {
  const extension = extname(file).toLowerCase()
  const buffer = await readFile(file).catch(error => { throw new TaskFileError(`无法读取任务清单：${messageOf(error)}`) })
  if (extension === '.xlsx') return tableOf(sheetRows(buffer, sheet))
  if (extension === '.csv' || extension === '.tsv') {
    const delimiter = extension === '.tsv' ? '\t' : ','
    return tableOf(numbered(parseDelimited(buffer.toString('utf8').replace(/^\uFEFF/, ''), delimiter)))
  }
  throw new TaskFileError(`不支持的任务清单格式：${extension || '(无扩展名)'}`)
}

/** 读取清单并返回以表头为键的行；需要行号的调用方应使用 `readTaskTable`。 */
export async function readTaskRows(file: string, sheet: string): Promise<Record<string, string>[]> {
  const table = await readTaskTable(file, sheet)
  return table.rows.map(row => row.values)
}

/** 标准工作簿读取结果：任务表、`_meta` 中的版本与读取警告。 */
export interface StandardTable {
  table: TaskTable
  version: number
  /** 回退工作表、忽略其他表、缺少 `schema_version` 等提示。 */
  warnings: string[]
}

/**
 * 按 016 读取标准工作簿：优先 `tasks` 工作表，`_meta` 只读版本，其他表忽略并记录警告。
 * CSV / TSV 等价于只有 `tasks` 一张表，同样要求 UTF-8。
 * @throws TaskFileError 文件不可读、非 UTF-8、找不到工作表或版本高于当前支持。
 */
export async function readStandardTable(file: string, sheet: string): Promise<StandardTable> {
  const extension = extname(file).toLowerCase()
  const buffer = await readFile(file).catch(error => { throw new TaskFileError(`无法读取任务清单：${messageOf(error)}`) })
  if (extension === '.csv' || extension === '.tsv') {
    const delimiter = extension === '.tsv' ? '\t' : ','
    return { table: tableOf(numbered(parseDelimited(decodeUtf8(buffer), delimiter))), version: 1, warnings: [] }
  }
  if (extension !== '.xlsx') throw new TaskFileError(`不支持的任务清单格式：${extension || '(无扩展名)'}`)
  const entries = zipEntries(buffer)
  const sharedEntry = entries.find(item => item.name === 'xl/sharedStrings.xml')
  const shared = sharedStrings(sharedEntry ? zipRead(buffer, sharedEntry).toString('utf8') : '')
  const sheets = workbookSheets(buffer, entries)
  const chosen = pickSheet(sheets, sheet)
  const warnings: string[] = []
  if (!sheet && chosen.name.toLowerCase() !== TASK_SHEET) {
    warnings.push(`没有找到 ${TASK_SHEET} 工作表，已回退到“${chosen.name}”`)
  }
  const ignored = sheets.filter(item => item !== chosen && item.name !== META_SHEET)
  if (ignored.length) warnings.push(`已忽略 ${ignored.length} 张表：${ignored.map(item => item.name).join('、')}`)
  let version = 1
  const meta = sheets.find(item => item.name === META_SHEET)
  if (meta) {
    const values = Object.fromEntries(tableOf(xmlRows(meta.xml, shared)).rows
      .map(row => [row.values.key?.trim() ?? '', row.values.value?.trim() ?? '']))
    const raw = values.schema_version ?? ''
    if (!raw) warnings.push(`${META_SHEET} 缺少 schema_version，按版本 1 读取`)
    else if (!/^\d+$/.test(raw)) throw new TaskFileError(`${META_SHEET} 的 schema_version 不是整数：${raw}`)
    else version = Number(raw)
  }
  checkFormatVersion(version)
  return { table: tableOf(xmlRows(chosen.xml, shared)), version, warnings }
}

/** 标准工作簿按名称取表：显式指定时精确匹配，否则优先 `tasks`，再回退到第一张表。 */
function pickSheet(sheets: readonly { name: string; path: string; xml: string }[], sheet: string):
{ name: string; path: string; xml: string } {
  if (sheet) {
    const found = sheets.find(item => item.name === sheet)
    if (!found) throw new TaskFileError(`找不到工作表：${sheet}`)
    return found
  }
  const found = sheets.find(item => item.name.toLowerCase() === TASK_SHEET) ?? sheets[0]
  if (!found) throw new TaskFileError('工作簿没有工作表')
  return found
}

/** 解析工作簿中的工作表名称、路径与 XML。 */
function workbookSheets(buffer: Buffer, entries: readonly ZipEntry[]): { name: string; path: string; xml: string }[] {
  const text = (name: string): string => {
    const found = entries.find(item => item.name === name)
    return found ? zipRead(buffer, found).toString('utf8') : ''
  }
  const relations = new Map([...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map(match => { const attrs = attributes(match[1]!); return [attrs.Id ?? '', attrs.Target ?? ''] }))
  return [...text('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)]
    .map(match => attributes(match[1]!))
    .flatMap(sheet => {
      const target = relations.get(sheet['r:id'] ?? '') ?? ''
      if (!target) return []
      const path = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).replace(/^xl\/xl\//, 'xl/')
      return [{ name: sheet.name ?? '', path, xml: text(path) }]
    })
}

/** CSV / TSV 必须是 UTF-8（含 BOM），否则给出转码提示。 */
function decodeUtf8(buffer: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '') }
  catch { throw new TaskFileError('任务清单不是有效的 UTF-8，请另存为 UTF-8 后重试') }
}

/** 给 CSV/TSV 的记录补上物理行号；序号包含表头，与表格软件的行号一致。 */
function numbered(table: readonly (readonly string[])[]): NumberedCells[] {
  return table.map((cells, index) => ({ number: index + 1, cells: [...cells] }))
}

/**
 * 第一行作为表头，其余行按表头映射为键值；整行空白的行被忽略。
 * @throws TaskFileError 当第一行没有可用的列名时。
 */
export function tableOf(table: readonly NumberedCells[]): TaskTable {
  const header = (table[0]?.cells ?? []).map(cell => cell.trim())
  if (!header.some(Boolean)) throw new TaskFileError('任务清单缺少表头：第一行必须是列名')
  const rows = table.slice(1).filter(row => row.cells.some(cell => cell.trim())).map(row => {
    const values: Record<string, string> = {}
    header.forEach((name, index) => { if (name) values[name] = row.cells[index] ?? '' })
    return { number: row.number, values }
  })
  return { header, rows }
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
interface ZipEntry {
  name: string
  method: number
  flags: number
  time: number
  date: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  offset: number
  nameBytes: Buffer
  extra: Buffer
  comment: Buffer
  internal: number
  external: number
}

/** 从 xlsx（ZIP）中取出指定文档的文本；`sheet` 为空时取第一张表。 */
function sheetRows(buffer: Buffer, sheet: string): NumberedCells[] {
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
    const flags = buffer.readUInt16LE(at + 8)
    if (flags & 0x0001) throw new TaskFileError('不支持加密的 xlsx 条目')
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    entries.push({
      name,
      method: buffer.readUInt16LE(at + 10),
      flags,
      time: buffer.readUInt16LE(at + 12),
      date: buffer.readUInt16LE(at + 14),
      crc: buffer.readUInt32LE(at + 16),
      compressedSize: buffer.readUInt32LE(at + 20),
      uncompressedSize: buffer.readUInt32LE(at + 24),
      offset: buffer.readUInt32LE(at + 42),
      nameBytes: buffer.subarray(at + 46, at + 46 + nameLength),
      extra: buffer.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength),
      comment: buffer.subarray(at + 46 + nameLength + extraLength, at + 46 + nameLength + extraLength + commentLength),
      internal: buffer.readUInt16LE(at + 36),
      external: buffer.readUInt32LE(at + 38),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 一个条目在原始文件中的压缩数据。 */
function zipPayload(buffer: Buffer, entry: ZipEntry): Buffer {
  const start = zipDataStart(buffer, entry)
  return buffer.subarray(start, start + entry.compressedSize)
}

/** 条目压缩数据在原始文件中的起始位置。 */
function zipDataStart(buffer: Buffer, entry: ZipEntry): number {
  if (buffer.readUInt32LE(entry.offset) !== 0x04034b50) throw new TaskFileError(`损坏的 xlsx 条目：${entry.name}`)
  const nameLength = buffer.readUInt16LE(entry.offset + 26)
  const extra = buffer.readUInt16LE(entry.offset + 28)
  return entry.offset + 30 + nameLength + extra
}

/** 读取一个 ZIP 条目并解压。 */
function zipRead(buffer: Buffer, entry: ZipEntry): Buffer {
  const data = zipPayload(buffer, entry)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRawSync(data)
  throw new TaskFileError(`不支持的 xlsx 压缩方式：${entry.method}`)
}

/**
 * 重写 ZIP：只重新压缩 `replacements` 中的条目，其余条目直接复制原始压缩数据，保证样式表等字节不变。
 * 所有条目都写入真实大小并清除数据描述符标志，中央目录与文件尾部重新生成。
 */
function zipWrite(buffer: Buffer, entries: readonly ZipEntry[], replacements: ReadonlyMap<string, Buffer>): Buffer {
  if (entries.length > 0xffff) throw new TaskFileError('xlsx 条目过多，当前不支持 ZIP64')
  const prepared = entries.map(entry => {
    const replaced = replacements.get(entry.name)
    return replaced === undefined
      ? { entry, payload: zipPayload(buffer, entry), crc: entry.crc, size: entry.uncompressedSize }
      : { entry, payload: compress(replaced, entry.method), crc: crc32(replaced), size: replaced.length }
  })
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  const offsets: number[] = []
  let offset = 0
  for (const { entry, payload, crc, size } of prepared) {
    if (offset > 0xffffffff || payload.length > 0xffffffff || size > 0xffffffff) {
      throw new TaskFileError('xlsx 文件过大，当前不支持 ZIP64')
    }
    offsets.push(offset)
    // 清除 bit 3（数据描述符）：重建后的本地头直接带真实大小，不再跟随描述符。
    const flags = entry.flags & ~0x0008
    const local = Buffer.alloc(30 + entry.nameBytes.length + entry.extra.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt16LE(entry.time, 10)
    local.writeUInt16LE(entry.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(entry.nameBytes.length, 26)
    local.writeUInt16LE(entry.extra.length, 28)
    entry.nameBytes.copy(local, 30)
    entry.extra.copy(local, 30 + entry.nameBytes.length)
    locals.push(local, payload)
    offset += local.length + payload.length
  }
  let directorySize = 0
  for (const [index, { entry, payload, crc, size }] of prepared.entries()) {
    const central = Buffer.alloc(46 + entry.nameBytes.length + entry.extra.length + entry.comment.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags & ~0x0008, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt16LE(entry.time, 12)
    central.writeUInt16LE(entry.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(entry.nameBytes.length, 28)
    central.writeUInt16LE(entry.extra.length, 30)
    central.writeUInt16LE(entry.comment.length, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(entry.internal, 36)
    central.writeUInt32LE(entry.external, 38)
    central.writeUInt32LE(offsets[index]!, 42)
    entry.nameBytes.copy(central, 46)
    entry.extra.copy(central, 46 + entry.nameBytes.length)
    entry.comment.copy(central, 46 + entry.nameBytes.length + entry.extra.length)
    centrals.push(central)
    directorySize += central.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** 按原条目方式压缩：stored 原样返回，deflate 用 Node 内置 zlib。 */
function compress(content: Buffer, method: number): Buffer {
  if (method === 0) return content
  if (method === 8) return deflateRawSync(content)
  throw new TaskFileError(`不支持的 xlsx 压缩方式：${method}`)
}

/** ZIP 使用的 CRC32。 */
function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

/** 解析共享字符串表。 */
function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => textsOf(match[1]!))
}

/** 把一个 XML 片段里的 `<t>` 文本拼接起来并反转义。 */
function textsOf(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1]!)).join('')
}

/** 由若干文件组装一个最小 xlsx（ZIP）：全部用 deflate 条目，不写数据描述符。 */
export function createZip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  const offsets: number[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const payload = deflateRawSync(file.data)
    const crc = crc32(file.data)
    offsets.push(offset)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, payload)
    offset += local.length + payload.length
  }
  let size = 0
  for (const [index, file] of files.entries()) {
    const name = Buffer.from(file.name, 'utf8')
    const payload = deflateRawSync(file.data)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc32(file.data), 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offsets[index]!, 42)
    name.copy(central, 46)
    centrals.push(central)
    size += central.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** 由工作簿与关系文件得到工作表 XML 的路径。 */
function sheetPath(workbook: string, rels: string, sheet: string): string {
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map(match => attributes(match[1]!))
  const picked = sheet ? sheets.find(item => item.name === sheet)
    : sheets.find(item => (item.name ?? '').toLowerCase() === TASK_SHEET) ?? sheets[0]
  if (!picked) throw new TaskFileError(`找不到工作表：${sheet}`)
  const id = picked['r:id'] ?? ''
  const relation = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(match => attributes(match[1]!))
    .find(item => item.Id === id)?.Target ?? ''
  if (!relation) throw new TaskFileError(`工作表缺少关系：${sheet}`)
  const path = relation.startsWith('/') ? relation.slice(1) : `xl/${relation}`
  return path.replace(/^xl\/xl\//, 'xl/')
}

/** 解析工作表行；单元格按 `r` 属性的列字母定位，空缺列留空，行号取 `r` 属性。 */
function xmlRows(xml: string, shared: readonly string[]): NumberedCells[] {
  return [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)].map((match, position) => {
    const cells: string[] = []
    for (const cell of match[2]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = attributes(cell[1]!)
      const index = columnIndex(attrs.r ?? '')
      while (cells.length < index) cells.push('')
      cells[index] = cellValue(attrs, cell[2]!, shared)
    }
    const declared = Number(attributes(match[1]!).r ?? '')
    return { number: Number.isFinite(declared) && declared > 0 ? declared : position + 1, cells }
  })
}

/** 读取一个单元格的文本；共享字符串、内联文本与普通值分别处理。 */
function cellValue(attrs: Record<string, string>, body: string, shared: readonly string[]): string {
  if (attrs.t === 'inlineStr') return textsOf(body)
  if (attrs.t === 's') return shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1)] ?? ''
  return decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
}

/** 工作表中的原始单元格：列序号、属性文本与原始 XML，便于只重建被修改的单元格。 */
interface RawCell { index: number; attrs: string; body: string; raw: string }

/** 扫描一行中的原始单元格，保序保留原始 XML。 */
function rawCells(row: string): RawCell[] {
  return [...row.matchAll(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)].map(match => ({
    index: columnIndex(attributes(match[1]!).r ?? ''),
    attrs: match[1]!,
    body: match[3] ?? '',
    raw: match[0],
  }))
}

/**
 * 把状态写入 xlsx 中匹配行的状态单元格，保留该单元格的样式属性与其他 ZIP 条目。
 * 状态写成内联字符串；目标单元格不存在时按列序插入新单元格。
 * @throws TaskFileError 当缺少工作表、状态列或找不到任务行时。
 */
export function writeXlsxStatus(buffer: Buffer, options: { sheet: string; columns: XlsxColumns; target: XlsxTarget; status: string }): Buffer {
  const entries = zipEntries(buffer)
  const text = (name: string): string => {
    const found = entries.find(item => item.name === name)
    return found ? zipRead(buffer, found).toString('utf8') : ''
  }
  const shared = sharedStrings(text('xl/sharedStrings.xml'))
  const path = sheetPath(text('xl/workbook.xml'), text('xl/_rels/workbook.xml.rels'), options.sheet)
  const sheet = entries.find(item => item.name === path)
  if (!sheet) throw new TaskFileError(`找不到工作表：${options.sheet || '(第一张表)'}`)
  const xml = zipRead(buffer, sheet).toString('utf8')
  const updated = updateSheet(xml, shared, options)
  if (updated === xml) return buffer
  return zipWrite(buffer, entries, new Map([[path, Buffer.from(updated, 'utf8')]]))
}

/** 在工作表 XML 中定位任务行并替换状态单元格，返回新的工作表 XML。 */
function updateSheet(xml: string, shared: readonly string[], options: { columns: XlsxColumns; target: XlsxTarget; status: string }): string {
  const rows = [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)]
  if (!rows.length) throw new TaskFileError('工作表没有表头')
  const header = rawCells(rows[0]![2]!).map(cell => ({ index: cell.index, value: cellValue(attributes(cell.attrs), cell.body, shared) }))
  const { id, title, status } = options.columns
  const column = (name: string): number => header.find(cell => cell.value.trim() === name)?.index ?? -1
  const idIndex = column(id)
  const titleIndex = column(title)
  const statusIndex = column(status)
  if (statusIndex < 0) throw new TaskFileError(`任务清单缺少状态列：${status}`)
  const match = rows.slice(1).find(row => {
    const values = new Map(rawCells(row[2]!).map(cell => [cell.index, cellValue(attributes(cell.attrs), cell.body, shared)]))
    const value = (column: number): string => column < 0 ? '' : values.get(column) ?? ''
    return (idIndex >= 0 && value(idIndex) === options.target.taskId) || (titleIndex >= 0 && value(titleIndex) === options.target.taskTitle)
  })
  if (!match) throw new TaskFileError(`任务清单中找不到任务：${options.target.taskId}`)
  const rowNumber = Number(match[1]!.match(/\br="(\d+)"/)?.[1] ?? rows.indexOf(match) + 1)
  const cells = rawCells(match[2]!)
  const existing = cells.find(cell => cell.index === statusIndex)
  const content = `<is><t${/^\s|\s$/.test(options.status) ? ' xml:space="preserve"' : ''}>${encodeXml(options.status)}</t></is>`
  const attrs = (existing?.attrs ?? ` r="${columnName(statusIndex)}${rowNumber}"`).replace(/\s+t="[^"]*"/g, '')
  const replacement = { index: statusIndex, raw: `<c${attrs} t="inlineStr">${content}</c>` }
  const merged = existing ? cells.map(cell => cell.index === statusIndex ? replacement : cell) : [...cells, replacement]
  merged.sort((left, right) => left.index - right.index)
  return `${xml.slice(0, match.index)}<row${match[1]}>${merged.map(cell => cell.raw).join('')}</row>${xml.slice(match.index! + match[0].length)}`
}

/** 列序号转换为列字母（0 对应 A）。 */
function columnName(index: number): string {
  let value = index + 1
  let name = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

/** 转义写回 xlsx 文本中的 XML 特殊字符。 */
function encodeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
