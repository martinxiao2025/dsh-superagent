// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession } from '../src/navigation.ts'
import { initialLocation, parseRoute, remember, setupPage } from '../src/client/route.ts'
const id = 'orchestrator-test' as SessionId
function fixture(ready = false) {
  const pending = Promise.withResolvers<void>()
  const state = { phase: ready ? 'ready' : 'pending', byId: ready ? { [id]: {} } : {} as Record<string, object> }
  const refresh = vi.fn(async () => { await pending.promise })
  // 导航只读取目录的就绪状态与成员关系，不读取摘要字段。
  const sessions = { list: { getSnapshot: () => state }, refresh } as unknown as Pick<ISessions, 'list' | 'refresh'>
  return { sessions, pending, state, refresh }
}
it('waits for initial catalog hydration before opening the linked master', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  expect(open).not.toHaveBeenCalled()
  state.phase = 'ready'; state.byId[id] = {}; pending.resolve()
  await expect(navigation).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id)
})
it('opens known Sessions without another network refresh', async () => {
  const { sessions, refresh } = fixture(true); const open = vi.fn()
  await expect(openKnownSession(sessions, id, open, new AbortController().signal)).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id); expect(refresh).not.toHaveBeenCalled()
})
it('reports unavailable targets without calling the throwing Session selector', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  state.phase = 'ready'; pending.resolve()
  await expect(navigation).rejects.toMatchObject({ code: 'not-listed' })
  expect(open).not.toHaveBeenCalled()
})
it('does not navigate after the panel unmounts or a newer request supersedes it', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn(); const controller = new AbortController()
  const navigation = openKnownSession(sessions, id, open, controller.signal)
  controller.abort(); state.phase = 'ready'; state.byId[id] = {}; pending.resolve()
  await expect(navigation).resolves.toBe(false); expect(open).not.toHaveBeenCalled()
})
it('reopens the page this tab showed last, and the overview for a route that no longer exists', () => {
  remember({ route: { page: 'eval', query: { filter: 'stop' } }, stack: [{ page: 'overview' }] })
  expect(initialLocation()).toEqual({ route: { page: 'eval', query: { filter: 'stop' } }, stack: [{ page: 'overview' }] })
  // Eval 标签页此前名为 Policy；以旧名保存的路由会回退到 overview。
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'policy' }, stack: [] }))
  expect(initialLocation()).toEqual({ route: { page: 'overview' }, stack: [] })
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'trigger', id: 'github:1' }, stack: [{ page: 'policy' }, { page: 'trigger' }] }))
  expect(initialLocation().stack).toEqual([{ page: 'trigger' }])
  sessionStorage.setItem('dsh-superagent/route', '{')
  expect(initialLocation().route).toEqual({ page: 'overview' })
})
it('reads each page a tab remembered with the parameters it takes, and leaves out what it does not know', () => {
  expect(parseRoute({ page: 'trigger', query: { filter: 'nope', trigger: 'e1' } })).toEqual({ page: 'trigger' })
  expect(parseRoute({ page: 'trigger', id: 'github:1', query: { trigger: 'e1', filter: 'recent' } }))
    .toEqual({ page: 'trigger', id: 'github:1', query: { trigger: 'e1' } })
  expect(parseRoute({ page: 'eval', query: { filter: 'stop', window: '7d' } })).toEqual({ page: 'eval', query: { filter: 'stop' } })
  expect(parseRoute({ page: 'execution', id: 5, query: { filter: 'idle' } })).toEqual({ page: 'execution', query: { filter: 'idle' } })
  expect(parseRoute({ page: 'settings', query: { group: 'policy', source: 'feishu' } }))
    .toEqual({ page: 'settings', query: { group: 'projects', source: 'feishu' } })
  // 旧版把消息来源配置放在 `source` 分组，现在并入项目页。
  expect(parseRoute({ page: 'settings', query: { group: 'source', source: 'feishu' } }))
    .toEqual({ page: 'settings', query: { group: 'projects', source: 'feishu' } })
  expect([parseRoute('overview'), parseRoute(null)]).toEqual([undefined, undefined])
})
it('parses every unreadable route shape to nothing and survives hostile route memories', () => {
  // 非对象与未知页面都解析为 undefined；查询不是对象时按缺失处理，合法的 24h 窗口保留。
  expect([parseRoute(undefined), parseRoute(7), parseRoute({}), parseRoute({ page: 'nope' })]).toEqual([undefined, undefined, undefined, undefined])
  expect(parseRoute({ page: 'trigger', query: 'recent' })).toEqual({ page: 'trigger' })
  expect(parseRoute({ page: 'eval', query: { filter: 'stop', window: '24h' } }))
    .toEqual({ page: 'eval', query: { filter: 'stop', window: '24h' } })
  // 很长的栈只保留其中可读的路由，顺序不变。
  const long = Array.from({ length: 500 }, (_, index) => index % 2 ? { page: 'overview' } : index)
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'overview' }, stack: long }))
  expect(initialLocation().stack).toEqual(Array.from({ length: 250 }, () => ({ page: 'overview' })))
  // 'null' 与抛错的 sessionStorage 读取都回退到 HOME；写入失败同样只是失去记忆，不抛出。
  sessionStorage.setItem('dsh-superagent/route', 'null')
  expect(initialLocation()).toEqual({ route: { page: 'overview' }, stack: [] })
  const denied = vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
  expect(initialLocation()).toEqual({ route: { page: 'overview' }, stack: [] })
  denied.mockRestore()
  const quota = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
  expect(() => remember({ route: { page: 'overview' }, stack: [] })).not.toThrow()
  quota.mockRestore()
})
it('opens the settings that fix each setup problem: the Deployment group, or the message-intake page of the Source it names', () => {
  expect(setupPage('deployment')).toEqual({ page: 'settings', query: { group: 'deployment' } })
  // 消息来源记录进入飞书凭据的「消息接入」页签。
  for (const place of ['github', 'feishu'] as const) expect(setupPage(place))
    .toEqual({ page: 'settings', query: { group: 'feishuCredentials', tab: 'ingress', source: place } })
  // 项目仓库来源标识带 `repo-` 前缀，打开对应项目卡片。
  expect(setupPage('repo-content')).toEqual({ page: 'settings', query: { group: 'projects', source: 'content' } })
})
