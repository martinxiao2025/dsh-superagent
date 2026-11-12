/** 010 标准任务格式：表头与枚举校验、版本门禁、标准状态映射与模板往返读取。 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TASK_TEMPLATE_FILENAME, taskTemplate } from '../src/task-sources/excel-template.ts'
import { TaskFormatError, checkFormatVersion, parseStandardTasks, standardStatus } from '../src/task-sources/excel-format.ts'
import { createZip, readStandardTable } from '../src/task-sources/table.ts'

const directory = (): string => mkdtempSync(join(tmpdir(), 'dsh-task-format-'))
const header = ['task_id', 'title', 'status', 'description', 'priority']
const row = (number: number, values: Record<string, string>) => ({ number, values })

/** 内联字符串工作表 XML，只用于构造测试工作簿。 */
const sheetXml = (rows: readonly (readonly string[])[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((values, index) =>
    `<row r="${index + 1}">${values.map((value, column) =>
      `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`

/** 最小工作簿：按给定顺序写工作表，名称可含 `tasks` / `_meta`。 */
function workbook(sheets: readonly { name: string; rows: readonly (readonly string[])[] }[]): Buffer {
  return createZip([
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
  ])
}

describe('standard task format', () => {
  it('accepts standard rows and normalises status and priority', () => {
    const result = parseStandardTasks({ header: [...header, 'unknown'],
      rows: [row(2, { task_id: '1', title: '登录', status: 'TODO', priority: 'p1', unknown: 'x' })] })
    expect(result.tasks).toEqual([{ id: '1', title: '登录', description: '', status: 'todo', priority: 'P1' }])
    expect(result.unknown).toEqual(['unknown'])
  })

  it('rejects missing and duplicated headers', () => {
    expect(() => parseStandardTasks({ header: ['id', 'title', 'status'], rows: [] }))
      .toThrow(expect.objectContaining({ code: 'taskHeaderMissing' }))
    expect(() => parseStandardTasks({ header: ['task_id', 'title', 'status', 'title'], rows: [] }))
      .toThrow(expect.objectContaining({ code: 'taskHeaderMissing' }))
  })

  it('collects invalid rows and rejects the whole table', () => {
    let failure: TaskFormatError | undefined
    try {
      parseStandardTasks({ header, rows: [
        row(2, { task_id: '1', title: '登录', status: 'todo' }),
        row(3, { task_id: '1', title: '支付', status: 'todo' }),
        row(4, { task_id: '2', title: '导出', status: 'doing' }),
        row(5, { task_id: '3', title: '搜索', status: 'todo', priority: 'P9' }),
        row(6, { task_id: '4', title: '', status: 'todo' }),
      ] })
    } catch (error) { failure = error as TaskFormatError }
    expect(failure?.code).toBe('taskRowInvalid')
    expect(failure?.issues.map(issue => issue.row)).toEqual([3, 4, 5, 6])
  })

  it('treats a header-only sheet as empty rather than invalid', () => {
    expect(parseStandardTasks({ header, rows: [] })).toMatchObject({ tasks: [], empty: true })
  })

  it('rejects a workbook whose schema_version is newer than supported', () => {
    expect(() => checkFormatVersion(2)).toThrow(expect.objectContaining({ code: 'taskSchemaUnsupported' }))
    expect(() => checkFormatVersion(1)).not.toThrow()
  })

  it('maps project done/failed statuses onto the standard enum', () => {
    expect(standardStatus('已完成')).toBe('done')
    expect(standardStatus('DONE')).toBe('done')
    expect(standardStatus('失败')).toBe('cancelled')
    expect(standardStatus('in_progress')).toBe('in_progress')
    expect(() => standardStatus('待处理')).toThrow(/标准格式只接受状态/)
  })

  it('round-trips the generated template as an empty standard workbook', async () => {
    const file = join(directory(), TASK_TEMPLATE_FILENAME)
    writeFileSync(file, taskTemplate())
    const result = await readStandardTable(file)
    expect(result.table.header).toEqual(['task_id', 'title', 'status', 'description', 'priority',
      'owner', 'acceptance', 'depends_on', 'tags', 'updated_at'])
    expect(result.table.rows).toEqual([])
    expect(result.version).toBe(1)
    expect(result.warnings).toEqual([])
    expect(parseStandardTasks(result.table).empty).toBe(true)
  })

  it('falls back to the first sheet with a warning and reads _meta versions', async () => {
    const file = join(directory(), 'legacy.xlsx')
    writeFileSync(file, workbook([
      { name: 'Sheet1', rows: [header, ['1', '登录', 'todo', '', '']] },
      { name: '_meta', rows: [['key', 'value'], ['schema_version', '1']] },
    ]))
    const result = await readStandardTable(file)
    expect(result.table.rows).toHaveLength(1)
    expect(result.warnings).toEqual(['没有找到 tasks 工作表，已回退到“Sheet1”'])
  })

  it('refuses a workbook with an unsupported version before parsing rows', async () => {
    const file = join(directory(), 'future.xlsx')
    writeFileSync(file, workbook([
      { name: 'tasks', rows: [header] },
      { name: '_meta', rows: [['key', 'value'], ['schema_version', '9']] },
    ]))
    await expect(readStandardTable(file)).rejects.toThrow(expect.objectContaining({ code: 'taskSchemaUnsupported' }))
  })

  it('warns when _meta exists without schema_version', async () => {
    const file = join(directory(), 'nometa.xlsx')
    writeFileSync(file, workbook([
      { name: 'tasks', rows: [header, ['1', '登录', 'todo', '', ''], ['2', '支付', 'todo', '', '']] },
      { name: '_meta', rows: [['key', 'value'], ['generator', 'test']] },
    ]))
    const result = await readStandardTable(file)
    expect(result.version).toBe(1)
    expect(result.warnings).toContain('_meta 缺少 schema_version，按版本 1 读取')
    expect(result.table.rows).toHaveLength(2)
  })
})
