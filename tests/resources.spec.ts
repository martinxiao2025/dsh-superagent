/** 来源资源按记录路由：用真实 CLI 进程验证两条记录的同号资源互不串读。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { TextCache } from '../src/app/cache.ts'
import { readResource, type ResourceHost } from '../src/app/resources.ts'
import { feishuTrigger } from '../src/sources/feishu-trigger.ts'
import type { Trigger } from '../src/core/index.ts'
import { testDeployment, testFeishu, testGithub, testGitlab } from './fixtures/deployment.ts'
import { programSource } from './fixtures/program.ts'

/** 只暴露来源读取所需部分的最小资源宿主；真实命令与真实分页缓存。 */
const hostOf = (commands: Commands, triggers: readonly Trigger[] = []): ResourceHost => ({
  commands, pages: new TextCache(200_000), masterId: 'master', feishuPageSize: () => 20,
  store: { triggers: { get: (id: string) => triggers.find(item => item.id === id) } },
} as unknown as ResourceHost)

/** 读取资源第一页并解析成对象，供断言 CLI 实际返回的内容。 */
async function content(host: ResourceHost, resource: string, ticketId?: string): Promise<Record<string, unknown>> {
  const page = await readResource(host, resource, 0, undefined, ticketId) as { text: string }
  return JSON.parse(page.text) as Record<string, unknown>
}

/** 写一个只响应 `repos/acme/widgets/issues/9` 的假 gh，标题由记录决定。 */
const fakeGithub = (directory: string, name: string, title: string): string => programSource(directory, name, [
  "if (argv[0] !== 'api') return 1",
  "const path = String(argv[1] ?? '')",
  "if (!path.endsWith('/issues/9')) { console.error('unexpected ' + argv.join(' ')); return 1 }",
  `console.log(JSON.stringify({ id: 9009, number: 9, title: ${JSON.stringify(title)}, state: 'open', body: 'body of ${title}',`,
  "  user: { login: 'agent-bot', type: 'User' }, created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/9' }))",
  'return 0',
].join('\n'))

/** 写一个只响应配置项目里 Issue 12 的假 glab，标题由记录决定。 */
const fakeGitlab = (directory: string, name: string, title: string): string => programSource(directory, name, [
  "if (argv[0] !== 'api') return 1",
  "const path = String(argv[1] ?? '')",
  "if (!path.endsWith('/issues/12')) { console.error('unexpected ' + argv.join(' ')); return 1 }",
  `console.log(JSON.stringify({ id: 1, iid: 12, title: ${JSON.stringify(title)}, description: 'body of ${title}', state: 'opened',`,
  "  created_at: '2026-09-09T00:00:00Z', web_url: 'https://gitlab.com/acme/widgets/-/issues/12', author: { id: 7, username: 'agent-bot' } }))",
  'return 0',
].join('\n'))

/** 写一个假 lark-cli：来源消息查询返回锚点，消息查询返回该记录自己的正文。 */
const fakeFeishu = (directory: string, name: string, text: string): string => programSource(directory, name, [
  "if (argv[0] === 'api' && argv[1] === 'GET') {",
  "  console.log(JSON.stringify({ ok: true, data: { items: [{ message_id: 'om_1', chat_id: 'oc_team' }] } }))",
  '  return 0',
  '}',
  "if (argv[0] === 'im' && argv[1] === '+messages-mget') {",
  "  console.log(JSON.stringify({ ok: true, data: { messages: [{ message_id: 'om_1', chat_id: 'oc_team', content: " + JSON.stringify(text) + ", msg_type: 'text',",
  "    sender: { id: 'ou_alice', sender_type: 'user' }, create_time: '1757376000000' }] } }))",
  '  return 0',
  '}',
  "console.error('unexpected ' + argv.join(' '))",
  'return 1',
].join('\n'))

/** 同一条飞书消息在不同记录下生成的触发器；触发器 id 由记录与消息 id 共同决定。 */
const feishuOf = (record: string): Trigger => feishuTrigger(record, { message_id: 'om_1', chat_id: 'oc_team', chat_type: 'group',
  sender_id: 'ou_alice', sender_type: 'user', content: 'hello', create_time: '1757376000000', mentions: [{ id: 'ou_bot' }] },
'ou_bot', 'cli_bot')!

let directory: string
const commandsFor = (sources: Record<string, ReturnType<typeof testGithub> | ReturnType<typeof testGitlab> | ReturnType<typeof testFeishu>>) =>
  new Commands(() => testDeployment({ sources }), {}, new AbortController().signal)

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-resources-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('来源资源按记录路由', () => {
  it('reads the same GitHub issue number from two records through each record’s own CLI', async () => {
    const commands = commandsFor({ alpha: testGithub({ id: 'alpha', cli: fakeGithub(directory, 'gh-alpha', 'alpha issue') }),
      beta: testGithub({ id: 'beta', cli: fakeGithub(directory, 'gh-beta', 'beta issue') }) })
    const host = hostOf(commands)
    expect(await content(host, 'github/alpha/issues/9')).toMatchObject({ number: 9, title: 'alpha issue' })
    expect(await content(host, 'github/beta/issues/9')).toMatchObject({ number: 9, title: 'beta issue' })
  })

  it('refuses to pick a GitHub record for the main Session but follows the ticket’s record in a worker', async () => {
    const commands = commandsFor({ alpha: testGithub({ id: 'alpha', cli: fakeGithub(directory, 'gh-alpha', 'alpha issue') }),
      beta: testGithub({ id: 'beta', cli: fakeGithub(directory, 'gh-beta', 'beta issue') }) })
    await expect(readResource(hostOf(commands), 'github/issues/9', 0, undefined)).rejects.toThrow(/alpha, beta/)
    const worker = hostOf(commands.scope('alpha'))
    expect(await content(worker, 'github/issues/9', 't1')).toMatchObject({ title: 'alpha issue' })
    await expect(readResource(worker, 'github/beta/issues/9', 0, undefined, 't1')).rejects.toThrow(/only its ticket's Source record/)
  })

  it('keeps paths without a record working when exactly one GitHub record is configured', async () => {
    const commands = commandsFor({ alpha: testGithub({ id: 'alpha', cli: fakeGithub(directory, 'gh-alpha', 'alpha issue') }) })
    expect(await content(hostOf(commands), 'github/issues/9')).toMatchObject({ title: 'alpha issue' })
  })

  it('reads the same GitLab issue id from two records through each record’s own CLI', async () => {
    const commands = commandsFor({ main: testGitlab({ id: 'main', cli: fakeGitlab(directory, 'glab-main', 'main issue') }),
      mirror: testGitlab({ id: 'mirror', cli: fakeGitlab(directory, 'glab-mirror', 'mirror issue') }) })
    const host = hostOf(commands)
    expect(await content(host, 'gitlab/main/issues/12')).toMatchObject({ number: 12, title: 'main issue' })
    expect(await content(host, 'gitlab/mirror/issues/12')).toMatchObject({ number: 12, title: 'mirror issue' })
    await expect(readResource(host, 'gitlab/issues/12', 0, undefined)).rejects.toThrow(/main, mirror/)
  })

  it('reads the same Feishu message from two records through each record’s own bot CLI', async () => {
    const first = feishuOf('feishu-a')
    const second = feishuOf('feishu-b')
    const commands = commandsFor({ 'feishu-a': testFeishu({ id: 'feishu-a', cli: fakeFeishu(directory, 'lark-a', 'alpha message') }),
      'feishu-b': testFeishu({ id: 'feishu-b', cli: fakeFeishu(directory, 'lark-b', 'beta message') }) })
    const host = hostOf(commands, [first, second])
    expect(await content(host, `feishu/${first.id}/message`)).toMatchObject({ status: 'available', message: { text: 'alpha message' } })
    expect(await content(host, `feishu/${second.id}/message`)).toMatchObject({ status: 'available', message: { text: 'beta message' } })
    expect(await content(host, `feishu/feishu-a/${first.id}/message`)).toMatchObject({ message: { text: 'alpha message' } })
    await expect(readResource(host, `feishu/feishu-a/${second.id}/message`, 0, undefined)).rejects.toThrow(/belongs to the feishu-b Source record/)
  })
})
