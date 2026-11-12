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
    await writeTaskStatusAt(file, '', columns, target, 'done')
    const buffer = readFileSync(file)
    expect(buffer[0]).toBe(0xef)
    expect(/\r\n/.test(buffer.toString('utf8'))).toBe(true)
    expect(buffer.toString('utf8')).toContain('T-1,修复登录,done,按验收标准,P1')
    expect(buffer.toString('utf8').endsWith('\r\n')).toBe(true)
  })

  it('writes LF files without a final newline intact', async () => {
    const file = join(directory(), 'backlog.csv')
    writeFileSync(file, 'task_id,title,status\nT-1,修复登录,todo', 'utf8')
    await writeTaskStatusAt(file, '', columns, target, 'done')
    const text = readFileSync(file).toString('utf8')
    expect(text).toBe('task_id,title,status\nT-1,修复登录,done')
  })

  it('updates a TSV by the id column and keeps the delimiter', async () => {
    const file = join(directory(), 'backlog.tsv')
    writeFileSync(file, 'task_id\ttitle\tstatus\nT-1\t修复登录\ttodo\n', 'utf8')
    await writeTaskStatusAt(file, '', columns, target, 'blocked')
    expect(readFileSync(file).toString('utf8')).toContain('T-1\t修复登录\tblocked')
  })

  it('locates the row by title when the id column is empty for that row', async () => {
    const file = join(directory(), 'backlog.csv')
    writeFileSync(file, 'task_id,title,status\n,修复登录,todo\n', 'utf8')
    await writeTaskStatusAt(file, '', columns, target, 'done')
    expect(readFileSync(file).toString('utf8')).toContain(',修复登录,done')
  })

  it('rejects an unknown task, a missing status column and an unsupported extension', async () => {
    const directory_ = directory()
    const csv = join(directory_, 'backlog.csv')
    writeFileSync(csv, 'task_id,title,status\nT-2,别的任务,todo\n', 'utf8')
    await expect(writeTaskStatusAt(csv, '', columns, target, 'done')).rejects.toThrow('找不到任务')
    writeFileSync(csv, 'task_id,title\nT-1,修复登录\n', 'utf8')
    await expect(writeTaskStatusAt(csv, '', columns, target, 'done')).rejects.toThrow('状态列')
    const rst = join(directory_, 'backlog.rst')
    writeFileSync(rst, 'whatever', 'utf8')
    await expect(writeTaskStatusAt(rst, '', columns, target, 'done')).rejects.toThrow('不支持')
    rmSync(directory_, { recursive: true, force: true })
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
    await writeTaskStatusAt(file, 'tasks', columns, target, 'done')
    // 回写后文件仍是合法 xlsx（ZIP 本地文件头），且能按标准表读出更新后的状态。
    const buffer = readFileSync(file)
    expect(buffer.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]))
    const table = await readStandardTable(file, 'tasks')
    expect(table.table.rows.find(item => item.values['task_id'] === 'T-1')?.values['status']).toBe('done')
  })

  it('rejects an unknown task row', async () => {
    const file = join(directory(), 'backlog.xlsx')
    writeFileSync(file, workbook([{ name: 'tasks', rows: [['task_id', 'title', 'status'], ['T-2', '别的任务', 'todo']] }]))
    await expect(writeTaskStatusAt(file, 'tasks', columns, target, 'done')).rejects.toThrow('找不到任务')
  })
})
