import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { PipelineConfigSchema } from '../src/pipeline/config.ts'
import { remoteOf } from '../src/pipeline/code.ts'
import { parseDelimited, readTaskRows } from '../src/pipeline/excel.ts'
import { serialize as serializeTable } from '../src/pipeline/writeback.ts'
import { checklistTasks, feishuToken, tableRows } from '../src/pipeline/feishu.ts'
import { runPipeline, type PipelineHost } from '../src/pipeline/runner.ts'
import { normalizeTasks, plannable, splitTask, workItems } from '../src/pipeline/tasks.ts'
import { writeTaskStatus } from '../src/pipeline/writeback.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { ScheduledTicket, Ticket } from '../src/core/index.ts'

const columns = { id: 'id', title: 'title', description: 'description', status: 'status', priority: 'priority' }

/** 创建临时目录，用于清单、代码镜像与运行状态。 */
const temporary = (): string => mkdtempSync(join(tmpdir(), 'dsh-pipeline-'))

describe('code remote', () => {
  it('derives HTTPS remotes from source records and accepts an SSH override', () => {
    expect(remoteOf({ kind: 'github', instanceUrl: '', repository: 'acme/app' })).toBe('https://github.com/acme/app.git')
    expect(remoteOf({ kind: 'gitlab', instanceUrl: 'https://git.example.com', project: 'grp/app' })).toBe('https://git.example.com/grp/app.git')
    expect(remoteOf({ kind: 'github', instanceUrl: '', repository: 'acme/app' }, 'git@github.com:acme/app.git'))
      .toBe('git@github.com:acme/app.git')
  })

  it('rejects remotes that embed a password, in the record and in the config', () => {
    expect(() => remoteOf({ kind: 'github', instanceUrl: '', repository: 'acme/app' }, 'https://user:pass@github.com/acme/app.git'))
      .toThrow('代码来源远端地址不能包含用户名或密码')
    expect(() => PipelineConfigSchema.parse({ remoteUrl: 'https://user:pass@gitlab.com/grp/app.git' }))
      .toThrow('远端地址不能包含用户名或密码')
  })
})

describe('task list parsing', () => {
  it('parses quoted CSV fields, embedded newlines and CRLF', () => {
    const rows = parseDelimited('id,title,description\r\n1,"登录","第一行\n第二行"\r\n2,导出,"含 ""引号"""\r\n', ',')
    expect(rows).toEqual([['id', 'title', 'description'], ['1', '登录', '第一行\n第二行'], ['2', '导出', '含 "引号"']])
  })

  it('normalizes rows into tasks and generates a stable id when missing', () => {
    const tasks = normalizeTasks([{ title: ' 修复登录 ', description: '文案', status: '待处理' }, { title: '   ' }], columns)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ title: '修复登录', description: '文案', status: '待处理' })
    expect(tasks[0]!.id).toMatch(/^row-/)
  })

  it('splits checkboxes first, then numbered lists, otherwise keeps one item', () => {
    const boxed = splitTask({ id: '1', title: '发布', description: '- [ ] 打包\n- [x] 上传', status: '' })
    expect(boxed.map(item => item.title)).toEqual(['发布 / 打包', '发布 / 上传'])
    const numbered = splitTask({ id: '2', title: '改造', description: '1. 前端\n2. 后端', status: '' })
    expect(numbered).toHaveLength(2)
    expect(splitTask({ id: '3', title: '单步', description: '只有一段', status: '' })).toHaveLength(1)
  })

  it('keeps work item keys stable across runs and plans failed items until the retry limit', () => {
    const tasks = normalizeTasks([{ id: '1', title: 'A', description: '- [ ] x', status: '' }], columns)
    const first = workItems(tasks, 'pipe')
    expect(workItems(tasks, 'pipe')).toEqual(first)
    const records = { [first[0]!.key]: { state: 'failed' as const, attempts: 2, at: '2026-11-10T00:00:00.000Z' } }
    expect(plannable(first, records, 2)).toHaveLength(1)
    expect(plannable(first, records, 1)).toHaveLength(0)
    expect(plannable(first, { [first[0]!.key]: { state: 'written-back', attempts: 1, at: '' } }, 2)).toHaveLength(0)
  })

  it('reads a real .xlsx workbook built from shared strings and inline cells', async () => {
    const dir = temporary()
    const file = join(dir, 'tasks.xlsx')
    writeFileSync(file, xlsx())
    const rows = await readTaskRows(file, '任务')
    expect(rows).toEqual([{ id: '1', title: '修复登录', description: '来自共享字符串', status: '待处理' },
      { id: '2', title: '导出', description: '内联文本', status: '进行中' }])
  })
})

describe('feishu task source', () => {
  it('recognises wiki and document links and parses a markdown table', () => {
    expect(feishuToken('https://x.feishu.cn/wiki/wikcnAbC123')).toEqual({ kind: 'wiki', token: 'wikcnAbC123' })
    expect(feishuToken('https://x.feishu.cn/docx/doxcnAbC123')).toEqual({ kind: 'docx', token: 'doxcnAbC123' })
    const rows = tableRows('说明\n| id | title | description |\n| --- | --- | --- |\n| 1 | 登录 | 修复 |\n')
    expect(rows).toEqual([{ id: '1', title: '登录', description: '修复' }])
  })

  it('falls back to checklist lines', () => {
    expect(checklistTasks('- [ ] 修复登录\n- [x] 导出\n')).toMatchObject([{ title: '修复登录' }, { title: '导出' }])
  })
})

describe('writeback', () => {
  it('updates only the matching status cell and keeps the rest of the file', async () => {
    const dir = temporary()
    const file = join(dir, 'tasks.csv')
    writeFileSync(file, 'id,title,description,status\n1,登录,"含,逗号",待处理\n2,导出,,待处理\n', 'utf8')
    const config = PipelineConfigSchema.parse({ taskFile: file, taskKind: 'excel' })
    await writeTaskStatus(config, { taskId: '1', taskTitle: '登录' }, '已完成')
    expect(readFileSync(file, 'utf8')).toBe('id,title,description,status\n1,登录,"含,逗号",已完成\n2,导出,,待处理\n')
  })

  it('serializes fields that need quoting', () => {
    expect(serializeTable([['a', 'b,c', 'd"e'], ['f', 'g\nh', '']], ',')).toBe('a,"b,c","d""e"\nf,"g\nh",\n')
  })

  it('writes a styled .xlsx status cell and keeps every other entry byte for byte', async () => {
    const { file, styles } = styledXlsx()
    const path = join(temporary(), 'tasks.xlsx')
    writeFileSync(path, file)
    const config = PipelineConfigSchema.parse({ taskFile: path, taskKind: 'excel', taskSheet: '任务' })
    await writeTaskStatus(config, { taskId: '1', taskTitle: '修复登录' }, '已完成')
    const before = unzip(file)
    const after = unzip(readFileSync(path))
    expect(await readTaskRows(path, '任务')).toEqual([{ id: '1', title: '修复登录', description: '说明', status: '已完成' }])
    expect(after.get('xl/styles.xml')).toEqual(styles)
    for (const name of [...before.keys()].filter(item => item !== 'xl/worksheets/sheet1.xml')) {
      expect(after.get(name)).toEqual(before.get(name))
    }
    expect(after.get('xl/worksheets/sheet1.xml')!.toString('utf8'))
      .toContain('<c r="D2" s="5" t="inlineStr"><is><t>已完成</t></is></c>')
    const once = readFileSync(path)
    await writeTaskStatus(config, { taskId: '1', taskTitle: '修复登录' }, '已完成')
    expect(readFileSync(path)).toEqual(once)
  })

  it('inserts a status cell when the matched row has none', async () => {
    const path = join(temporary(), 'tasks.xlsx')
    writeFileSync(path, archive([
      ['xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="任务" sheetId="1" r:id="rId1"/></sheets></workbook>')],
      ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')],
      ['xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData>'
        + '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>title</t></is></c>'
        + '<c r="D1" t="inlineStr"><is><t>status</t></is></c></row>'
        + '<row r="2"><c r="A2" t="inlineStr"><is><t>1</t></is></c><c r="B2" t="inlineStr"><is><t>登录</t></is></c></row>'
        + '</sheetData></worksheet>')],
    ]))
    const config = PipelineConfigSchema.parse({ taskFile: path, taskKind: 'excel', taskSheet: '任务' })
    await writeTaskStatus(config, { taskId: '1', taskTitle: '登录' }, '已完成')
    expect(await readTaskRows(path, '任务')).toEqual([{ id: '1', title: '登录', status: '已完成' }])
    expect(unzip(readFileSync(path)).get('xl/worksheets/sheet1.xml')!.toString('utf8'))
      .toContain('<c r="D2" t="inlineStr"><is><t>已完成</t></is></c>')
  })

  it('fails clearly when the .xlsx row or status column is missing', async () => {
    const path = join(temporary(), 'tasks.xlsx')
    writeFileSync(path, styledXlsx().file)
    const config = PipelineConfigSchema.parse({ taskFile: path, taskKind: 'excel', taskSheet: '任务' })
    await expect(writeTaskStatus(config, { taskId: '9', taskTitle: '不存在' }, '已完成')).rejects.toThrow('找不到任务')
    const other = PipelineConfigSchema.parse({ taskFile: path, taskKind: 'excel', taskSheet: '任务', columnStatus: 'state' })
    await expect(writeTaskStatus(other, { taskId: '1', taskTitle: '修复登录' }, '已完成')).rejects.toThrow('缺少状态列')
  })
})

describe('pipeline runner', () => {
  /** 构造一次运行所需的宿主：假 git、假工单与内存状态。 */
  type FakeTicket = { id: string; ended?: { at: string; outcome: string } }
  function host(file: string, options: { outcome?: 'completed' | 'stopped' } = {}) {
    const dir = temporary()
    const state = new Map<string, unknown>()
    const tickets = new Map<string, FakeTicket>()
    const admitted: ScheduledTicket[] = []
    let initialized = false
    const finish = options.outcome ?? 'completed'
    const commands = {
      scope: () => ({
        source: { kind: 'github', instanceUrl: '', repository: 'acme/app' },
        github: { repository: 'acme/app' },
        gitlab: undefined,
        git: vi.fn(async (args: string[]) => {
          if (args[1] === '--git-dir') { if (!initialized) throw new Error('not a repository'); return '.git' }
          if (args[0] === 'init') { initialized = true; return '' }
          if (args[0] === 'ls-remote') return 'ref: refs/heads/main\tHEAD\n'
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'a1b2c3d4e5f6'
          if (args[0] === 'rev-parse' && args.includes('--verify')) return 'ok'
          return ''
        }),
      }),
    } as unknown as Commands
    const value: PipelineHost = {
      recordId: 'pipe', stateDir: dir, commands,
      schedule: input => {
        admitted.push(input)
        const ticketId = `ticket-${admitted.length}`
        tickets.set(ticketId, { id: ticketId })
        return { ticketId, created: true }
      },
      tickets: { get: id => tickets.get(id) as unknown as Ticket | undefined },
      state: { get: key => state.get(key) as never, set: (key, item) => { state.set(key, item) } },
      config: () => PipelineConfigSchema.parse({ codeSource: 'github', taskFile: file, intervalMinutes: 1, concurrency: 1,
        maxRetries: 1, doneStatus: '已完成', failedStatus: '失败' }),
      codeKinds: () => ({ github: 'github' }),
      report: () => {},
    }
    return {
      host: value, admitted, tickets,
      /** 每次等待时结束第一张未结束的工单，模拟执行器完成。 */
      sleep: async (): Promise<void> => {
        for (const ticket of tickets.values()) {
          if (!ticket.ended) { ticket.ended = { at: '2026-11-10T00:00:00.000Z', outcome: finish }; return }
        }
      },
    }
  }

  it('syncs code, loads the list, admits one ticket per item, then writes the status back', async () => {
    const dir = temporary()
    const file = join(dir, 'tasks.csv')
    writeFileSync(file, 'id,title,description,status\n1,登录,,待处理\n2,导出,,待处理\n', 'utf8')
    const h = host(file)
    const controller = new AbortController()
    const summary = await runPipeline({ ...h.host, sleep: h.sleep }, controller.signal)
    expect(summary).toMatchObject({ opened: 2, writtenBack: 2, deferred: 0 })
    expect(h.admitted.map(item => item.task)).toEqual(['1', '2'])
    expect(h.admitted[0]!.trigger.source).toBe('github')
    expect(h.admitted[0]!.trigger.threads[0]!.id).toBe('pipeline/pipe/1')
    expect(readFileSync(file, 'utf8')).toContain('1,登录,,已完成')
  })

  it('does not open a second ticket for a completed task on the next run', async () => {
    const dir = temporary()
    const file = join(dir, 'tasks.csv')
    writeFileSync(file, 'id,title,description,status\n1,登录,,待处理\n', 'utf8')
    const h = host(file)
    const hostValue = { ...h.host, sleep: h.sleep }
    await runPipeline(hostValue, new AbortController().signal)
    await runPipeline(hostValue, new AbortController().signal)
    expect(h.admitted).toHaveLength(1)
  })

  it('retries a failed ticket until the limit and writes the failed status', async () => {
    const dir = temporary()
    const file = join(dir, 'tasks.csv')
    writeFileSync(file, 'id,title,description,status\n1,登录,,待处理\n', 'utf8')
    const h = host(file, { outcome: 'stopped' })
    const hostValue = { ...h.host, sleep: h.sleep }
    await runPipeline(hostValue, new AbortController().signal)
    expect(h.admitted).toHaveLength(1)
    await runPipeline(hostValue, new AbortController().signal)
    expect(h.admitted).toHaveLength(2)
    expect(readFileSync(file, 'utf8')).toContain('1,登录,,失败')
  })
})

/** 用 Node 内置 zlib 构造最小 xlsx（stored + deflate 两种条目）。 */
function xlsx(): Buffer {
  return archive([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>')],
    ['xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="任务" sheetId="1" r:id="rId1"/></sheets></workbook>')],
    ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')],
    ['xl/sharedStrings.xml', Buffer.from('<sst><si><t>修复登录</t></si><si><t>来自共享字符串</t></si></sst>')],
    ['xl/worksheets/sheet1.xml', Buffer.from(
      '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>title</t></is></c>'
      + '<c r="C1" t="inlineStr"><is><t>description</t></is></c><c r="D1" t="inlineStr"><is><t>status</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>1</t></is></c><c r="B2" t="s"><v>0</v></c>'
      + '<c r="C2" t="s"><v>1</v></c><c r="D2" t="inlineStr"><is><t>待处理</t></is></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>2</t></is></c><c r="B3" t="inlineStr"><is><t>导出</t></is></c>'
      + '<c r="C3" t="inlineStr"><is><t>内联文本</t></is></c><c r="D3" t="inlineStr"><is><t>进行中</t></is></c></row>'
      + '</sheetData></worksheet>')],
  ])
}

/** 带样式的 xlsx：状态单元格使用共享字符串与样式索引，并包含样式表等需要原样保留的条目。 */
function styledXlsx(): { file: Buffer; styles: Buffer } {
  const styles = Buffer.from('<styleSheet><fonts count="1"><font><sz val="11"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="0" fontId="0" fillId="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="1"/><xf numFmtId="0" fontId="0" fillId="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="1"/><xf numFmtId="0" fontId="0" fillId="1"><alignment wrapText="1"/></xf>'
    + '</cellXfs></styleSheet>')
  const file = archive([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>')],
    ['xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="任务" sheetId="1" r:id="rId1"/></sheets></workbook>')],
    ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')],
    ['xl/styles.xml', styles],
    ['xl/sharedStrings.xml', Buffer.from('<sst><si><t>修复登录</t></si><si><t>待处理</t></si></sst>')],
    ['xl/worksheets/sheet1.xml', Buffer.from(
      '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>title</t></is></c>'
      + '<c r="C1" t="inlineStr"><is><t>description</t></is></c><c r="D1" t="inlineStr"><is><t>status</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>1</t></is></c><c r="B2" t="s"><v>0</v></c>'
      + '<c r="C2" t="inlineStr"><is><t>说明</t></is></c><c r="D2" s="5" t="s"><v>1</v></c></row>'
      + '</sheetData></worksheet>')],
  ])
  return { file, styles }
}

/** 按中央目录把 ZIP 拆成条目，用于断言未修改条目逐字节不变。 */
function unzip(buffer: Buffer): Map<string, Buffer> {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buffer.readUInt16LE(eocd + 10)
  let at = buffer.readUInt32LE(eocd + 16)
  const entries = new Map<string, Buffer>()
  for (let index = 0; index < count; index++) {
    const method = buffer.readUInt16LE(at + 10)
    const size = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extra = buffer.readUInt16LE(at + 30)
    const comment = buffer.readUInt16LE(at + 32)
    const offset = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    const data = buffer.subarray(start, start + size)
    entries.set(name, method === 8 ? inflateRawSync(data) : data)
    at += 46 + nameLength + extra + comment
  }
  return entries
}

/** 用 Node 内置 zlib 打包 ZIP（stored 或 deflate 由长度决定）。 */
function archive(entries: readonly (readonly [string, Buffer])[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of entries) {
    const compressed = content.length > 40 ? deflateRawSync(content) : content
    const method = content.length > 40 ? 8 : 0
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc(content), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(local, 30)
    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc(content), 16); central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(content.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    locals.push(local, compressed); centrals.push(central); offset += local.length + compressed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** ZIP 条目所需的 CRC32。 */
function crc(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}
