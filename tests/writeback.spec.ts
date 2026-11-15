/** 任务回写：文本清单的字节风格保留与状态落列；xlsx 走自研读写器。 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeTaskStatusAt } from '../src/task-sources/writeback.ts'
import { createZip, parseDelimited, readStandardTable } from '../src/task-sources/table.ts'

const directory = (): string => mkdtempSync(join(tmpdir(), 'dsh-writeback-'))
const columns = { id: 'task_id', title: 'title', description: 'description', status: 'status', priority: 'priority' }
const target = { taskId: 'T-1', taskTitle: '修复登录' }

describe('text writeback', () => {
  it('updates the status column and preserves BOM, CRLF and the final newline', async () => {
    const file = join(directory(), 'backlog.csv')
    writeFileSync(file, '\uFEFFtask_id,title,status,description,priority\r\nT-1,修复登录,todo,按验收标准,P1\r\n', 'utf8')
    await writeTaskStatusAt(file, columns, target, 'done')
    const buffer = readFileSync(file)
    expect(buffer[0]).toBe(0xef)
    expect(/\r\n/.test(buffer.toString('utf8'))).toBe(true)
    expect(buffer.toString('utf8')).toContain('T-1,修复登录,done,按验收标准,P1')
    expect(buffer.toString('utf8').endsWith('\r\n')).toBe(true)
  })

  it('writes LF files without a final newline intact', async () => {
    const file = join(directory(), 'backlog.csv')
    writeFileSync(file, 'task_id,title,status\nT-1,修复登录,todo', 'utf8')
    await writeTaskStatusAt(file, columns, target, 'done')
    const text = readFileSync(file).toString('utf8')
    expect(text).toBe('task_id,title,status\nT-1,修复登录,done')
  })

  it('updates a TSV by the id column and keeps the delimiter', async () => {
    const file = join(directory(), 'backlog.tsv')
    writeFileSync(file, 'task_id\ttitle\tstatus\nT-1\t修复登录\ttodo\n', 'utf8')
    await writeTaskStatusAt(file, columns, target, 'blocked')
    expect(readFileSync(file).toString('utf8')).toContain('T-1\t修复登录\tblocked')
  })

  it('locates the row by title when the id column is empty for that row', async () => {
    const file = join(directory(), 'backlog.csv')
    writeFileSync(file, 'task_id,title,status\n,修复登录,todo\n', 'utf8')
    await writeTaskStatusAt(file, columns, target, 'done')
    expect(readFileSync(file).toString('utf8')).toContain(',修复登录,done')
  })

  it('rejects an unknown task, a missing status column and an unsupported extension', async () => {
    const directory_ = directory()
    const csv = join(directory_, 'backlog.csv')
    writeFileSync(csv, 'task_id,title,status\nT-2,别的任务,todo\n', 'utf8')
    await expect(writeTaskStatusAt(csv, columns, target, 'done')).rejects.toThrow('找不到任务')
    writeFileSync(csv, 'task_id,title\nT-1,修复登录\n', 'utf8')
    await expect(writeTaskStatusAt(csv, columns, target, 'done')).rejects.toThrow('状态列')
    const rst = join(directory_, 'backlog.rst')
    writeFileSync(rst, 'whatever', 'utf8')
    await expect(writeTaskStatusAt(rst, columns, target, 'done')).rejects.toThrow('不支持')
    rmSync(directory_, { recursive: true, force: true })
  })

  it('trims cell padding when locating the row and prefers the id over duplicate titles（评审 S6）', async () => {
    const file = join(directory(), 'backlog.csv')
    // 单元格带前后空格（表格软件常见）：不 trim 会永久找不到任务，回写无限退避。
    writeFileSync(file, 'task_id,title,status\n T-1 , 修复登录 , todo\n', 'utf8')
    await writeTaskStatusAt(file, columns, target, 'done')
    expect(readFileSync(file).toString('utf8')).toContain(' T-1 , 修复登录 ,done')
    // ID 优先：目标 ID 命中一行，另一行标题同名但 ID 不同——不应让定位产生歧义。
    writeFileSync(file, 'task_id,title,status\nT-1,修复登录,todo\nT-9,修复登录,todo\n', 'utf8')
    await writeTaskStatusAt(file, columns, target, 'done')
    expect(readFileSync(file).toString('utf8')).toContain('T-1,修复登录,done')
    expect(readFileSync(file).toString('utf8')).toContain('T-9,修复登录,todo')
  })

  it('rejects the write when the chosen key matches more than one row（评审 S6）', async () => {
    const file = join(directory(), 'backlog.csv')
    // 无 ID 列且标题重名：写第一行等于写错行，显式拒绝交给人工。
    writeFileSync(file, 'title,status\n修复登录,todo\n修复登录,todo\n', 'utf8')
    await expect(writeTaskStatusAt(file, columns, target, 'done')).rejects.toThrow('匹配到 2 行')
    // ID 列存在但 ID 本身重复（脏数据）：同样拒绝。
    writeFileSync(file, 'task_id,title,status\nT-1,甲,todo\nT-1,乙,todo\n', 'utf8')
    await expect(writeTaskStatusAt(file, columns, target, 'done')).rejects.toThrow('匹配到 2 行')
    expect(readFileSync(file).toString('utf8')).not.toContain('done')
  })

  it('rejects the write when the current status no longer matches the expected one (CAS)', async () => {
    // 回归（评审 C3）：人工在结算间隙把状态改成别的值时，回写被拒绝而不是无提示覆盖。
    const file = join(directory(), 'backlog.csv')
    writeFileSync(file, 'task_id,title,status\nT-1,修复登录,进行中\n', 'utf8')
    await expect(writeTaskStatusAt(file, columns, target, 'done', 'todo')).rejects.toThrow('请人工确认')
    // 清单仍是人工改后的值，未被覆盖。
    expect(readFileSync(file).toString('utf8')).toContain('T-1,修复登录,进行中')
    // 期望值匹配（含前后空白）时正常写入。
    writeFileSync(file, 'task_id,title,status\nT-1,修复登录, todo \n', 'utf8')
    await writeTaskStatusAt(file, columns, target, 'done', 'todo')
    expect(readFileSync(file).toString('utf8')).toContain('T-1,修复登录,done')
    rmSync(directory(), { recursive: true, force: true })
  })
})

describe('xlsx writeback', () => {
  /** 内联字符串工作表 XML，与 excel-format.spec 的最小工作簿构造一致。 */
  const sheetXml = (rows: readonly (readonly string[])[]): string =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((values, index) =>
      `<row r="${index + 1}">${values.map((value, column) =>
        `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`
  const workbook = (sheets: readonly { name: string; rows: readonly (readonly string[])[] }[]): Buffer => {
    const files: { name: string; data: Buffer }[] = [
      { name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`) },
      { name: '_rels/.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
      { name: 'xl/workbook.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
</workbook>`) },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}
</Relationships>`) },
      ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: Buffer.from(sheetXml(sheet.rows)) })),
    ]
    return createZip(files)
  }

  it('writes the status and keeps the workbook readable', async () => {
    const file = join(directory(), 'backlog.xlsx')
    writeFileSync(file, workbook([{ name: 'tasks', rows: [['task_id', 'title', 'status'], ['T-1', '修复登录', 'todo']] }]))
    await writeTaskStatusAt(file, columns, target, 'done')
    // 回写后文件仍是合法 xlsx（ZIP 本地文件头），且能按标准表读出更新后的状态。
    const buffer = readFileSync(file)
    expect(buffer.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]))
    const table = await readStandardTable(file)
    expect(table.table.rows.find(item => item.values['task_id'] === 'T-1')?.values['status']).toBe('done')
  })

  it('rejects an unknown task row', async () => {
    const file = join(directory(), 'backlog.xlsx')
    writeFileSync(file, workbook([{ name: 'tasks', rows: [['task_id', 'title', 'status'], ['T-2', '别的任务', 'todo']] }]))
    await expect(writeTaskStatusAt(file, columns, target, 'done')).rejects.toThrow('找不到任务')
  })

  it('trims padded cells and rejects ambiguous rows the same way as text lists（评审 S6）', async () => {
    const file = join(directory(), 'backlog.xlsx')
    writeFileSync(file, workbook([{ name: 'tasks', rows: [['task_id', 'title', 'status'], [' T-1 ', ' 修复登录 ', 'todo']] }]))
    await writeTaskStatusAt(file, columns, target, 'done')
    const table = await readStandardTable(file)
    expect(table.table.rows[0]?.values['status']).toBe('done')
    const ambiguous = join(directory(), 'backlog.xlsx')
    writeFileSync(ambiguous, workbook([{ name: 'tasks', rows: [['task_id', 'title', 'status'], ['T-1', '甲', 'todo'], ['T-1', '乙', 'todo']] }]))
    await expect(writeTaskStatusAt(ambiguous, columns, target, 'done')).rejects.toThrow('匹配到 2 行')
  })
})
