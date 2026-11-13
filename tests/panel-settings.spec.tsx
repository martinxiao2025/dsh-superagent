// @vitest-environment jsdom
// 设置分组、草稿、保存栏与历史。
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Fields } from '../src/client/settings-kit.tsx'
import { expect, it, onTestFinished } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('keeps a person\'s own value where another save changed the same setting, and says so', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  server.settings = { ...server.settings, executor: { ...server.settings.executor, maxWorkers: 4 } }
  server.revisions.executor = 1
  await click(zh.save)
  expect(document.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe(zh.saveConflict)
  expect(field<HTMLInputElement>(zh.maxWorkers).value).toBe('6')
  await click(zh.save)
  expect(server.settings.executor.maxWorkers).toBe(6)
})

it('saves the Eval block on the Policy settings and the Executor with its execution environment on the Execution settings, each against its own revision', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(zh['mode.auto'])
  await type(field<HTMLInputElement>(zh.evalTimeout), '180')
  const [provider, model] = all('.dt-model input')
  await type(provider as HTMLInputElement, 'worker-provider'); await type(model as HTMLInputElement, 'worker-model')
  await click(zh.save)
  expect(server.settings.eval).toEqual({ mode: 'auto', timeoutSeconds: 180, model: { provider: 'worker-provider', model: 'worker-model' } })
  await click(find(`${zh['promptPart.runtime/work']}${zh['settingsGroupTag']}`, '.dt-settings-link'))
  await type(field<HTMLInputElement>(zh.maxWorkers), '5')
  // 空的根目录使用默认目录，字段会说明它，而不是看起来已设置。
  expect(field<HTMLInputElement>(zh.executionDirectory).closest('.dt-field')!.querySelector('small')?.textContent).toBe('留空时用 /srv/dsh-superagent/work')
  await type(field<HTMLInputElement>(zh.executionDirectory), '/srv/work')
  // 从列表中选择的变量会插入到 prepare 命令中光标所在的位置。
  const prepare = field<HTMLTextAreaElement>(zh.prepareCommand)
  await type(prepare, 'git worktree add ')
  prepare.setSelectionRange(17, 17)
  await click('可用的环境变量 3')
  expect(all('.dt-table tbody tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR工单的执行目录执行器', 'DSH_SUPERAGENT_NAME工单短名执行器',
    'DSH_SUPERAGENT_GITHUB_REPOSITORY仓库github · 已关闭'])
  await click('DSH_SUPERAGENT_DIR')
  expect(field<HTMLTextAreaElement>(zh.prepareCommand).value).toBe('git worktree add "$DSH_SUPERAGENT_DIR"')
  await type(field<HTMLInputElement>(zh.blockedCommands), 'gh-personal  gh.other')
  const [workerProvider, workerModel, effort] = all('.dt-model input')
  await type(workerProvider as HTMLInputElement, 'worker-provider'); await type(workerModel as HTMLInputElement,
    'worker-model'); await type(effort as HTMLInputElement, 'high')
  expect([...document.querySelectorAll('#dt-worker-model-efforts option')].map(option => option.getAttribute('value'))).toEqual(['high'])
  await click(zh.save)
  expect(server.settings.executor).toEqual({ maxWorkers: 5, directory: '/srv/work',
    prepare: 'git worktree add "$DSH_SUPERAGENT_DIR"', blockedCommands: ['gh-personal', 'gh.other'], model: { provider: 'worker-provider',
      model: 'worker-model', reasoningEffort: 'high' } })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/eval',
    'settings/executor'])
})

it('loads configuration history on demand with localized changes, Source field labels and notified Tickets', async () => {
  server.history = { current: 3, policyVersion: 'abcdef1234567890', items: [{ revision: 3, savedAt: '2026-09-22T00:00:00Z',
    source: 'sync', policyVersion: 'abcdef1234567890', policyChanged: true, notified: [{ id: 't1', title: '修复回归' }], block: 'policy',
    changes: [{ code: 'mode', from: 'off', to: 'observe' }, { code: 'sourceRowsAdded', source: 'feishu', field: 'allowed', items: ['Bob'],
      part: true }, { code: 'sourceField', source: 'feishu', field: 'syncChat', from: '', to: 'oc_team', part: true }] }] }
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(server.requests.some(request => request.path === 'policy/history')).toBe(false)
  await click(zh.configHistory)
  for (const expected of ['第 3 次保存 · 从群同步', '生成策略版本 abcdef12', '接单模式：关闭 → 仅观察', '飞书 · 能发起工作的飞书用户 新增：Bob', '飞书 · 同步来源群：未设置 → oc_team',
    '因策略变更通知了 1 个进行中的工单：修复回归']) expect(text()).toContain(expected)
})

it('shows save and discard only while a settings block has edits, at the end of that block', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  expect(all('.dt-savebar')).toHaveLength(1)
  await type(field<HTMLInputElement>(zh.maxWorkers), '3')
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  await click(zh.discard)
  expect(all('.dt-savebar')).toHaveLength(0)
  // 从字段提交的保存会保持焦点在那里；从保存栏提交的保存会在保存栏关闭时把焦点交给该块。
  const workers = field<HTMLInputElement>(zh.maxWorkers)
  await type(workers, '5')
  workers.focus()
  await act(async () => { workers.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.executor.maxWorkers).toBe(5)
  expect(document.activeElement).toBe(workers)
  await type(workers, '4')
  const save = find(zh.save)
  save.focus()
  await click(save)
  expect(all('.dt-savebar')).toHaveLength(0)
  expect(document.activeElement).toBe(workers.form)
  await click(find(zh['settingsGroup.feishuCredentials'], '.dt-settings-link'))
  await click(zh.feishuSettingsTabIngress)
  expect(all('.dt-savebar')).toHaveLength(0)
  const feishu = document.getElementById('dt-source-feishu')!
  const cli = field<HTMLInputElement>('机器人的 lark-cli', feishu)
  await type(cli, 'lark-other')
  expect(feishu.querySelector('.dt-savebar')).not.toBeNull()
  // 智能体 CLI 由设置读取，因此保存栏会警告：保存会重启 dsh-superagent 并中断正在运行的工作。
  expect(feishu.querySelector('.dt-savebar')!.textContent).toContain('2 个进行中的派工会中断')
})

it('gives the focus back to the field that had it once a block\'s save ends', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  const render = (disabled: boolean) => act(async () => { root.render(<Fields disabled={disabled}><input aria-label="value" /></Fields>) })
  await render(false)
  const input = container.querySelector('input')!
  input.focus()
  await render(true)
  // jsdom 不会在控件变为禁用时使其失焦；请手动移动焦点。
  const elsewhere = document.createElement('button'); document.body.append(elsewhere); elsewhere.focus(); elsewhere.remove()
  expect(document.activeElement).toBe(document.body)
  await render(false)
  expect(document.activeElement).toBe(input)
})

it('builds the task source kind dropdown from the driver catalog inside the project wizard', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(find(`${zh['settingsGroup.projects']}${zh['settingsGroupTag']}`, '.dt-settings-link'))
  await type(field(zh.projectName), '内容运营')
  await click(zh.projectNext)
  // 仓库步先验证连通并选定分支，才能进入任务来源步查看类型目录。
  await type(field('仓库地址'), 'https://github.com/acme/content.git')
  await click(document.querySelector(`[aria-label="${zh.verify} · 仓库地址"]`) as HTMLElement)
  await settle()
  await click(zh.projectNext)
  await settle()
  expect(all('.dt-add-grid select.dt-select option').map(option => option.textContent))
    .toEqual(expect.arrayContaining(['Excel 文件', '飞书消息', '飞书知识库']))
})

it('offers a Git credential for the project repository instead of auth fields', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(find(`${zh['settingsGroup.projects']}${zh['settingsGroupTag']}`, '.dt-settings-link'))
  // 仓库认证统一由项目选择的 Git 凭据决定，认证方式与 SSH key 字段不再出现。
  await type(field(zh.projectName), '内容运营')
  await click(zh.projectNext)
  expect(field<HTMLSelectElement>(zh.projectGitCredentialLabel).value).toBe('')
  expect(document.querySelector(`[aria-label="${zh.projectWizardTitle}"] .dt-field-segmented`)).toBeNull()
  await click(document.querySelector(`[aria-label="${zh.verify} · ${zh.projectGitCredentialLabel}"]`) as HTMLElement)
  await settle()
  expect(server.requests.filter(request => request.path === 'code-repos/verify').map(request => request.method)).toEqual(['POST'])
  // 预检只读取草稿，不创建项目，也不写入设置。
  expect(server.requests.filter(request => request.path === 'projects')).toEqual([])
  expect(server.settings.projects).toEqual({})
  await settle()
  expect(document.querySelector('.dt-check')).not.toBeNull()
  expect(server.requests.filter(request => request.path === 'code-repos/verify').map(request => request.method)).toEqual(['POST'])
})

it('creates, verifies and deletes a Git credential on its own settings page', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(find(zh['settingsGroup.gitCredentials'], '.dt-settings-link'))
  // 新增表单默认收起，由列表上方的按钮展开。
  expect(document.querySelector('.dt-source-add')).toBeNull()
  await click(find(zh.credentialNew, '.dt-add-trigger button'))
  await type(field<HTMLInputElement>(zh.credentialName), '部署机器人')
  await type(field<HTMLSelectElement>(zh.credentialKind), 'https')
  await type(field<HTMLInputElement>(zh.credentialToken), 'ghp_abcdefgh')
  await click(find(zh.credentialNew, '.dt-source-add button'))
  await settle()
  expect(server.gitCredentials.map(item => item.name)).toEqual(['部署机器人'])
  expect(document.querySelector('.dt-card .dt-card-title')?.textContent).toBe('部署机器人')
  expect(document.querySelector('.dt-card .dt-hint')?.textContent).toContain('••••abcd')
  // 列表默认不展开表单，点击编辑后才出现。
  expect(document.querySelector('.dt-card .dt-add-grid')).toBeNull()
  await click(find(zh.edit, '.dt-card button'))
  expect(document.querySelector('.dt-card .dt-add-grid')).not.toBeNull()
  await click(find(zh.cancel, '.dt-card button'))
  expect(document.querySelector('.dt-card .dt-add-grid')).toBeNull()
  await click(find(zh.verify, '.dt-card button'))
  const dialog = document.querySelector('.dt-modal')!
  await type(field<HTMLInputElement>(zh.credentialRepository, dialog), 'git@github.com:acme/widgets.git')
  await click(find(zh.verify, '.dt-modal button'))
  await settle()
  expect(all('.dt-card .dt-check').map(check => check.textContent)).toEqual(['材料可读：••••abcd', '远端可访问：3 个分支'])
  expect(server.requests.find(request => request.path === 'git-credentials/verify')?.body)
    .toMatchObject({ id: 'credential', repository: 'git@github.com:acme/widgets.git' })
  expect(document.querySelector('.dt-modal .dt-verify-summary')?.textContent).toBe('验证通过：2 项检查')
  await click(find(zh.cancel, '.dt-modal button'))
  // 再次打开验证弹窗时不带上一次的结果与地址。
  await click(find(zh.verify, '.dt-card button'))
  expect(document.querySelector('.dt-modal .dt-check')).toBeNull()
  expect(document.querySelector('.dt-modal .dt-verify-summary')).toBeNull()
  expect(field<HTMLInputElement>(zh.credentialRepository, document.querySelector('.dt-modal')!).value).toBe('')
  await click(find(zh.cancel, '.dt-modal button'))
  await click(find(zh.credentialDelete, '.dt-card button'))
  await click(find(zh.confirm, '.dt-modal button'))
  await settle()
  expect(server.gitCredentials).toEqual([])
  expect(text()).toContain(zh.gitCredentialNone)
})

it('fills a Git credential from an uploaded file and switches the kind by its content', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(find(zh['settingsGroup.gitCredentials'], '.dt-settings-link'))
  await click(find(zh.credentialNew, '.dt-add-trigger button'))
  // 上传入口随认证方式切换，每次取当前可见的文件选择框。
  const pick = async (name: string, body: string) => {
    const input = document.querySelector<HTMLInputElement>('.dt-source-add input[type="file"]')!
    const file = new File([body], name, { type: 'text/plain' })
    Object.defineProperty(file, 'text', { value: async () => body })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()
  }
  await pick('deploy.key', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n')
  expect(field<HTMLInputElement>(zh.credentialName).value).toBe('deploy')
  expect(field<HTMLTextAreaElement>(zh.credentialPrivateKey).value).toContain('BEGIN OPENSSH PRIVATE KEY')
  await pick('ci-token.txt', 'ghp_abcdefgh\n')
  expect(field<HTMLSelectElement>(zh.credentialKind).value).toBe('https')
  expect(field<HTMLInputElement>(zh.credentialToken).value).toBe('ghp_abcdefgh')
  // 已填写的名称不会被后续上传覆盖，材料齐备后可以直接保存。
  expect(field<HTMLInputElement>(zh.credentialName).value).toBe('deploy')
  expect(find(zh.credentialNew, '.dt-source-add button').hasAttribute('disabled')).toBe(false)
})

it('keeps Feishu credentials on their own page with a CLI identity', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(find(zh['settingsGroup.feishuCredentials'], '.dt-settings-link'))
  // 与 Git 凭据一致：新增区块默认收起。
  expect(document.querySelector('.dt-source-add')).toBeNull()
  await click(find(zh.credentialNew, '.dt-add-trigger button'))
  await type(field<HTMLInputElement>(zh.credentialName), '知识库机器人')
  await type(field<HTMLSelectElement>(zh.feishuMode), 'cli')
  await type(field<HTMLInputElement>(zh.feishuCli), 'lark')
  await click(find(zh.credentialNew, '.dt-source-add button'))
  await settle()
  expect(server.feishuCredentials.map(item => item.mode)).toEqual(['cli'])
  // 列表默认不展开表单，验证在弹窗中执行。
  expect(document.querySelector('.dt-card .dt-add-grid')).toBeNull()
  await click(find(zh.verify, '.dt-card button'))
  await click(find(zh.verify, '.dt-modal button'))
  await settle()
  expect(document.querySelector('.dt-card .dt-check')?.textContent).toBe('CLI 可执行：lark')
  expect(server.requests.filter(request => request.path.startsWith('feishu-')).length).toBeGreaterThan(0)
  expect(document.querySelector('.dt-modal .dt-verify-summary')?.textContent).toBe('验证通过：1 项检查')
  await click(find(zh.cancel, '.dt-modal button'))
  // 再次打开不带上次结果。
  await click(find(zh.verify, '.dt-card button'))
  expect(document.querySelector('.dt-modal .dt-check')).toBeNull()
  await click(find(zh.cancel, '.dt-modal button'))
  await click(find(zh.edit, '.dt-card button'))
  expect(document.querySelector('.dt-card .dt-add-grid')).not.toBeNull()
})

it('saves an edited Git credential without resubmitting its stored material', async () => {
  server.gitCredentials = [{ id: 'cred', name: '机器人凭据', kind: 'https', provider: 'github', username: 'agent-bot', note: '',
    origin: 'pasted' as const, keyPath: '', revision: 1, updatedAt: '', lastVerifiedAt: '', configured: true, fingerprint: 'fp', hint: '••••oken' }]
  await mount()
  await click(zh['tab.settings'])
  await click(find(zh['settingsGroup.gitCredentials'], '.dt-settings-link'))
  await click(find(zh.edit, '.dt-card button'))
  // 材料在保险库中：编辑表单不回填令牌，保存时也不把空字段提交成空字符串覆盖旧材料。
  expect(field<HTMLInputElement>(zh.credentialToken).value).toBe('')
  await type(field<HTMLTextAreaElement>(zh.credentialNote), '轮换前的机器人令牌')
  await click(find(zh.save, '.dt-card button'))
  await settle()
  const saved = server.requests.find(request => request.method === 'PUT' && request.path === 'git-credentials/cred')
  expect(saved?.body).toEqual({ value: { name: '机器人凭据', kind: 'https', provider: 'github', username: 'agent-bot',
    note: '轮换前的机器人令牌' }, revision: 1 })
  expect(JSON.stringify(saved?.body)).not.toContain('token')
  expect(server.gitCredentials[0]).toMatchObject({ revision: 2, note: '轮换前的机器人令牌' })
  expect(document.querySelector('.dt-toast')?.textContent).toBe('已保存凭据：机器人凭据（版本 2）')
})

it('refuses to delete a Git credential a project still references, with the count in the refusal', async () => {
  server.gitCredentials = [{ id: 'cred', name: '机器人凭据', kind: 'https', provider: 'github', username: 'agent-bot', note: '',
    origin: 'pasted' as const, keyPath: '', revision: 1, updatedAt: '', lastVerifiedAt: '', configured: true, fingerprint: 'fp', hint: '••••oken' }]
  server.settings = { ...server.settings, projects: { content: { name: '内容运营', enabled: true,
    codeRepo: { kind: 'github' as const, config: { repository: 'acme/widgets' } }, taskSource: { kind: 'excel', config: {} },
    gitCredential: 'cred', feishuCredential: '', execution: { directory: '', branch: '' },
    schedule: { intervalMinutes: 30, runOnStart: true }, retry: { maxRetries: 2, retryBackoffSeconds: 60 },
    taskPolicy: { pendingStatuses: ['待处理'], doneStatus: '已完成', failedStatus: '失败' } } } }
  await mount()
  await click(zh['tab.settings'])
  await click(find(zh['settingsGroup.gitCredentials'], '.dt-settings-link'))
  await click(find(zh.credentialDelete, '.dt-card button'))
  await click(find(zh.confirm, '.dt-modal button'))
  await settle()
  // 记录仍在：引用计数拒绝删除，确认弹窗保持打开，并按插值提示引用数量。
  expect(server.gitCredentials.map(item => item.id)).toEqual(['cred'])
  expect(document.querySelector('.dt-toast')?.textContent).toBe('Git 凭据 cred 仍被 1 个项目引用。')
  expect(find(zh.confirm, '.dt-modal button')).toBeTruthy()
})

it('gates the Git add form on a name and usable material before enabling save and verify', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(find(zh['settingsGroup.gitCredentials'], '.dt-settings-link'))
  await click(find(zh.credentialNew, '.dt-add-trigger button'))
  const gated = () => all('.dt-source-add .dt-row-buttons button')
    .filter(button => button.textContent === zh.verify || button.textContent === zh.credentialNew)
  // 没有名称与材料时，验证与新增都不可用。
  expect(gated().every(button => button.hasAttribute('disabled'))).toBe(true)
  await type(field<HTMLInputElement>(zh.credentialName), '部署机器人')
  // 只有名称仍不够：材料决定能否验证。
  expect(gated().find(button => button.textContent === zh.credentialNew)!.hasAttribute('disabled')).toBe(true)
  await type(field<HTMLSelectElement>(zh.credentialKind), 'https')
  await type(field<HTMLInputElement>(zh.credentialToken), 'ghp_abcdefgh')
  expect(gated().every(button => !button.hasAttribute('disabled'))).toBe(true)
})

it('saves an edited Feishu credential and verifies the app identity with a wiki space', async () => {
  server.feishuCredentials = [{ id: 'bot', name: '知识库机器人', mode: 'app', appId: 'cli_bot', cli: '', note: '',
    revision: 2, updatedAt: '', lastVerifiedAt: '', configured: true, fingerprint: 'fp', hint: '••••wxyz' }]
  await mount()
  await click(zh['tab.settings'])
  await click(find(zh['settingsGroup.feishuCredentials'], '.dt-settings-link'))
  // 应用身份验证：可选填写知识库 ID，验证弹窗按记录 ID 与 spaceId 一并检查。
  await click(find(zh.verify, '.dt-card button'))
  const dialog = document.querySelector('.dt-modal')!
  await type(field<HTMLInputElement>(zh.feishuSpaceId, dialog), '6946842750923456789')
  await click(find(zh.verify, '.dt-modal button'))
  await settle()
  expect(all('.dt-card .dt-check').map(check => check.textContent))
    .toEqual(['应用凭据可用：cli_bot（••••wxyz）', '知识库可读取：6946842750923456789'])
  expect(server.requests.find(request => request.path === 'feishu-credentials/verify')?.body)
    .toMatchObject({ id: 'bot', spaceId: '6946842750923456789' })
  expect(document.querySelector('.dt-modal .dt-verify-summary')?.textContent).toBe('验证通过：2 项检查')
  await click(find(zh.cancel, '.dt-modal button'))
  // 编辑保存：密钥不回填也不重发，只有变更过的备注随身份字段一起提交。
  await click(find(zh.edit, '.dt-card button'))
  expect(field<HTMLInputElement>(zh.feishuAppSecret).value).toBe('')
  await type(field<HTMLTextAreaElement>(zh.credentialNote), '知识库巡检机器人')
  await click(find(zh.save, '.dt-card button'))
  await settle()
  const saved = server.requests.find(request => request.method === 'PUT' && request.path === 'feishu-credentials/bot')
  expect(saved?.body).toEqual({ value: { name: '知识库机器人', mode: 'app', appId: 'cli_bot', note: '知识库巡检机器人' }, revision: 2 })
  expect(JSON.stringify(saved?.body)).not.toContain('appSecret')
  expect(server.feishuCredentials[0]).toMatchObject({ revision: 3 })
})

it('lists the settings groups stages first, opens each stage\'s group from its status, and returns to the last group opened',
  async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  const tag = zh['settingsGroupTag']
  expect(all('.dt-settings-link').map(link => link.textContent)).toEqual(['Git 凭据', '飞书凭据',
    `项目${tag}`, `评估${tag}`, `执行${tag}`, '提示词', '部署'])
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(`项目${tag}`)
  for (const [tab, group] of [['项目', `项目${tag}`], ['评估', `评估${tag}`],
    ['执行', `执行${tag}`]] as [string, string][]) {
    await click(find(tab, '[role="tab"]'))
    await click(find(zh['tab.settings'], '.dt-status-head button'))
    expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(group)
  }
  // 触发器阶段没有设置，因此其状态不提供设置。
  await click(tab(zh['tab.trigger']))
  expect(all('.dt-status-head button').map(button => button.textContent)).not.toContain(zh['tab.settings'])
  await click(tab(zh['tab.settings']))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent)
    .toBe(`${zh['promptPart.runtime/work']}${zh['settingsGroupTag']}`)
  await click(tab(zh['tab.trigger']))
  await remount()
  await click(tab(zh['tab.settings']))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent)
    .toBe(`${zh['promptPart.runtime/work']}${zh['settingsGroupTag']}`)
})
