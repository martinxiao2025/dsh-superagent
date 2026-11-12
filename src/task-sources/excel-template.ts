/** 010 标准工作簿模板：tasks 表只放表头，_meta 表记录版本与示例，生成的 xlsx 可直接提交到仓库。 */
import { createZip } from './table.ts'
import { META_SHEET, STANDARD_COLUMNS, TASK_FORMAT_VERSION, TASK_SHEET } from './excel-format.ts'

/** 面板下载与命令生成使用的文件名。 */
export const TASK_TEMPLATE_FILENAME = 'tasks-template.xlsx'

/** 转义 XML 文本与属性值。 */
const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 列序号转列字母。 */
function columnName(index: number): string {
  let value = index + 1, name = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

/** 一行内联字符串；模板不依赖 sharedStrings，任何表格软件都能直接打开。 */
function row(number: number, values: readonly string[]): string {
  const cells = values.map((value, index) => `<c r="${columnName(index)}${number}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`)
  return `<row r="${number}">${cells.join('')}</row>`
}

/** 生成 010 §4.2 的标准工作簿：`tasks` 表头 + `_meta` 版本与示例。 */
export function taskTemplate(now: () => string = () => new Date().toISOString()): Buffer {
  const meta = [
    ['key', 'value'],
    ['schema_version', String(TASK_FORMAT_VERSION)],
    ['generator', `dsh-superagent/task-format-${TASK_FORMAT_VERSION}`],
    ['updated_at', now()],
    ['example', 'task_id=1;title=登录;status=todo;description=修复登录;priority=P1'],
  ]
  const tasks = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${row(1, STANDARD_COLUMNS)}</sheetData></worksheet>`
  const metadata = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${meta.map((values, index) => row(index + 1, values)).join('')}</sheetData></worksheet>`
  return createZip([
    { name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`) },
    { name: '_rels/.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
    { name: 'xl/workbook.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${TASK_SHEET}" sheetId="1" r:id="rId1"/><sheet name="${META_SHEET}" sheetId="2" r:id="rId2"/></sheets>
</workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`) },
    { name: 'xl/styles.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs>
</styleSheet>`) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(tasks) },
    { name: 'xl/worksheets/sheet2.xml', data: Buffer.from(metadata) },
  ])
}
