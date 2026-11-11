/** 任务来源驱动：Excel / 飞书读取、字段级预检与注册表扩展。 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Commands } from '../src/infra/commands.ts'
import { readTaskTable } from '../src/task-sources/table.ts'
import { TASK_SOURCE_DRIVERS, TaskSourceRegistry, taskSources } from '../src/task-sources/index.ts'
import { excelTaskSource } from '../src/task-sources/excel.ts'
import { feishuWikiTaskSource } from '../src/task-sources/feishu-wiki.ts'
import { TaskRepoError, type TaskSourceDriver, type TaskSourceVerifyDeps } from '../src/task-sources/kind.ts'

const temporary = (): string => mkdtempSync(join(tmpdir(), 'dsh-task-source-'))
const deps = (syncRepo: TaskSourceVerifyDeps['syncRepo'] = async () => temporary()): TaskSourceVerifyDeps => ({
  lark: async () => undefined, syncRepo,
})

describe('excel task source', () => {
  it('lists tasks from the repository working copy after syncing it', async () => {
    const root = temporary()
    mkdirSync(join(root, 'tasks'))
    writeFileSync(join(root, 'tasks', 'backlog.csv'), 'id,title,description,status\n1,登录,修复,待处理\n', 'utf8')
    const config = excelTaskSource.schema.parse({ repo: 'repo-1', file: 'tasks/backlog.csv' })
    const sync = vi.fn(async () => root)
    const tasks = await excelTaskSource.list(config, { signal: new AbortController().signal, commands: {} as Commands, syncRepo: sync })
    expect(sync).toHaveBeenCalledWith('repo-1')
    expect(tasks).toEqual([{ id: '1', title: '登录', description: '修复', status: '待处理' }])
  })

  it('reports a missing file, a missing repository and a successful sync as distinct checks', async () => {
    const root = temporary()
    const missing = excelTaskSource.schema.parse({ repo: 'repo-1', file: 'tasks/none.csv' })
    const fileCheck = await excelTaskSource.verify(missing, 'file', deps(async () => root))
    expect(fileCheck[0]).toMatchObject({ field: 'file', ok: false, code: 'taskFileMissing' })

    const repoCheck = await excelTaskSource.verify(missing, 'repo', deps(async () => {
      throw new TaskRepoError('repoMissing', '代码仓库记录不存在：repo-1') }))
    expect(repoCheck[0]).toMatchObject({ field: 'repo', ok: false, code: 'taskRepoMissing' })

    const notReady = await excelTaskSource.verify(missing, 'repo', deps(async () => {
      throw new TaskRepoError('repoNotReady', '代码仓库记录尚未配置仓库：repo-1') }))
    expect(notReady[0]).toMatchObject({ field: 'repo', ok: false, code: 'taskRepoNotReady' })

    const syncFailed = await excelTaskSource.verify(missing, 'repo', deps(async () => {
      throw new TaskRepoError('syncFailed', '鉴权失败') }))
    expect(syncFailed[0]).toMatchObject({ field: 'repo', ok: false, code: 'taskRepoSyncFailed', values: { output: '鉴权失败' } })

    const syncCheck = await excelTaskSource.verify(missing, 'repo', deps(async () => root))
    expect(syncCheck[0]).toMatchObject({ field: 'repo', ok: true, code: 'taskRepoOk', values: { directory: root } })
  })

  it('writes a status back into the repository working copy and lists it again', async () => {
    const root = temporary()
    mkdirSync(join(root, 'tasks'))
    writeFileSync(join(root, 'tasks', 'backlog.csv'), 'id,title,description,status\n1,登录,修复,待处理\n', 'utf8')
    const config = excelTaskSource.schema.parse({ repo: 'repo-1', file: 'tasks/backlog.csv' })
    await excelTaskSource.writeback!(config, { taskId: '1', taskTitle: '登录' }, '已完成', { syncRepo: async () => root })
    await expect(excelTaskSource.list(config, { signal: new AbortController().signal, commands: {} as Commands, syncRepo: async () => root }))
      .resolves.toEqual([{ id: '1', title: '登录', description: '修复', status: '已完成' }])
  })
})

describe('feishu wiki task source', () => {
  it('lists tasks through the lark CLI bound to the selected source record', async () => {
    const lark = vi.fn(async (args: string[]) => {
      if (args.includes('/open-apis/wiki/v2/spaces/get_node')) return { node: { obj_type: 'docx', obj_token: 'doc-1' } }
      return { content: '| id | title | description | status |\n| --- | --- | --- | --- |\n| 1 | 登录 | 修复 | 待处理 |\n' }
    })
    const config = feishuWikiTaskSource.schema.parse({ source: 'feishu', url: 'https://x.feishu.cn/wiki/wikcn1' })
    const tasks = await feishuWikiTaskSource.list(config, {
      signal: new AbortController().signal, commands: { lark } as unknown as Commands })
    expect(tasks).toEqual([{ id: '1', title: '登录', description: '修复', status: '待处理' }])
    expect(lark).toHaveBeenCalledWith(expect.arrayContaining(['/open-apis/wiki/v2/spaces/get_node']))
  })

  it('reports a missing Feishu source before reading the document', async () => {
    const config = feishuWikiTaskSource.schema.parse({ source: 'feishu', url: 'https://x.feishu.cn/wiki/wikcn1' })
    const checks = await feishuWikiTaskSource.verify(config, 'url', { lark: async () => undefined, syncRepo: async () => '' })
    expect(checks[0]).toMatchObject({ field: 'url', ok: false, code: 'feishuSourceMissing' })
  })
})

describe('task source registry', () => {
  it('rejects a missing name before touching the source', async () => {
    const checks = await taskSources.verify('excel', {}, 'name', { name: '  ' }, deps())
    expect(checks).toEqual([{ field: 'name', ok: false, scope: 'check', code: 'sourceNameRequired', values: {} }])
    const all = await taskSources.verify('excel', {}, 'all', { name: '' }, deps())
    expect(all[0]).toMatchObject({ field: 'name', ok: false, code: 'sourceNameRequired' })
  })

  it('adds a driver by registering it, and the panel catalog follows the registry', () => {
    const fake: TaskSourceDriver = {
      kind: 'fake',
      title: { zh: '假来源', en: 'Fake source' },
      description: { zh: '用于验证扩展点', en: 'Extension check' },
      schema: z.object({}).strict(),
      fields: [{ key: 'endpoint', type: 'text', label: { zh: '地址', en: 'Endpoint' } }],
      fieldMap: { defaults: { id: 'id', title: 'title', description: 'description', status: 'status', priority: 'priority' }, required: ['id', 'title'] },
      async verify(_config, field) { return [{ field, ok: true, scope: 'check', code: 'sourceKindOk', values: {} }] },
      async list() { return [{ id: '1', title: 'fake', description: '', status: '' }] },
    }
    const registry = new TaskSourceRegistry([...TASK_SOURCE_DRIVERS, fake])
    expect(registry.kinds().map(driver => driver.kind)).toContain('fake')
    expect(registry.kind('fake')).toBe(fake)
  })

  it('reads a manifest with the physical row numbers the table reader reports', async () => {
    const file = join(temporary(), 'tasks.csv')
    writeFileSync(file, 'id,title\n1,登录\n\n2,登出\n', 'utf8')
    expect(await readTaskTable(file, '')).toEqual({
      header: ['id', 'title'],
      rows: [{ number: 2, values: { id: '1', title: '登录' } }, { number: 4, values: { id: '2', title: '登出' } }],
    })
  })
})
