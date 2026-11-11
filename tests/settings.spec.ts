/** 设置保存、暂停切换和策略同步的并发、重试与校验测试。 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { UserError, threadKey } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // 被同一来源的另一次保存抢先的账户检查同样会被拒绝。
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const source = settings.block('source:feishu')
  const value = source.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:feishu', { ...value, config: { ...value.config, cli: '/opt/bin/lark-other' } }, source.revision,
    'panel')
  await settings.save('source:feishu', { ...value, config: { ...value.config, directMessages: false } }, source.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.feishu!.config).toMatchObject({ cli: value.config.cli, directMessages: false })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // 运行时启动时执行的同步会先完成。
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // 第一次重试也失败，因此下一次等待两分钟。
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // 成功后结束重试。
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})
it('ends unfinished Tickets on a disabled Source, keeps its Threads and Triggers, and reports the count', async () => {
  h = await startRuntime()
  const { settings, store, sources } = h.runtime
  const { trigger, ticket } = await h.acceptedTicket(feishu('e1', '@bot 修复登录'))
  const block = settings.block('source:feishu')
  const value = block.value as { enabled: boolean; config: Record<string, unknown> }
  const meta = trigger.channel!.address
  expect(sources.scope({ source: 'feishu', meta })).toMatchObject({ listened: true })
  const result = await settings.save('source:feishu', { ...value, enabled: false }, block.revision, 'panel')
  expect(result).toMatchObject({ stopped: 1 })
  const ended = store.tickets.get(ticket.id)!
  expect(store.tickets.open().map(item => item.id)).not.toContain(ticket.id)
  expect(ended.ended).toMatchObject({ by: 'human', outcome: 'stopped', reason: 'source_disabled' })
  // 线程与触发器作为历史保留，但该记录不再监听。
  expect(store.threads.get(threadKey(trigger.threads[0]!))).toBeDefined()
  expect(store.triggers.get(trigger.id)).toBeDefined()
  expect(sources.scope({ source: 'feishu', meta })).toEqual({ listened: false, reason: 'source_disabled' })
})
it('refuses to delete a Source with unfinished Tickets, and deletes an unused record with its Policy part', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  await h.acceptedTicket(feishu('e2', '@bot 修复登录'))
  await expect(settings.removeSource('feishu', 'panel')).rejects.toThrow(new UserError('sourceInUse', { source: 'feishu',
    count: '1' }))
  expect(store.settings().sources.feishu).toBeDefined()
  // 新记录按 kind-2 生成；显式重复 ID 被拒绝。
  expect(await settings.createSource('feishu', undefined, {}, 'panel', '支付重构')).toMatchObject({ id: 'feishu-2', restarting: true })
  expect(store.settings().sources['feishu-2']).toBeDefined()
  await expect(settings.createSource('feishu', 'feishu', {}, 'panel', '另一个项目')).rejects.toThrow(new UserError('sourceExists',
    { source: 'feishu' }))
  const policy = store.settings().policy
  await settings.save('policy', { ...policy, sources: { ...policy.sources, 'feishu-2': { allowed: [], admission: {} } } },
    store.blockRevision('policy'), 'panel')
  expect(store.settings().policy.sources['feishu-2']).toBeDefined()
  expect(await settings.removeSource('feishu-2', 'panel')).toEqual({ removed: true, restarting: true })
  expect(store.settings().sources['feishu-2']).toBeUndefined()
  expect(store.settings().policy.sources['feishu-2']).toBeUndefined()
})
it('prechecks candidate Source fields with real probes without writing settings', async () => {
  h = await startRuntime()
  const { setup, sources, store } = h.runtime
  const feishuConfig = store.settings().sources.feishu!.config as Record<string, unknown>
  const before = JSON.stringify(store.settings())
  // 名称必填；记录 ID 只做登记检查。
  expect(await setup.checkSource('feishu', feishuConfig, 'name', sources))
    .toMatchObject([{ ok: false, code: 'sourceNameRequired' }])
  expect(await setup.checkSource('feishu', feishuConfig, 'name', sources, { name: '  支付重构 ' }))
    .toEqual([{ field: 'name', ok: true, scope: 'check', code: 'sourceNameOk', values: { name: '支付重构' } }])
  expect(await setup.checkSource('feishu', feishuConfig, 'name', sources, { name: 'x'.repeat(81) }))
    .toMatchObject([{ ok: false, code: 'sourceNameTooLong' }])
  expect(await setup.checkSource('feishu', feishuConfig, 'id', sources, { id: 'feishu' }))
    .toMatchObject([{ ok: false, code: 'sourceIdTaken' }])
  expect(await setup.checkSource('feishu', feishuConfig, 'id', sources, { id: 'Bad_ID' }))
    .toMatchObject([{ ok: false, code: 'sourceIdInvalid' }])
  // 已安装字段运行真实 CLI：机器人账号可用。
  expect(await setup.checkSource('feishu', feishuConfig, 'cli', sources))
    .toMatchObject([{ ok: true, code: 'feishuAccountOk' }])
  expect(await setup.checkSource('nope', feishuConfig, 'kind', sources)).toMatchObject([{ ok: false, code: 'sourceKindUnknown' }])
  // 任务来源属于任务侧：Excel/CSV 必须真实可读，且必须是绝对路径。
  const dir = mkdtempSync(join(tmpdir(), 'check-source-'))
  const file = join(dir, 'tasks.csv')
  writeFileSync(file, 'id,title,description,status\n1,登录,,待处理\n', 'utf8')
  // 任务来源驱动走同一条预检通道：名称必填优先，Excel 真实读清单，飞书缺来源时明确报错。
  expect(await setup.checkTaskSource('excel', { file }, 'name', store.settings(), { name: '' }))
    .toMatchObject([{ ok: false, code: 'sourceNameRequired' }])
  expect(await setup.checkTaskSource('excel', { file }, 'file', store.settings()))
    .toMatchObject([{ ok: true, code: 'taskFileOk', values: { rows: '1' } }])
  expect(await setup.checkTaskSource('excel', { file: join(dir, 'missing.csv') }, 'file', store.settings()))
    .toMatchObject([{ ok: false, code: 'taskFileMissing' }])
  expect(await setup.checkTaskSource('excel', { file: 'tasks.csv' }, 'file', store.settings()))
    .toMatchObject([{ ok: false, code: 'taskFileRelative' }])
  expect(await setup.checkTaskSource('feishu-wiki', { url: 'https://x.feishu.cn/wiki/wikcn1' }, 'url', store.settings()))
    .toMatchObject([{ ok: false, code: 'feishuSourceUnset' }])
  // 预检不写设置、不重启。
  expect(JSON.stringify(store.settings())).toBe(before)
})
it('refuses a Source record without a name now that record names are required', async () => {
  h = await startRuntime()
  const { store } = h.runtime
  const current = store.settings()
  const { name: _name, ...legacy } = current.sources.feishu!
  expect(legacy).not.toHaveProperty('name')
  expect(() => store.saveSettings({ ...current, sources: { ...current.sources, feishu: legacy } })).toThrow()
})
it('records a project name change in settings history', async () => {
  h = await startRuntime()
  const { settings, sources, store } = h.runtime
  const block = 'source:feishu'
  const value = settings.block(block).value as { enabled: boolean; config: unknown }
  await settings.save(block, { ...value, name: '支付重构' }, settings.block(block).revision, 'panel')
  expect(store.settings().sources.feishu!.name).toBe('支付重构')
  expect(policyHistory(store, sources, '').items[0]!.changes).toContainEqual({ code: 'sourceRenamed', source: 'feishu', from: '飞书', to: '支付重构' })
})
it('creates, reads and removes code repos, task sources and projects, and refuses to remove a record a project uses', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const repo = await settings.createCodeRepo('github', 'repo-main', { repository: 'acme/widgets' }, 'panel', '主仓库')
  expect(repo).toMatchObject({ id: 'repo-main', restarting: false })
  const tasks = await settings.createTaskSource('excel', undefined, { file: '/tasks.csv' }, 'panel', '任务表')
  expect(tasks).toMatchObject({ id: 'excel' })
  const project = await settings.createProject(undefined, { name: '支付重构', codeRepo: 'repo-main', taskSource: 'excel' }, 'panel')
  expect(project).toMatchObject({ id: 'project' })
  expect(settings.view().codeRepos.find(item => item.id === 'repo-main')).toMatchObject({ id: 'repo-main', kind: 'github', name: '主仓库', enabled: true,
    read: 'settings/codeRepo:repo-main' })
  expect(settings.view().taskSources).toMatchObject([{ id: 'excel', kind: 'excel', name: '任务表', enabled: true, read: 'settings/taskSource:excel' }])
  expect(settings.view().projects).toMatchObject([{ id: 'project', name: '支付重构', enabled: true, codeRepo: 'repo-main', taskSource: 'excel',
    read: 'settings/project:project' }])
  expect(settings.block('codeRepo:repo-main').value).toEqual({ name: '主仓库', enabled: true, config: { repository: 'acme/widgets' } })
  // 项目仍引用这两条记录时，两者都不能删除。
  await expect(settings.removeCodeRepo('repo-main', 'panel')).rejects.toThrow(new UserError('codeRepoInUse', { repo: 'repo-main', count: '1' }))
  await expect(settings.removeTaskSource('excel', 'panel')).rejects.toThrow(new UserError('taskSourceInUse', { source: 'excel', count: '1' }))
  // 项目改名通过项目块保存，记录自身的类型保持不变。
  const block = settings.block('project:project')
  await settings.save('project:project', { ...(block.value as object), name: '支付重构二期' }, block.revision, 'panel')
  expect(store.settings().projects.project!.name).toBe('支付重构二期')
  expect(await settings.removeProject('project', 'panel')).toMatchObject({ removed: true, restarting: false })
  expect(await settings.removeCodeRepo('repo-main', 'panel')).toMatchObject({ removed: true, restarting: false })
  expect(await settings.removeTaskSource('excel', 'panel')).toMatchObject({ removed: true, restarting: false })
  expect([store.settings().projects, store.settings().taskSources]).toEqual([{}, {}])
  expect(store.settings().codeRepos['repo-main']).toBeUndefined()
})

it('refuses a project whose code repo differs from the repo its Excel task source reads', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  await settings.createCodeRepo('github', 'main', { repository: 'acme/widgets' }, 'panel', '主仓库')
  await settings.createCodeRepo('github', 'other', { repository: 'acme/other' }, 'panel', '另一个仓库')
  await settings.createTaskSource('excel', 'tasks', { repo: 'main', file: 'tasks/backlog.csv' }, 'panel', '任务表')
  await expect(settings.createProject('p1', { name: '支付重构', codeRepo: 'other', taskSource: 'tasks' }, 'panel'))
    .rejects.toThrow(new UserError('projectRepoMismatch', { project: 'p1', source: 'tasks', repo: 'other', taskRepo: 'main' }))
  expect(store.settings().projects.p1).toBeUndefined()
  await expect(settings.createProject('p1', { name: '支付重构', codeRepo: 'main', taskSource: 'tasks' }, 'panel'))
    .resolves.toMatchObject({ id: 'p1' })
})

it('refuses a task source save whose repo no longer matches a project that reads through it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  await settings.createCodeRepo('github', 'main', { repository: 'acme/widgets' }, 'panel', '主仓库')
  await settings.createCodeRepo('github', 'other', { repository: 'acme/other' }, 'panel', '另一个仓库')
  await settings.createTaskSource('excel', 'tasks', { repo: 'main', file: 'tasks/backlog.csv' }, 'panel', '任务表')
  await settings.createProject('p1', { name: '支付重构', codeRepo: 'main', taskSource: 'tasks' }, 'panel')
  const block = settings.block('taskSource:tasks')
  const value = block.value as { enabled: boolean; config: Record<string, unknown> }
  await expect(settings.save('taskSource:tasks', { ...value, config: { ...value.config, repo: 'other' } }, block.revision, 'panel'))
    .rejects.toThrow(new UserError('taskSourceRepoMismatch', { project: 'p1', source: 'tasks', repo: 'main', taskRepo: 'other' }))
  expect(store.settings().taskSources.tasks!.config).toMatchObject({ repo: 'main' })
})
