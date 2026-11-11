// @vitest-environment jsdom
// 评估状态与设置。
import { act } from 'react'
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('opens the Decisions under Policy from the flow line with their reasons, Decisions that start work first, filterable by kind',
  async () => {
  await mount()
  await click(all('.dt-stat button')[1]!)
  expect(tab(zh['tab.eval']).getAttribute('aria-selected')).toBe('true')
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=accept,reopen&window=24h')).toBe(true)
  expect(text()).toContain(zh['reason.explicitRouted'])
  await click(zh.stop)
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=stop&window=24h')).toBe(true)
  expect(text()).toContain('@bot 修一下')
  await click(zh['decision.ignore'])
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=ignore&window=24h')).toBe(true)
  expect(text()).toContain(zh.none)
  await click(zh.lastDayOnly)
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=ignore')).toBe(true)
})

it('keeps a Policy draft across remounts, and merges another save into it sender by sender and rule by rule', async () => {
  const addUser = async () => {
    await click(all('.dt-part button').find(button => button.textContent === '添加')!)
    const row = all('.dt-part .dt-rows-item').at(-1)!
    await type(row.querySelector<HTMLInputElement>('input[aria-label="open_id"]')!,
      'ou_newperson'); await type(row.querySelector<HTMLInputElement>('input[aria-label="名字"]')!, '新人')
  }
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(all('.dt-subtab')).toHaveLength(0)
  await addUser()
  expect(text()).toContain(zh.draftKept)
  await remount()
  expect(text()).toContain(zh.draftRestored)
  expect(all('.dt-part .dt-rows-item')).toHaveLength(2)
  // 与此同时，其他人重命名了一条规则并允许了另一个发送者：草稿保留自己的发送者，并接收双方的新增项。
  const { policy } = server.settings
  server.settings = { ...server.settings, policy: { ...policy, rules: [{ ...policy.rules[0]!, name: '文案' }],
    sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, allowed: [...policy.sources.feishu!.allowed, { id: 'ou_bob',
      name: 'Bob' }] } } } }
  server.revisions.policy = 4
  await click(zh.save)
  expect(text()).toContain(zh.saveMerged)
  await type(all('.dt-part input[aria-label="名字"]').at(-2) as HTMLInputElement, '新同事')
  expect(text()).not.toContain(zh.saveMerged)
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_newperson', name: '新同事' },
    { id: 'ou_bob', name: 'Bob' }])
  expect(server.settings.policy.rules.map(rule => rule.name)).toEqual(['文案'])
  expect(sessionStorage.getItem('dsh-superagent/draft/master/policy')).toBeNull()
})

it('keeps the Policy to its rules and the Feishu Source\'s part, in that Source\'s own identities', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(`${zh['term.eval']}${zh['settingsGroupTag']}`, '.dt-settings-link'))
  // 自动合并及其阈值属于提示词文本，策略核心中不放置任何来源的设置。
  for (const gone of ['自动合并', '行数阈值', '成员', '计入策略版本']) expect(text()).not.toContain(gone)
  expect(all('.dt-lv').map(item => item.textContent)[0]).toBe('策略版本 abcdef12')
  expect(text()).toContain('名单内的人 @ 机器人或私聊机器人，总是明确的请求')
})

it('opens the rule list for an invalid field inside it only', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const openRows = () => all('.dt-disclosure[data-open]').length
  await act(async () => { field(zh.evalTimeout).dispatchEvent(new Event('invalid', { bubbles: false })) })
  expect(openRows()).toBe(0)
  await click(all('.dt-rule [data-disclosure-row]')[0]!)
  await act(async () => { all('.dt-rule input')[0]!.dispatchEvent(new Event('invalid')) })
  expect(openRows()).toBe(all('.dt-rule').length)
})

it('syncs a Source\'s list from where the Source keeps it, but not while a Policy draft is unsaved', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect([...all('.dt-part select')[0]!.querySelectorAll('option')].map(option => option.textContent)).toEqual(['不同步', '另一个群', '团队群'])
  await click(find('立即同步', '.dt-part button'))
  expect(server.requests.some(request => request.path === 'policy-sync/feishu' && request.method === 'POST')).toBe(true)
  await type(all('.dt-part select')[0] as HTMLSelectElement, 'oc_other')
  const before = server.requests.length
  await click(find('立即同步', '.dt-part button'))
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.syncNeedsSave)
  expect(server.requests.slice(before).some(request => request.path.startsWith('policy-sync'))).toBe(false)
})

it('adds, copies, renames, disables and deletes rules in Policy without touching Eval', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(zh.addRule)
  await type(field<HTMLInputElement>(zh.ruleName), '文档')
  await type(field<HTMLTextAreaElement>(zh.ruleInstruction), '修复失效链接')
  await click(zh.duplicate)
  expect(all('.dt-rule').map(rule => rule.querySelector('[data-disclosure-row]')!.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('文档 副本')]))
  await click('启用规则：文案修改')
  const removeButtons = all('button').filter(button => button.textContent === '删除')
  await click(removeButtons.at(-1)!)
  await click(zh.save)
  expect(server.settings.policy.rules.map(rule => [rule.name, rule.enabled])).toEqual([['文案修改', false], ['文档', true]])
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/policy'])
})

it('shows the current Policy version once, explains what makes it up, and opens a Mandate\'s version in the Policy history', async () => {
  await mount()
  await click(zh['tab.eval'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await settle()
  expect(all('.dt-lv')[0]!.textContent).toBe('策略版本 abcdef12')
  expect(all('.dt-info').map(tip => tip.getAttribute('aria-label')).join('\n')).toContain('策略版本由接单规则、各来源上的策略和评估的接单模式决定')
  expect(all('.dt-tag').filter(tag => tag.textContent === '计入策略版本')).toHaveLength(0)
  await click(tab(zh['tab.execution']))
  await click('修复回归')
  await click('abcdef12')
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent)
    .toBe(`${zh['term.eval']}${zh['settingsGroupTag']}`)
  await settle()
  // 历史打开在生成该版本的那次保存处，并列出各来源保存也产生的版本。
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('生成策略版本 abcdef12')
  expect(text()).toContain('生成策略版本 98765432')
})

it('sets the Feishu admission table per receiving scope, offering only the cells a scope can receive, and warns when anyone may originate work', async () => {
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { kind: 'feishu', name: '飞书', enabled: true, config: { cli: 'lark-bot',
    chats: [{ chatId: 'oc_team', listen: 'all' }, { chatId: 'oc_other', listen: 'mentions' }], directMessages: true,
      otherChats: 'none' } } } }
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(`${zh['term.eval']}${zh['settingsGroupTag']}`, '.dt-settings-link'))
  const rows = all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelectorAll('select').length])
  // 接收所有消息的群聊拥有全部三个单元格；仅 @ 的群聊只有点名单元格；其他群聊在不接收时没有单元格。
  expect(rows).toEqual([['团队群', 3], ['另一个群', 1], ['其他群', 0], ['私聊', 1]])
  const cell = field<HTMLSelectElement>('团队群 · 名单外 · 点名智能体')
  expect(cell.value).toBe('ignore')
  await type(cell, 'explicit')
  // 警告是每个单元格都会预留的槽位中的一个图标，悬停时显示文本，因此表格不会移动。
  expect(document.querySelector('.dt-admission .dt-info-warn')?.getAttribute('aria-label')).toBe(zh.admissionAnyoneWarning)
  expect(all('.dt-admission-slot')).toHaveLength(5)
  // 未发给机器人的消息不能成为明确请求。
  expect([...field<HTMLSelectElement>('团队群 · 名单外 · 未 @').options].map(option => option.value)).toEqual(['inferred', 'ignore'])
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.admission).toEqual({ oc_team: { unlistedAddressed: 'explicit' } })
})
