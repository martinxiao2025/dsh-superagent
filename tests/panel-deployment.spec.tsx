// @vitest-environment jsdom
// 部署设置与插件管理页。
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PluginConfig } from '../src/client/deployment.tsx'
import { PanelProvider, usePanel as usePanelContext, usePanelData } from '../src/client/provider.tsx'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at, translator } from './fixtures/panel.tsx'
import { server, problemOf, fakeForm } from './fixtures/panel-server.ts'

usePanel()
it('saves this machine\'s settings in the Deployment settings through DSH\'s configuration form, without a restart', async () => {
  const { form: editable, mutations } = fakeForm()
  server.form = editable
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain('/srv/dsh-superagent')
  // 账号在来源设置里；插件管理页拿不到那些设置，因此在这里显示。
  expect(text()).not.toContain('@agent-bot')
  for (const moved of ['仓库克隆', '工单 worktree 目录', '禁用的命令']) expect(text()).not.toContain(moved)
  expect(text()).toContain(zh.deploymentIntro)
  // 限制立即生效，因此仅修改它时草稿只表示尚未保存，即使派工正在运行。
  await type(field<HTMLInputElement>(zh.deploymentContextTimeout), '20000')
  expect(document.querySelector('.dt-savebar')?.textContent).toBe(`${zh.draftKept}${zh.discard}${zh.save}`)
  await click(zh.save)
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 20000 }] }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.saved)
  expect(text()).not.toContain(zh.savedRestarting)
  expect(field<HTMLInputElement>(zh.deploymentContextTimeout).value).toBe('20000')
})

it('resets the state directory from the Deployment page only after explicit confirmation, and reports the backup', async () => {
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.deploymentResetAction)
  expect(text()).toContain(zh.deploymentResetConfirm)
  await click(zh.confirm)
  const request = server.requests.find(item => item.path === 'admin/reset')
  expect(request?.body).toEqual({ confirm: 'RESET' })
  expect(document.querySelector('.dt-toast')?.textContent)
    .toBe(zh.deploymentResetDone.replace('{backup}', '/backup/2026-11-11T00-00-00-000Z'))
})

it('keeps a refused Deployment change as a draft, and shows the settings read-only without a writable form', async () => {
  const refusing = fakeForm(true, false)
  server.form = refusing.form
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentPromptMaxChars), '200000')
  await click(zh.save)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.deploymentRefused)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
  server.form = fakeForm(false).form
  await remount()
  expect(text()).toContain(zh.deploymentReadOnly)
  server.form = undefined
  await remount()
  expect(text()).toContain('这个 DSH 版本不提供配置表单')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars)).toMatchObject({ disabled: true, value: '100000' })
  expect(all('button').some(button => button.textContent === '保存')).toBe(false)
})

it('merges a Deployment draft into the values another page saved meanwhile, and writes only what it changed', async () => {
  const { form: shared, mutations } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentContextPages), '20')
  // 与此同时，插件管理页保存同一条目的另一个字段。
  await act(async () => { await shared.mutate([{ op: 'set', path: ['promptMaxChars'], value: 50000 }], 1) })
  expect(text()).toContain('设置已在别处修改，你的修改已合并到最新版本')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('50000')
  await click(zh.save)
  expect(mutations.at(-1)).toEqual({ revision: 2, ops: [{ op: 'set', path: ['admissionContextMaxPages'], value: 20 }] })
  expect(shared.getSnapshot().value).toMatchObject({ admissionContextMaxPages: 20, promptMaxChars: 50000 })
})

it('renders the Deployment page with the derived accounts in the Plugin Manager, and no summary', async () => {
  let container = document.createElement('div')
  let root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  // 每次渲染都从头挂载，以匹配插件管理页的导航方式。
  const render = async (view: 'page' | 'summary') => {
    act(() => { root.unmount() }); container.remove()
    container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    const form = server.form
    await act(async () => { root.render(<PluginConfig t={translator(zh)} view={view} form={form && { state: form.getSnapshot(),
      mutate: form.mutate }} />) })
    await settle()
  }
  await render('summary')
  expect(container.textContent).toBe('')
  server.form = fakeForm().form
  await render('page')
  for (const fact of ['acme/widgets', '@agent-bot', 'Widgets Bot', '账号在 dsh-superagent 面板的来源设置里修改。']) expect(text()).toContain(fact)
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await render('page')
  expect(text()).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(false)
  server.down = true
  await render('page')
  expect(text()).toContain(zh.hostNotRunning)
})

it('tells a dsh-superagent that is starting from a browser that cannot write on the Deployment page', async () => {
  const { form: shared, publish } = fakeForm()
  server.form = shared
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  const limit = () => field<HTMLInputElement>(zh.deploymentPromptMaxChars)
  expect(limit().disabled).toBe(false)
  // dsh-superagent 重启期间，DSH 停止提供其配置条目；一旦重新提供，值又变为可编辑。
  await act(async () => { publish({ status: 'unavailable' }) })
  expect(text()).toContain(zh.deploymentUnavailable)
  expect(limit().disabled).toBe(true)
  await act(async () => { publish({ status: 'ready' }) })
  expect(limit().disabled).toBe(false)
  await act(async () => { publish({ mode: 'memory', status: 'unavailable', writable: false }) })
  expect(text()).toContain(zh.deploymentReadOnly)
})

it('reads the state every second after a setup check, until dsh-superagent stopped answering and answers again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const second = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle() }
  server.down = true
  await second()
  expect(text()).toContain(zh['setup.agentCliUnset'])
  server.down = false
  server.setup = { ...server.setup, problem: null }
  await second()
  expect(text()).not.toContain(zh['setup.agentCliUnset'])
  // 一旦有响应，状态又每五秒读取一次。
  const reads = server.requests.filter(request => request.path === 'state').length
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) }); await settle()
  expect(server.requests.filter(request => request.path === 'state')).toHaveLength(reads)
})

it('ends a restart that never stopped answering after half a minute, and reads the state every five seconds again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const reads = () => server.requests.filter(request => request.path === 'state').length
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
  const before = reads()
  await advance(10_000)
  expect(reads() - before).toBeGreaterThanOrEqual(8)
  // 重启在 30 秒时结束；随即读取一次状态，之后每五秒读取一次。
  await advance(21_000)
  const ended = reads()
  await advance(3_000)
  expect(reads()).toBe(ended)
  await advance(2_000)
  expect(reads()).toBe(ended + 1)
})

/** 重启检测状态机的最小消费者：把 `PanelData.restarts` 渲染到 DOM，供断言读取；按钮触发 `restart()`。 */
function RestartProbe() {
  const { restarts } = usePanelData()
  const { restart } = usePanelContext()
  return <button type="button" data-restarts={restarts} onClick={() => restart()}>restart</button>
}
/** 直接挂载一个 Provider（不经过整页 App），聚焦状态机本身。 */
async function mountProbe(): Promise<{ counter: () => number; trigger: () => Promise<void>; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<PanelProvider t={translator(zh)}><RestartProbe /></PanelProvider>) })
  await settle()
  return {
    counter: () => Number(container.querySelector('button')!.dataset.restarts),
    trigger: () => click(container.querySelector('button')!),
    unmount: async () => { await act(async () => { root.unmount() }); container.remove() },
  }
}

it('counts a restart only after it saw the host go down and answer again, and polls every second while waiting', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  const probe = await mountProbe()
  try {
    const reads = () => server.requests.filter(request => request.path === 'state').length
    const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
    expect(probe.counter()).toBe(0)
    await probe.trigger()
    // 等待下线期间每秒读取一次状态。
    const waiting = reads()
    await advance(3_100)
    expect(reads() - waiting).toBeGreaterThanOrEqual(3)
    // 下线这一步本身不计入重启次数（伪服务器在下线期间不记录请求，此阶段的节拍由「恢复应答后立即计数」间接保证）。
    server.down = true
    await advance(1_000)
    expect(probe.counter()).toBe(0)
    // 恢复应答即计数一次，依赖视图据此重新读取数据。
    server.down = false
    await advance(1_000)
    expect(probe.counter()).toBe(1)
    // 第二次完整的下线-恢复循环再次递增。
    await probe.trigger()
    server.down = true
    await advance(1_000)
    server.down = false
    await advance(1_000)
    expect(probe.counter()).toBe(2)
  } finally { await probe.unmount() }
})

it('does not count a restart that never stopped answering, and returns to the slow cadence after half a minute', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  const probe = await mountProbe()
  try {
    const reads = () => server.requests.filter(request => request.path === 'state').length
    const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
    await probe.trigger()
    expect(probe.counter()).toBe(0)
    // 一直有应答：每秒一次地等到 30 秒超时，计数保持为 0。
    const waiting = reads()
    await advance(10_000)
    expect(reads() - waiting).toBeGreaterThanOrEqual(8)
    expect(probe.counter()).toBe(0)
    await advance(21_000)
    const ended = reads()
    await advance(3_000)
    expect(reads()).toBe(ended)
    await advance(2_000)
    expect(reads()).toBe(ended + 1)
    expect(probe.counter()).toBe(0)
  } finally { await probe.unmount() }
})
