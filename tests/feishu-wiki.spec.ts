/** 飞书知识库遍历：目录递归、多文档、多维表格、稳定键、跳过类型、单文档隔离与严格编号冲突。 */
import { describe, expect, it } from 'vitest'
import type { FeishuWikiApi, WikiNodeRef, WikiRecord } from '../src/task-sources/feishu-api.ts'
import { documentTables, readWikiTasks, WikiStrictConflict } from '../src/task-sources/feishu-wiki-read.ts'
import type { TaskFieldMap } from '../src/task-sources/kind.ts'

const columns: TaskFieldMap = { id: 'id', title: 'title', description: 'description', status: 'status', priority: 'priority' }
const binding = (roots: string[] = [], strict = false) => ({ spaceId: 'space-1', roots, strict })

const ref = (nodeToken: string, objType: string, extra: Partial<WikiNodeRef> = {}): WikiNodeRef => ({
  nodeToken, objToken: `obj-${nodeToken}`, objType, title: nodeToken, hasChild: objType === 'folder', spaceId: 'space-1', ...extra })

interface Fixture {
  /** 知识空间第一层节点，未指定根节点时读取。 */
  space?: WikiNodeRef[]
  /** 只注册、不出现在任何目录里的节点，用于根节点与快捷方式解引用。 */
  nodes?: WikiNodeRef[]
  children?: Record<string, WikiNodeRef[]>
  documents?: Record<string, string>
  tables?: Record<string, { tableId: string; name: string }[]>
  records?: Record<string, WikiRecord[]>
}

function apiOf(fixture: Fixture): FeishuWikiApi {
  const nodes = new Map<string, WikiNodeRef>()
  for (const node of [...fixture.space ?? [], ...fixture.nodes ?? []]) nodes.set(node.nodeToken, node)
  for (const list of Object.values(fixture.children ?? {})) for (const node of list) nodes.set(node.nodeToken, node)
  return {
    async node(token) {
      const node = nodes.get(token)
      if (!node) throw new Error(`没有节点 ${token}`)
      return node
    },
    async children(spaceId, parentToken) {
      if (spaceId !== 'space-1') throw new Error('permission denied')
      return parentToken === '' ? fixture.space ?? [] : fixture.children?.[parentToken] ?? []
    },
    async document(documentId) {
      const content = fixture.documents?.[documentId]
      if (content === undefined) throw new Error(`文档 ${documentId} 读取失败`)
      return content
    },
    async tables(appToken) { return fixture.tables?.[appToken] ?? [] },
    async records(appToken, tableId) { return fixture.records?.[`${appToken}:${tableId}`] ?? [] },
  }
}

const table = (...rows: string[]): string => `| id | title | description | status |
| --- | --- | --- | --- |
${rows.map(row => `| ${row} |`).join('\n')}
`

describe('feishu wiki reading', () => {
  it('reads roots in order, recurses into folders and keeps node-scoped ids across documents', async () => {
    const api = apiOf({
      nodes: [ref('root1', 'folder'), ref('doc-c', 'docx')],
      children: {
        root1: [ref('sub', 'folder'), ref('doc-a', 'docx')],
        sub: [ref('doc-b', 'docx')],
      },
      documents: {
        'obj-doc-a': table('1 | 登录 | 修复登录 | 待处理'),
        'obj-doc-b': table('2 | 支付 | 修复支付 | 待处理'),
        'obj-doc-c': table('3 | 导出 | 修复导出 | 待处理'),
      },
    })
    const result = await readWikiTasks(api, binding(['root1', 'doc-c']), columns)
    expect(result.tasks.map(task => task.id)).toEqual(['feishu:doc-b:2', 'feishu:doc-a:1', 'feishu:doc-c:3'])
    expect(result.documents).toBe(3)
    expect(result.tables).toBe(3)
    expect(result.issues).toEqual([])
  })

  it('reads every task table of one document and keeps table order', async () => {
    const api = apiOf({
      space: [ref('doc', 'docx')],
      documents: { 'obj-doc': `${table('1 | 登录 | 修复 | 待处理')}\n说明\n${table('2 | 支付 | 修复 | 待处理')}` },
    })
    const result = await readWikiTasks(api, binding(), columns)
    expect(result.tasks.map(task => [task.id, task.title])).toEqual([['feishu:doc:1', '登录'], ['feishu:doc:2', '支付']])
    expect(result.tables).toBe(2)
  })

  it('reads bitable tables with record-scoped stable keys and skips non-task tables', async () => {
    const api = apiOf({
      space: [ref('bit', 'bitable')],
      tables: { 'obj-bit': [{ tableId: 't1', name: '任务' }, { tableId: 't2', name: '说明' }] },
      records: {
        'obj-bit:t1': [
          { recordId: 'rec1', fields: { id: 'A-1', title: '登录', description: { text: '修复登录' }, status: '待处理', priority: '高' } },
          { recordId: 'rec2', fields: { id: 'A-2', title: '支付', status: '待处理' } },
        ],
        'obj-bit:t2': [{ recordId: 'rec3', fields: { note: '没有编号与标题' } }],
      },
    })
    const result = await readWikiTasks(api, binding(), columns)
    expect(result.tasks).toEqual([
      { id: 'feishu-bitable:bit:t1:rec1', title: '登录', description: '修复登录', status: '待处理', priority: '高' },
      { id: 'feishu-bitable:bit:t1:rec2', title: '支付', description: '', status: '待处理' },
    ])
    expect(result.bitables).toBe(1)
    expect(result.skipped).toEqual({ 'bitable:non-task-table': 1 })
  })

  it('skips sheets and documents without a task table, and resolves shortcuts under the bound space', async () => {
    const api = apiOf({
      space: [ref('sheet', 'sheet'), ref('plain', 'docx'), ref('short', 'shortcut', { objToken: 'doc' })],
      nodes: [ref('doc', 'docx')],
      documents: { 'obj-plain': '没有表格', 'obj-doc': table('1 | 登录 | 修复 | 待处理') },
    })
    const result = await readWikiTasks(api, binding(), columns)
    expect(result.tasks.map(task => task.id)).toEqual(['feishu:doc:1'])
    expect(result.skipped).toEqual({ sheet: 1, 'docx:no-task-table': 1 })
    expect(result.issues).toEqual([])
  })

  it('isolates a failing document and still reads the others', async () => {
    const api = apiOf({
      space: [ref('broken', 'docx'), ref('good', 'docx')],
      documents: { 'obj-good': table('1 | 登录 | 修复 | 待处理') },
    })
    const result = await readWikiTasks(api, binding(), columns)
    expect(result.tasks.map(task => task.id)).toEqual(['feishu:good:1'])
    expect(result.issues).toMatchObject([{ nodeToken: 'broken', reason: expect.stringContaining('读取失败') }])
  })

  it('reports unreadable roots and refuses a read when every root fails', async () => {
    const partial = await readWikiTasks(apiOf({ nodes: [ref('doc-c', 'docx')], documents: { 'obj-doc-c': table('1 | 登录 | 修复 | 待处理') } }),
      binding(['nope', 'doc-c']), columns)
    expect(partial.tasks.map(task => task.id)).toEqual(['feishu:doc-c:1'])
    expect(partial.issues).toMatchObject([{ nodeToken: 'nope' }])
    await expect(readWikiTasks(apiOf({}), binding(['nope', 'absent']), columns))
      .rejects.toThrow('所有根节点都无法读取')
  })

  it('rejects the whole read on a cross-document id only in strict mode', async () => {
    const api = apiOf({
      space: [ref('a', 'docx'), ref('b', 'docx')],
      documents: { 'obj-a': table('1 | 登录 | 修复 | 待处理'), 'obj-b': table('1 | 支付 | 修复 | 待处理') },
    })
    await expect(readWikiTasks(api, binding([], true), columns)).rejects.toThrow(WikiStrictConflict)
    const relaxed = await readWikiTasks(api, binding(), columns)
    expect(relaxed.tasks.map(task => task.id)).toEqual(['feishu:a:1', 'feishu:b:1'])
  })

  it('parses all markdown tables and ignores prose and separator-less blocks', () => {
    const tables = documentTables(`# 任务

| 编号 | 标题 |
| --- | --- |
| 1 | 登录 |

说明

| 编号 | 标题 |
| --- | --- |
| 2 | 支付 |
`)
    expect(tables.map(parsed => parsed.rows.map(row => row.values))).toEqual([
      [{ 编号: '1', 标题: '登录' }],
      [{ 编号: '2', 标题: '支付' }],
    ])
  })
})
