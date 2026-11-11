// @vitest-environment jsdom
// 来源状态与设置。
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, problemOf, droppedReply } from './fixtures/panel-server.ts'

usePanel()
it('shows each Source\'s state on the Source status and opens its settings from a setup problem', async () => {
  await mount()
  await click(zh['tab.source'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(all('.dt-form > .dt-list > .dt-row .dt-row-name').map(title => title.textContent)).toEqual(['飞书'])
  expect(all('.dt-form > .dt-list > .dt-row')[0]!.querySelector('.dt-row-meta')?.textContent).toBe('24 小时到达 12被过滤 2最近 ' + document.querySelector('.dt-row-meta time, .dt-row-meta .dt-lv:last-child .dt-lv-value')?.textContent)
  expect(text()).toContain(zh['sourceState.error'])
  expect(text()).toContain('socket closed')
  expect(all('.dt-card')).toHaveLength(0)
  server.setup = { ...server.setup, problem: problemOf('feishuCliUnset') }
  await remount()
  await click(zh['tab.source'])
  await click(zh.sourceOpenSettings)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
  expect(all('.dt-card')[0]!.textContent).toContain(zh['setup.feishuCliUnset'])
})

it('folds more than six chats into a line of their names', async () => {
  const chats = Array.from({ length: 7 }, (_, n) => ({ chatId: n ? `oc_c${n}` : 'oc_team', listen: 'all' as const }))
  server.settings.sources.feishu = { ...server.settings.sources.feishu!, config: { ...server.settings.sources.feishu!.config, chats } }
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const summary = all('.dt-card')[0]!.querySelector('.dt-rows-summary')!
  expect(summary.textContent).toBe(['团队群', 'oc_c1', 'oc_c2', 'oc_c3', 'oc_c4', 'oc_c5', 'oc_c6'].join('、'))
})

it('rereads the chats the bot has joined on request and says which are new, keeping unsaved edits', async () => {
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const feishu = () => all('.dt-card')[0]!
  const button = () => [...feishu().querySelectorAll('button')].find(item => item.textContent === '刷新群列表')!
  await click([...feishu().querySelectorAll('button')].find(item => item.textContent === '添加')!)
  server.joining = { oc_new: '新群' }
  await click(button())
  expect(server.requests.find(request => request.path === 'sources/feishu/labels')).toMatchObject({ method: 'POST' })
  expect(document.querySelector('.dt-toast')?.textContent).toBe('列表已更新，新增：新群')
  // 正在新增的行会保留，并现在提供新群。
  const pick = feishu().querySelectorAll('.dt-rows-item')[1]!.querySelector<HTMLSelectElement>('select[aria-label="选择机器人已加入的群"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['选择机器人已加入的群', '另一个群', '新群'])
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.labelsCurrent)
  server.joinError = 'lark-cli: token expired'
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe('读取失败，列表保持不变：lark-cli: token expired')
  expect(button().disabled).toBe(false)
})

it('renders a Source\'s settings from its kind\'s fields and saves it against its own revision', async () => {
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const cards = all('.dt-card')
  expect(cards.map(card => card.querySelector('.dt-row-title')?.firstChild?.textContent)).toEqual(['飞书'])
  const feishu = cards[0]!
  expect(feishu.textContent).toContain('接收的群')
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === '添加')!)
  const rows = feishu.querySelectorAll('.dt-rows-item')
  // 已保存的群显示其名称；正在新增的行从尚未配置的已加入群中选择。
  expect(rows[0]!.querySelector('.dt-row-label')?.textContent).toBe('团队群')
  expect(rows[0]!.querySelector('select[aria-label="选择机器人已加入的群"]')).toBeNull()
  const pick = rows[1]!.querySelector<HTMLSelectElement>('select[aria-label="选择机器人已加入的群"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['选择机器人已加入的群', '另一个群'])
  await type(pick, 'oc_other')
  await type(rows[1]!.querySelector('select[aria-label="接收"]')!, 'all')
  await click('接收私聊')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.requests.find(request => request.path === 'settings/source:feishu')).toMatchObject({ method: 'PUT', body: { revision: 0,
    value: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_other', listen: 'all' }],
      directMessages: false } } } })
  expect(server.settings.sources.feishu!.config).toMatchObject({ directMessages: false })
  await click('运行来源：飞书')
  server.revisions['source:feishu'] = 5
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  // 另一次保存没有改动此草稿改动的任何内容，因此草稿移到较新的版本并在那里保存。
  expect(feishu.querySelector('.dt-savebar')?.textContent).toContain('设置已在别处修改，你的修改已合并到最新版本')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.feishu).toMatchObject({ enabled: false })
  expect(server.revisions['source:feishu']).toBe(6)
})

it('points a setup problem at the settings that fix it', async () => {
  server.setup = { ...server.setup, problem: problemOf('feishuCliUnset'), accounts: null }
  // jsdom 没有滚动；模拟 scrollIntoView 以记录链接将哪张卡片带入视野。
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  await mount()
  expect(text()).toContain(zh.problemSetupFeishu)
  expect(text()).toContain(zh['setup.feishuCliUnset'])
  // 设置等待期间不会运行任何内容，因此执行器会说明这一点，而不是计数。
  expect(text()).toContain(zh.executorWaitingSetup)
  expect(all('.dt-stat').map(stat => stat.textContent)).not.toContain('执行中2 / 3')
  expect(text()).toContain(zh['problemSetupFix.source'])
  await click(find(zh.problemSetupFeishu, 'button, a, [role="button"]'))
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
  expect(all('.dt-card')[0]!.textContent).toContain(zh['setup.feishuCliUnset'])
  expect(scroll.mock.contexts).toContain(all('.dt-card')[0])
  delete (Element.prototype as Partial<Element>).scrollIntoView
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain(zh['setup.feishuCliUnset'])
  // 在 dsh-superagent 外部修复后，检查会再次运行设置。
  await click(zh.setupCheck)
  expect(server.requests.filter(request => request.path === 'setup/check')).toEqual([{ path: 'setup/check', method: 'POST' }])
  expect(text()).toContain(zh.setupChecking)
  server.setup = { ...server.setup, problem: problemOf('gitTooOld') }
  await remount()
  await click(zh['tab.overview'])
  await click(find(zh.problemSetup, 'button, a, [role="button"]'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
  expect(text()).toContain('部署检查未通过：git 没有读取 dsh-superagent 为 github.com 写的凭据配置')
})

it('shows a failed Feishu bot check as a problem of the Feishu Source only, with a check after a fix outside dsh-superagent', async () => {
  server.setup = { ...server.setup, feishuProblem: problemOf('feishuBotNotReady', { app: 'cli_bot', status: 'missing' }),
    accounts: { ...server.setup.accounts!, feishu: null } }
  await mount()
  expect(text()).toContain(zh.problemSetupFeishu)
  expect(text()).not.toContain('飞书 来源异常')
  await click(find(zh.problemSetupFeishu, 'button, a, [role="button"]'))
  const feishu = all('.dt-card')[0]!
  expect(feishu.textContent).toContain('部署检查未通过：应用 cli_bot 的机器人身份状态是 missing；用 lark-cli 配置应用密钥。')
  // 与此同时 dsh-superagent 正在运行，因此再次检查会先询问：重启会中断正在运行执行器的会话。
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === '重新检查')!)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('重新检查会重启 dsh-superagent：2 个进行中的派工会中断')
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(false)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(true)
  await click(tab(zh['tab.source']))
  // 来源状态只承载一次问题，不会再次作为其健康状态出现。
  expect(all('.dt-form > .dt-list > .dt-row')[0]!.textContent?.match(/cli_bot 的机器人身份状态是 missing/g)).toHaveLength(1)
})

it('leaves Feishu out of a deployment without a Source', async () => {
  server.setup = { ...server.setup, accounts: { ...server.setup.accounts!, feishu: null } }
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { kind: 'feishu', name: '飞书', enabled: false, config: {} } } }
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewFull))
  expect([...field<HTMLSelectElement>(zh.promptPreviewTarget).options].map(option => option.textContent)).toEqual(['主 Session',
    '执行器 Session', 'dsh-superagent-github'])
})

it('shows the Source whose deployment check failed, with the problem that fixes it and its link', async () => {
  server.setup = { ...server.setup, feishuProblem: problemOf('feishuCliUnset'), accounts: null }
  await mount()
  await click(zh['tab.source'])
  const rows = all('.dt-form > .dt-list > .dt-row')
  expect(rows.map(row => row.querySelector('.dt-status-text')?.textContent)).toEqual(['出错'])
  expect(text()).not.toContain('Waiting for setup')
  expect(rows[0]!.textContent).toContain(zh['setup.feishuCliUnset'])
  await click(find(zh.sourceOpenSettings, '.dt-row button'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
})

it('shows a Source\'s health in the interface language, and a diagnostic as reported', async () => {
  server.health = { feishu: { state: 'error', detail: '3 consecutive failed polls; last: EOF', code: 'pollFailures', values: { count: '3',
    error: 'EOF' } } }
  await mount()
  await click(zh['tab.source'])
  const feishu = all('.dt-form > .dt-list > .dt-row').find(row => row.querySelector('.dt-row-name')?.textContent === '飞书')!
  expect(feishu.textContent).toContain('飞书来源：连续 3 次轮询失败，最近一次：EOF')
  expect(feishu.textContent).not.toContain('consecutive')
})

it('shows a refused Source save with the output of the tool that failed on its own line', async () => {
  await mount()
  await click(zh['tab.source'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const feishu = all('.dt-card')[0]!
  await type(field<HTMLInputElement>('机器人的 lark-cli', feishu), 'lark-broken')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(feishu.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe('机器人的 lark-cli 不可用。\nlark-cli: app secret missing')
})

it('shows a setup problem on its Source card within one read of the settings, which the settings groups share', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const card = () => document.getElementById('dt-source-feishu')!
  expect(card().textContent).not.toContain(zh['setup.feishuCliUnset'])
  server.setup = { ...server.setup, problem: problemOf('feishuCliUnset') }
  // 设置每五秒读取一次，与状态一样；来源设置不读取来源状态。
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings')).toHaveLength(2)
  expect(server.requests.some(request => request.path === 'sources')).toBe(false)
  expect(card().textContent).toContain(zh['setup.feishuCliUnset'])
})

it('lists the messages a Source did not send in the last day under it, newest first, with why and where they belong', async () => {
  // 包含一条超过 24 小时的丢弃记录（m0）和一条缺少线程的记录（m1）。
  server.dropped = [droppedReply('m3', 1, 'feishu', 'channelGone', { ticket: { id: 't1', title: '修复回归' } }),
    droppedReply('m2', 3, 'feishu', 'channelIgnored'), droppedReply('m1', 4, 'feishu', 'channelGone', { thread: false }),
    droppedReply('m0', 30, 'feishu', 'channelGone')]
  await mount()
  await click(zh['tab.source'])
  const feishu = all('.dt-form > .dt-list > .dt-row')[0]!
  const disclosure = (scope: Element) =>
    [...scope.querySelectorAll<HTMLElement>('[data-disclosure-row]')].find(row => row.textContent?.includes(zh.sourceDroppedTitle))!
  await click(disclosure(feishu))
  const rows = [...feishu.querySelectorAll('.dt-disclosure-body .dt-row')].map(row => [row.querySelector('.dt-row-title')?.textContent,
    row.querySelector('.dt-tag')?.textContent, row.querySelector('button')?.textContent])
  expect(rows).toEqual([['Reply m3', zh['reason.channelGone'], '修复回归'],
    ['Reply m2', zh['reason.channelIgnored'], zh['term.thread']], ['Reply m1', zh['reason.channelGone'], undefined]])
  expect(feishu.textContent).toContain(`${zh.sourceDroppedTitle} 3`)
  await click(find('修复回归', '.dt-disclosure-body button'))
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  await remount()
  await click(zh['tab.source'])
  await click(disclosure(document.body))
  // 飞书渠道标明其群聊；链接会打开它回复的消息所在线程，宿主已找到该线程。
  await click(find(zh['term.thread'], '.dt-disclosure-body button'))
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(text()).not.toContain(zh.threadNotFound)
})

it('takes no space for messages that were all sent', async () => {
  await mount()
  await click(zh['tab.source'])
  expect(text()).not.toContain(zh.sourceDroppedTitle)
})

it('reads the settings again as soon as dsh-superagent answers after a save restarted it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const feishu = document.getElementById('dt-source-feishu')!
  await type(field<HTMLInputElement>('机器人的 lark-cli', feishu), '/opt/bin/lark-agent')
  expect(feishu.querySelector('.dt-savebar')).not.toBeNull()
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  const cli = () => field<HTMLInputElement>('机器人的 lark-cli', document.getElementById('dt-source-feishu')!)
  expect(cli().matches(':disabled')).toBe(true)
  // dsh-superagent 重启：DSH 先返回空 404，随后再次响应。
  server.down = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  server.down = false
  const reads = server.requests.filter(request => request.path === 'settings').length
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings').length).toBeGreaterThan(reads)
  expect(cli().matches(':disabled')).toBe(false)
  expect(cli().value).toBe('/opt/bin/lark-agent')
})

it('creates a Source record through the API and shows the new card', async () => {
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  await type(field<HTMLInputElement>(zh.sourceName, document.querySelector('.dt-source-add')!), '第二个飞书')
  await type(field<HTMLSelectElement>(zh.sourceAddKind), 'feishu')
  await click(zh.sourceAdd)
  expect(server.requests.find(request => request.path === 'sources')).toMatchObject({ method: 'POST', body: { kind: 'feishu', name: '第二个飞书' } })
  expect(document.querySelector('.dt-toast')?.textContent).toBe('已新增来源 feishu-2')
  expect(all('.dt-card')).toHaveLength(2)
  expect(document.getElementById('dt-source-feishu-2')).not.toBeNull()
})

it('deletes a Source through the API and removes its card', async () => {
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  await click(find(zh.sourceDelete, '#dt-source-feishu button'))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('删除“飞书”？')
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'sources/feishu')).toMatchObject({ method: 'DELETE' })
  expect(all('.dt-card')).toHaveLength(0)
  expect(document.querySelector('.dt-toast')?.textContent).toBe('已删除来源 飞书')
})

it('shows the server refusal when deleting a Source that still has unfinished Tickets', async () => {
  server.openTickets = { feishu: 2 }
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  await click(find(zh.sourceDelete, '#dt-source-feishu button'))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('该来源还有 2 个未完成工单，不能删除')
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'sources/feishu' && request.method === 'DELETE')).toBe(true)
  expect(document.querySelector('.dt-toast')?.textContent).toBe('该来源 feishu 还有 2 个未完成工单，请先停用来源以结束它们。')
  expect(all('.dt-card')).toHaveLength(1)
})

it('warns that disabling a Source with unfinished Tickets ends them before saving', async () => {
  server.openTickets = { feishu: 1 }
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  await click('运行来源：飞书')
  expect(document.getElementById('dt-source-feishu')?.querySelector('.dt-savebar')?.textContent)
    .toContain('停用会立即停止轮询，并结束 1 个未完成工单')
})

it('verifies one key field at a time in the Add Source form and reports the result in place', async () => {
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const add = document.querySelector<HTMLElement>('.dt-source-add')!
  const verify = (label: string) => [...add.querySelectorAll<HTMLButtonElement>('.dt-verify-row button')]
    .find(button => button.getAttribute('aria-label') === `${zh.verify} · ${label}`)!
  const result = (label: string) => verify(label).closest('.dt-verify-item')!.querySelector('.dt-check')
  // 过长的名称会被服务端拒绝，失败原因就地显示。
  await type(field<HTMLInputElement>(zh.sourceName, add), 'x'.repeat(81))
  await click(verify(zh.sourceName))
  expect(result(zh.sourceName)?.textContent).toBe('项目名称不能超过 80 个字符')
  expect(result(zh.sourceName)?.getAttribute('role')).toBe('alert')
  // 改短后再次单独预检，结果同样是该字段自己的。
  await type(field<HTMLInputElement>(zh.sourceName, add), '支付重构')
  await click(verify(zh.sourceName))
  expect(result(zh.sourceName)?.textContent).toBe('项目名称可用')
  expect(result(zh.sourceName)?.getAttribute('role')).toBe('status')
  expect(server.requests.filter(request => request.path === 'sources/verify').at(-1)).toMatchObject({ method: 'POST',
    body: { kind: 'feishu', name: '支付重构', field: 'name' } })
})

it('verifies every key field of the Add Source form with one button', async () => {
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const add = document.querySelector<HTMLElement>('.dt-source-add')!
  await click(find(zh.verifyAll, '.dt-source-add button'))
  expect(server.requests.filter(request => request.path === 'sources/verify').at(-1)).toMatchObject({ body: { kind: 'feishu', field: 'all' } })
  // 名称、类型、记录 ID、实例地址与 CLI 各有一条就地结果。
  expect([...add.querySelectorAll('.dt-check')].map(item => item.textContent)).toHaveLength(5)
  expect(add.querySelector('.dt-check')?.textContent).toBe('项目名称可用')
})

it('saves a project name for an existing Source and shows it as the card title', async () => {
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const feishu = document.getElementById('dt-source-feishu')!
  await type(field<HTMLInputElement>(zh.sourceName, feishu), '支付重构')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.feishu!.name).toBe('支付重构')
  expect(document.getElementById('dt-source-feishu')?.querySelector('.dt-card-title')?.textContent).toBe('支付重构')
})
