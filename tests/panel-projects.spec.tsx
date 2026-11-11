// @vitest-environment jsdom
// 项目页签、项目详情与代码仓库 / 项目设置分区。
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, field, find, mount, settle, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

const project = {
  name: '内容运营', enabled: true, codeRepo: 'github', taskSource: 'sheet', gitCredential: '',
  execution: { directory: '', branch: '' },
  schedule: { intervalMinutes: 30, runOnStart: true },
  retry: { maxRetries: 2, retryBackoffSeconds: 60 },
  taskPolicy: { pendingStatuses: ['待处理', 'todo'], doneStatus: '已完成', failedStatus: '失败' },
}
const taskSource = { kind: 'excel', name: '内容清单', enabled: true, config: {} }

function queued(state: 'queued' | 'running', extra: Record<string, unknown> = {}) {
  return { id: `q-${state}`, project: 'content', projectName: '内容运营', task: 'T-1', item: 0, title: '写周报', state,
    attempt: state === 'queued' ? 1 : 0, dueAt: Date.now() + 60_000, enqueuedAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z', ...extra }
}

it('lists projects with queue and runtime counts, then opens the project Tasks and queue', async () => {
  server.settings = { ...server.settings, taskSources: { sheet: taskSource }, projects: { content: project } }
  server.queueItems = [queued('queued'), queued('running', { ticketId: 't1' })]
  await mount()
  await click(zh['tab.projects'])
  expect(text()).toContain('内容运营')
  expect(text()).toContain('排队 1')
  expect(text()).toContain('运行 1')
  expect(text()).toContain(`${server.settings.executor.maxWorkers}`)
  await click('内容运营')
  expect(text()).toContain(zh.projectTasksTitle)
  expect(text()).toContain('写周报')
  expect(text()).toContain(zh['queueState.queued'])
  expect(text()).toContain(zh['queueState.running'])
  expect(text()).toContain('t1')
  expect(text()).toContain(zh.projectNextPollLabel)
})

it('sends retry, cancel and clear requests from the project queue', async () => {
  server.settings = { ...server.settings, taskSources: { sheet: taskSource }, projects: { content: project } }
  server.queueItems = [
    queued('queued', { id: 'q1' }),
    queued('running', { id: 'q2', ticketId: 't2' }),
    queued('queued', { id: 'q3', state: 'failed' }),
  ]
  await mount()
  await click(zh['tab.projects'])
  await click('内容运营')
  await click(zh.queueCancel)
  await click(zh.queueStop)
  await click(zh.queueRetry)
  await click(zh.queueClear)
  const posts = server.requests.filter(request => request.method === 'POST').map(request => request.path)
  expect(posts.some(path => path.includes('queue/q1/cancel'))).toBe(true)
  expect(posts.some(path => path.includes('queue/q2/cancel'))).toBe(true)
  expect(posts.some(path => path.includes('queue/q3/retry'))).toBe(true)
  expect(posts.some(path => path.includes('queue/clear'))).toBe(true)
})

it('creates a project from the settings and saves its polling and retry policy', async () => {
  server.settings = { ...server.settings, taskSources: { sheet: taskSource } }
  await mount()
  await click(zh['tab.projects'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(find(zh['settingsGroup.projects'], '.dt-settings-link'))
  await type(field(zh.sourceName), '内容运营')
  await click(find(zh.projectAdd))
  await settle()
  expect(server.settings.projects.project?.name).toBe('内容运营')
  expect(server.settings.projects.project?.taskSource).toBe('sheet')
  const [editButton] = all('.dt-card button').filter(button => button.textContent?.trim() === zh.edit)
  await click(editButton!)
  await type(field(zh.projectInterval), '5')
  await type(field(zh.projectMaxRetries), '4')
  await click(zh.save)
  expect(server.settings.projects.project?.schedule.intervalMinutes).toBe(5)
  expect(server.settings.projects.project?.retry.maxRetries).toBe(4)
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/project:project'])
})

it('edits a code repository from its settings section', async () => {
  await mount()
  await click(zh['tab.projects'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(find(zh['settingsGroup.codeRepos'], '.dt-settings-link'))
  expect(text()).toContain('GitHub')
  await click(zh.edit)
  await click(zh.projectEnabled)
  await click(zh.save)
  expect(server.settings.codeRepos.github?.enabled).toBe(false)
})
