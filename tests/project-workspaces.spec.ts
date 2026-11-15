/** ProjectWorkspaces：宿主侧项目归类的幂等建立、改名同步、注销与按路径遗忘。 */
import { expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { ProjectWorkspaces, type WorkspaceRegistryLike } from '../src/app/project-workspaces.ts'
import { Store } from '../src/app/store.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 可断言的内存注册表：create/get/list/delete 与标题记录。 */
function registry(): WorkspaceRegistryLike & { titles: Record<string, string>; deleted: string[] } {
  const titles: Record<string, string> = {}, deleted: string[] = [], created: string[] = []
  return {
    titles, deleted,
    async create(path, title) { created.push(path); titles[path] = title ?? path
      return { id: path, title: titles[path]!, setTitle: async value => { titles[path] = value } } },
    get: id => created.includes(id) && !deleted.includes(id)
      ? { id, title: titles[id]!, path: id, setTitle: async value => { titles[id] = value } } : undefined,
    list: () => created.filter(path => !deleted.includes(path)).map(path => ({ id: path, path })),
    async delete(id) { deleted.push(id) },
  }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pw-'))
  const store = new Store(join(dir, 't.sqlite'))
  store.saveSettings({ executor: { directory: dir } } as never)
  store.projects.save('alpha', { name: 'Alpha', enabled: true } as never)
  const reg = registry()
  const workspaces = new ProjectWorkspaces({ registry: reg, store, workRoot: dir })
  return { store, reg, workspaces, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}
const withProject = (store: Store, execution: Record<string, unknown> = {}): void => {
  store.tickets.save({ id: 't1', title: '修回归', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v', scope: 's',
    actor: { source: 'feishu', id: 'ou' }, basis: { via: 'addressed', addressed: 'mention' } }, origin: { triggerId: 'tr', triggerIds: ['tr'] },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', execution } as unknown as Ticket)
}

it('creates a workspace once, retitles it when the project is renamed, and stores the id', async () => {
  const { store, reg, workspaces, dir, cleanup } = fixture()
  try {
    await workspaces.sync('alpha')
    expect(reg.deleted).toEqual([])
    expect(Object.keys(reg.titles)).toHaveLength(1)
    expect(store.projects.get('alpha')!.hostWorkspaceId).toBeTruthy()
    // 再次同步：幂等，不新建。
    await workspaces.sync('alpha')
    expect(Object.keys(reg.titles)).toHaveLength(1)
    // 项目改名：标题随项目同步。
    store.projects.save('alpha', { ...store.projects.get('alpha')!, name: 'Alpha 二期' } as never)
    await workspaces.sync('alpha')
    expect(Object.values(reg.titles)[0]).toBe('Alpha 二期')
    // workspace 建在执行根下的项目目录上（项目 ID 洗成目录名）。
    expect(Object.keys(reg.titles)[0]!.startsWith(dir)).toBe(true)
  } finally { cleanup() }
})

it('removes the workspace on project deletion but keeps the directory', async () => {
  const { store, reg, workspaces, cleanup } = fixture()
  try {
    await workspaces.sync('alpha')
    const path = Object.keys(reg.titles)[0]!
    store.projects.remove('alpha')
    await workspaces.remove('alpha')
    expect(reg.deleted).toEqual([path])
    expect(reg.list()).toEqual([])
  } finally { cleanup() }
})

it('forgets a workspace whose path matches the reclaimed ticket directory', async () => {
  const { reg, workspaces, cleanup } = fixture()
  try {
    const directory = `${reg.titles && '' }/srv/work/quiet-otter-1`
    await workspaces.sync('alpha')
    // 注册一个模拟的工单 workspace（路径即其 cwd）。
    await reg.create('/srv/work/quiet-otter-1')
    await workspaces.forgetPath('/srv/work/quiet-otter-1')
    expect(reg.deleted).toContain('/srv/work/quiet-otter-1')
    // 项目 workspace 路径不同，不受影响。
    expect(reg.deleted).toHaveLength(1)
    expect(directory).toBeTruthy()
  } finally { cleanup() }
})

it('names a worker workspace after the project and ticket title', () => {
  const { store, cleanup } = fixture()
  try {
    store.projects.save('alpha', { name: 'Alpha', enabled: true } as never)
    withProject(store, { project: 'alpha' })
    const sessions = {
      workerWorkspaceTitle: (sessionId: string): string => {
        const ticketId = sessionId.replace(/^worker-/, '')
        const ticket = store.tickets.get(ticketId)
        if (!ticket) return ticketId
        const project = ticket.execution?.project ? store.projects.get(ticket.execution.project) : undefined
        return project ? `${project.name} · ${ticket.title}` : ticket.title
      },
    }
    expect(sessions.workerWorkspaceTitle('worker-t1')).toBe('Alpha · 修回归')
  } finally { cleanup() }
})
