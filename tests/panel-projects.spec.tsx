// @vitest-environment jsdom
// 项目页签、项目详情与代码仓库 / 项目设置分区。
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, field, find, mount, settle, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

const project = {
  name: '内容运营', enabled: true,
  codeRepo: { kind: 'github' as const, config: { repository: 'acme/widgets' } },
  taskSource: { kind: 'excel', config: {} },
  gitCredential: '', feishuCredential: '',
  execution: { directory: '', branch: '' },
  schedule: { intervalMinutes: 30, runOnStart: true },
  retry: { maxRetries: 2, retryBackoffSeconds: 60 },
  taskPolicy: { pendingStatuses: ['待处理', 'todo'], doneStatus: '已完成', failedStatus: '失败' },
}

function queued(state: 'queued' | 'running', extra: Record<string, unknown> = {}) {
  return { id: `q-${state}`, project: 'content', projectName: '内容运营', task: 'T-1', item: 0, title: '写周报', state,
    attempt: state === 'queued' ? 1 : 0, dueAt: Date.now() + 60_000, enqueuedAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z', ...extra }
}

it('lists projects with queue and runtime counts, then opens the project Tasks and queue', async () => {
  server.settings = { ...server.settings, projects: { content: project } }
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
  server.settings = { ...server.settings, projects: { content: project } }
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

it('leads the task source step with its type and hides fields the type does not need', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(find(`${zh['settingsGroup.projects']}${zh['settingsGroupTag']}`, '.dt-settings-link'))
  await type(field(zh.sourceName), '内容运营')
  await click(zh.projectNext)
  // 仓库步必须先验证连通并选定分支，才允许进入任务来源步。
  await type(field('仓库地址'), 'https://github.com/acme/content.git')
  await click(document.querySelector(`[aria-label="${zh.verify} · 仓库地址"]`) as HTMLElement)
  await settle()
  expect(field<HTMLSelectElement>(zh.projectBranch).value).toBe('main')
  await click(zh.projectNext)
  const wizard = document.querySelector(`[aria-label="${zh.projectWizardTitle}"]`)!
  // 来源类型是任务来源步骤的第一个下拉，默认 Excel；Excel 不显示飞书凭据。
  expect(wizard.querySelector('.dt-form select.dt-select')).toBe(field(zh.projectSourceKind, wizard))
  expect(field<HTMLSelectElement>(zh.projectSourceKind, wizard).value).toBe('excel')
  expect(() => field(zh.projectFeishuCredentialLabel, wizard)).toThrow()
  await type(field<HTMLSelectElement>(zh.projectSourceKind, wizard), 'feishu-wiki')
  expect(field<HTMLSelectElement>(zh.projectFeishuCredentialLabel, wizard).value).toBe('')
})

it('creates a project through the four-step wizard and saves the full configuration', async () => {
  await mount()
  await click(zh['tab.projects'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(find(`${zh['settingsGroup.projects']}${zh['settingsGroupTag']}`, '.dt-settings-link'))
  expect(text()).toContain(zh.projectWizardTitle)
  await type(field(zh.sourceName), '内容运营')
  await click(zh.projectNext)
  // 仓库步：填地址、验证连通，分支由向导按远端默认分支自动选中。
  await type(field('仓库地址'), 'https://github.com/acme/content.git')
  await click(document.querySelector(`[aria-label="${zh.verify} · 仓库地址"]`) as HTMLElement)
  await settle()
  expect(field<HTMLSelectElement>(zh.projectBranch).value).toBe('main')
  await click(zh.projectNext)
  // 任务来源步：验证清单文件真实可读后才允许继续。
  await click(document.querySelector(`[aria-label="${zh.verify} · 任务清单文件"]`) as HTMLElement)
  await settle()
  await click(zh.projectNext)
  await type(field(zh.projectDirectory), '/srv/work/content')
  await type(field(zh.projectInterval), '5')
  await type(field(zh.projectMaxRetries), '4')
  await type(field(zh.projectBackoff), '30')
  await type(field(zh.projectPendingStatuses), 'todo, pending')
  await click(zh.projectCreate)
  await settle()
  expect(server.settings.projects.project).toMatchObject({
    name: '内容运营', codeRepo: { kind: 'github', config: { remote: 'https://github.com/acme/content.git', auth: 'https' } },
    taskSource: { kind: 'excel', config: {} }, gitCredential: '', feishuCredential: '',
    execution: { directory: '/srv/work/content', branch: 'main' },
    schedule: { intervalMinutes: 5, runOnStart: true },
    retry: { maxRetries: 4, retryBackoffSeconds: 30 },
    taskPolicy: { pendingStatuses: ['todo', 'pending'], doneStatus: '已完成', failedStatus: '失败' },
  })
  const [editButton] = all('.dt-card button').filter(button => button.textContent?.trim() === zh.edit)
  await click(editButton!)
  await type(field(zh.projectInterval), '7')
  await type(field(zh.projectMaxRetries), '6')
  await click(zh.save)
  expect(server.settings.projects.project?.schedule.intervalMinutes).toBe(7)
  expect(server.settings.projects.project?.retry.maxRetries).toBe(6)
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/project:project'])
})

it('edits the code repository embedded in the project', async () => {
  server.settings = { ...server.settings, projects: { content: project } }
  await mount()
  await click(zh['tab.settings'])
  await click(find(`${zh['settingsGroup.projects']}${zh['settingsGroupTag']}`, '.dt-settings-link'))
  await click(zh.edit)
  await type(field('仓库地址'), 'https://github.com/acme/next.git')
  await click(zh.save)
  expect(server.settings.projects.content?.codeRepo).toEqual({ kind: 'github', config: { remote: 'https://github.com/acme/next.git', auth: 'https' } })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/project:content'])
})

it('locks the repository kind and records the auth mode when a Git credential is bound', async () => {
  server.gitCredentials = [{ id: 'cred', name: '机器人凭据', kind: 'https', provider: 'github', username: 'agent-bot', note: '',
    origin: 'pasted' as const, keyPath: '', revision: 1, updatedAt: '', lastVerifiedAt: '', configured: true, fingerprint: 'fp', hint: '••••oken' }]
  await mount()
  await click(zh['tab.projects'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(find(`${zh['settingsGroup.projects']}${zh['settingsGroupTag']}`, '.dt-settings-link'))
  await type(field(zh.sourceName), '内容运营')
  await click(zh.projectNext)
  await type(field<HTMLSelectElement>(zh.projectGitCredentialLabel), 'cred')
  // 仓库类型随凭据锁定为 GitHub；cli 与 SSH key 等低级栏位不再出现，只剩仓库地址。
  const wizard = document.querySelector(`[aria-label="${zh.projectWizardTitle}"]`)!
  const kindSelect = field<HTMLSelectElement>(zh.projectRepoKind, wizard)
  expect(kindSelect.disabled).toBe(true)
  expect(kindSelect.value).toBe('github')
  expect(() => field('智能体的 GitHub CLI', wizard)).toThrow()
  expect(field(zh.projectRepoUrl, wizard)).toBeTruthy()
})

it('picks the Feishu chat from the bot chat list in the task source step', async () => {
  await mount()
  await click(zh['tab.projects'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(find(`${zh['settingsGroup.projects']}${zh['settingsGroupTag']}`, '.dt-settings-link'))
  await type(field(zh.sourceName), '内容运营')
  await click(zh.projectNext)
  await type(field('仓库地址'), 'https://github.com/acme/content.git')
  await click(document.querySelector(`[aria-label="${zh.verify} · 仓库地址"]`) as HTMLElement)
  await settle()
  await click(zh.projectNext)
  await type(field<HTMLSelectElement>(zh.projectSourceKind), 'feishu-im')
  // 群选择：点击「获取群列表」后出现群下拉，选中即写入 chatId；验证通过后才允许继续。
  await click(find(zh.projectImChatFetch))
  await settle()
  await type(field<HTMLSelectElement>(zh.projectImChat), 'oc_test123')
  await click(document.querySelector(`[aria-label="${zh.verify} · ${zh.projectImChat}"]`) as HTMLElement)
  await settle()
  await click(zh.projectNext)
  expect(server.requests.some(request => request.path === 'feishu-im/chats')).toBe(true)
})
