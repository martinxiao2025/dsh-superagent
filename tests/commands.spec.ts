import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { redact } from '../src/infra/text.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { key, type OutboundMessage } from '../src/core/index.ts'
import { testDeployment, testFeishu, testGithub, testGitlab } from './fixtures/deployment.ts'
const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { kind: 'feishu', name: '飞书', enabled: true, config: {} } } }))
sources.register(feishuKind)
const send = (commands: Commands, message: OutboundMessage) => sources.send(message, commands)
const deployment = testDeployment({ github: testGithub({ cli: '/path/agent-gh' }) })
const REPOSITORY = testGithub().repository
/** 绑定到指定来源记录的命令；发送时会按消息渠道重新绑定记录。 */
const commandsOf = (value = deployment, record = 'github') => new Commands(() => value, {}, new AbortController().signal).scope(record)
/** 绑定到默认飞书记录的命令。 */
const feishuCommands = (value = deployment) => commandsOf(value, 'feishu')
const reply = { id: 'stable-operation', channel: feishuChannel('feishu', 'oc_1', 'om_1'), text: 'Done', kind: 'reply' as const }
describe('account-isolated operations', () => {
  it('uses the agent account\'s GitHub CLI and preserves literal shell metacharacters in argv', async () => {
    const commands = commandsOf(); const run = vi.spyOn(commands,'run').mockResolvedValue('{}')
    await commands.gh(['api','some-path','-f','body=`whoami` $(touch x)'])
    expect(run).toHaveBeenCalledWith('/path/agent-gh', ['api','some-path','-f','body=`whoami` $(touch x)'])
  })
  it('runs every command with its environment over the process environment, where undefined removes a variable', async () => {
    process.env.GH_TOKEN = 'personal'
    try {
      const output = JSON.parse(await new Commands(() => deployment, { GH_TOKEN: undefined, DSH_SUPERAGENT_PROBE: 'agent' },
        new AbortController().signal).run(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'])) as Record<string, string>
      expect(output.DSH_SUPERAGENT_PROBE).toBe('agent')
      expect(output).not.toHaveProperty('GH_TOKEN')
    } finally { delete process.env.GH_TOKEN }
  })
  it('routes gh to the record\'s own enterprise instance with GH_HOST', async () => {
    delete process.env.GH_HOST
    const enterprise = testDeployment({ sources: {
      'github-ghe': testGithub({ id: 'github-ghe', instanceUrl: 'https://ghe.example.com/', cli: '/path/agent-gh' }) } })
    const environment = async (value: ReturnType<typeof testDeployment>, record: string) => JSON.parse(await new Commands(() => value, {},
      new AbortController().signal).scope(record).run(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'])) as Record<string, string>
    try {
      expect((await environment(enterprise, 'github-ghe')).GH_HOST).toBe('ghe.example.com')
      expect(await environment(deployment, 'github')).not.toHaveProperty('GH_HOST')
    } finally { delete process.env.GH_HOST }
  })
  it('routes glab to the record\'s own enterprise instance with GITLAB_HOST', async () => {
    delete process.env.GITLAB_HOST
    const enterprise = testDeployment({ sources: {
      'gitlab-self': testGitlab({ id: 'gitlab-self', instanceUrl: 'https://gitlab.example.com/', cli: '/path/agent-glab' }),
      gitlab: testGitlab({ cli: '/path/agent-glab' }) } })
    const environment = async (value: ReturnType<typeof testDeployment>, record: string) => JSON.parse(await new Commands(() => value, {},
      new AbortController().signal).scope(record).run(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'])) as Record<string, string>
    try {
      expect((await environment(enterprise, 'gitlab-self')).GITLAB_HOST).toBe('gitlab.example.com')
      expect(await environment(enterprise, 'gitlab')).not.toHaveProperty('GITLAB_HOST')
      expect(await environment(enterprise, 'gitlab-self')).not.toHaveProperty('GH_HOST')
    } finally { delete process.env.GITLAB_HOST }
  })
  it('refuses Feishu commands when the deployment has no Feishu bot', async () => {
    await expect(feishuCommands(testDeployment({ feishu: undefined })).lark(['im', '+chat-list'])).rejects.toThrow('The Feishu Source has no working bot CLI')
  })
  it('uses Feishu bot identity and one idempotency key on retries', async () => {
    const commands = feishuCommands(); const run = vi.spyOn(commands,'run').mockResolvedValue('{"ok":true,"data":{}}')
    await send(commands, reply)
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--as','bot','--idempotency-key','stable-operation','--message-id','om_1']))
  })
})

it('reports Feishu failures with their code and without command arguments', () => {
  const membership = commandError({stderr:'[page 1] fetching...\n'+JSON.stringify({error:{code:232011,message:'operator is not in the chat'}})})
  expect(membership).toMatchObject({ message: 'operator is not in the chat (232011)', code: 232011 })
  expect(commandError({stderr:JSON.stringify({error:{code:999,message:'scope missing'}})}).message).toBe('scope missing (999)')
})
describe('Channels', () => {
  const feishu = { ...reply, channel: feishuChannel('feishu', 'oc_1', 'om_1') }
  const lark = (code: number, message: string) => commandError({ stderr: JSON.stringify({ error: { code, message } }), code: 1 })
  it('drop a Feishu reply to a recalled message or one Feishu no longer finds, and say how to add the bot to a chat', async () => {
    const value = feishuCommands()
    const run = vi.spyOn(value, 'run')
    for (const [code, message] of [[230011, 'The message is recalled'], [230001, 'message not found'], [231003,
      'The message is withdrawn']] as const) {
      run.mockRejectedValueOnce(lark(code, message))
      expect(await send(value, feishu)).toBe('gone')
    }
    run.mockRejectedValueOnce(lark(232011, 'operator is not in the chat'))
    const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
    await expect(send(value, feishu)).rejects.toThrow(hint)
    run.mockRejectedValueOnce(lark(99991400, 'rate limited'))
    await expect(send(value, feishu)).rejects.toThrow('rate limited (99991400)')
  })
  it('keep a Feishu reply whose command timed out for a retry, whatever its text says', async () => {
    const value = feishuCommands()
    const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '', message: 'Command failed: lark-bot --markdown withdrawn' }
    vi.spyOn(value, 'run').mockRejectedValueOnce(commandError(timedOut, 'lark-bot'))
    await expect(send(value, { ...feishu, text: 'The change was withdrawn' })).rejects.toThrow('lark-bot timed out after 90 s')
  })
  it('link a Feishu message address to its chat with its label', () => {
    const message = feishuChannel('feishu', 'oc_1', 'om_1').address
    expect(feishuKind.channel!.link(message, { feishu: testFeishu() })).toEqual({ url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
      label: { zh: '飞书消息', en: 'Feishu message' }, triggerId: key('feishu', 'om_1') })
  })
})

describe('GitHub calls', () => {
  const commands = () => commandsOf()
  it('go only to paths inside the configured repository, and validate what GitHub answers', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('{"number":12,"title":"Login fails","extra":true}')
    expect(await value.api(z.looseObject({ number: z.number() }), 'issues/12')).toEqual({ number: 12, title: 'Login fails', extra: true })
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}/issues/12`])
    await expect(value.api(z.looseObject({ number: z.string() }), 'issues/12')).rejects.toThrow()
    for (const path of ['../other/repo/issues', 'issues/../../x', '/repos/x/y', 'https://api.github.com/x']) {
      await expect(value.api(z.unknown(), path)).rejects.toThrow('restricted to the configured repository')
    }
    expect(run).toHaveBeenCalledTimes(2)
    // 空路径指向仓库根目录。
    await value.api(z.unknown(), '')
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}`])
    // 没有 schema 时，api() 返回 CLI 的原始标准输出。
    run.mockResolvedValue('raw file')
    expect(await value.api('contents/README.md', '-H', 'Accept: application/vnd.github.raw')).toBe('raw file')
  })
  it('read every page of a list, and skip and count an item that does not validate', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('[[{"id":1}],[{"id":2}]]')
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments?per_page=100')).toEqual([{ id: 1 }, { id: 2 }])
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}/issues/12/comments?per_page=100`, '--paginate',
      '--slurp'])
    run.mockResolvedValue('[[{"id":1}],[{"id":"two"}]]')
    const tally = { skipped: 0 }
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments', tally)).toEqual([{ id: 1 }])
    expect(tally).toEqual({ skipped: 1 })
    run.mockResolvedValue('{"message":"not a list"}')
    await expect(value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments')).rejects.toThrow()
  })
})
it('says how to add the bot to a chat when Feishu answers that it is not a member, and keeps the code', async () => {
  const commands = feishuCommands()
  const membership = JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } })
  const run = vi.spyOn(commands, 'run').mockRejectedValueOnce(commandError({ stderr: membership, code: 1 }))
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011, exitCode: 1 })
  run.mockResolvedValueOnce(JSON.stringify({ ok: false, error: { code: 232011, message: 'operator is not in the chat' } }))
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011 })
})
it('names only the program and how it ended when a command prints no diagnostics, never its arguments', async () => {
  const commands = commandsOf()
  const secret = 'secret reply text'
  const failed = await commands.run(process.execPath, ['-e', 'process.exit(3)', secret]).catch((error: unknown) => error) as Error
  expect(failed).toMatchObject({ exitCode: 3 })
  expect(failed.message).toMatch(/ exited with code 3$/)
  expect(failed.message).not.toContain(secret)
  await expect(commands.run('/no/such/program', ['secret reply text'])).rejects.toMatchObject({ message: 'program could not run: ENOENT' })
  // 被信号终止的子进程只按信号报告；Node 自带的消息会回显每个参数。
  expect(commandError({ killed: true, signal: 'SIGKILL', code: null, stderr: '' }, '/bin/sh')).toMatchObject({ message: 'sh was stopped by SIGKILL' })
  // 超时会用 SIGTERM 终止子进程；Node 默认的错误消息会回显每个参数。
  const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '',
    message: 'Command failed: /path/lark-bot im +messages-reply --markdown withdrawn' }
  expect(commandError(timedOut, '/path/lark-bot')).toMatchObject({ message: 'lark-bot timed out after 90 s' })
  // 配置的命令时限同样体现在错误里，而不是固定写 90 秒。
  expect(commandError(timedOut, '/path/lark-bot', 5000)).toMatchObject({ message: 'lark-bot timed out after 5 s' })
  expect(String(commandError(timedOut, '/path/lark-bot'))).not.toContain('withdrawn')
})
it('reports failures as CliError with the code the CLI names and the exit status', async () => {
  const notFound = commandError({ stderr: 'gh: Not Found (HTTP 404)\n', code: 1 })
  expect(notFound).toBeInstanceOf(CliError)
  expect(notFound).toMatchObject({ message: 'gh: Not Found (HTTP 404)', code: 404, exitCode: 1 })
  expect(commandError({ stderr: JSON.stringify({ error: { code: 230011, message: 'The message is recalled' } }),
    code: 1 })).toMatchObject({ message: 'The message is recalled (230011)', code: 230011 })
  // 被取消的命令仍保持为 AbortError，以便调用方区分取消与失败。
  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', stderr: '' })
  expect(commandError(aborted)).toBe(aborted)
  const controller = new AbortController()
  const running = new Commands(() => deployment, {}, controller.signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  controller.abort()
  await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  const commands = feishuCommands()
  vi.spyOn(commands, 'run').mockResolvedValue(JSON.stringify({ ok: false, error: { code: 231003, message: 'message not found' } }))
  await expect(commands.lark(['im', '+messages-reply'])).rejects.toMatchObject({ message: 'message not found (231003)', code: 231003 })
})

it('stops a running command when the signal of its work aborts, or the lifetime, and leaves the other work running', async () => {
  const lifetime = new AbortController(), work = new AbortController()
  const commands = new Commands(() => deployment, {}, lifetime.signal)
  const started = Date.now()
  const running = commands.withSignal(work.signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  work.abort()
  await expect(running).rejects.toThrow()
  // 只有绑定到已中止工作信号的命令会停止。
  expect(await commands.run(process.execPath, ['-e', 'console.log("still")'])).toBe('still\n')
  const other = commands.withSignal(new AbortController().signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  lifetime.abort()
  await expect(other).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(4000)
})

describe('redact', () => {
  it('masks URL credentials, auth headers, tokens and private keys in CLI diagnostics', () => {
    expect(redact('fatal: unable to access https://user:secret@example.com/x.git/')).toBe('fatal: unable to access https://***@example.com/x.git/')
    expect(redact('curl -H "authorization: Bearer sk-123" https://api.example.com')).toBe('curl -H "authorization: ***" https://api.example.com')
    expect(redact('https://api.example.com/x?access_token=abc&page=1')).toBe('https://api.example.com/x?access_token=***&page=1')
    expect(redact('token=abcdef&x=1')).toBe('token=***&x=1')
    expect(redact('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----'))
      .toBe('-----BEGIN OPENSSH PRIVATE KEY-----***-----END OPENSSH PRIVATE KEY-----')
    // 无关文本原样保留。
    expect(redact('gh: Not Found (HTTP 404)')).toBe('gh: Not Found (HTTP 404)')
  })

  it('redacts command stderr before it reaches tickets or the panel', () => {
    const error = commandError({ stderr: 'fatal: unable to access https://bot:secret@example.com/x.git/\n' }, 'git')
    expect(error.message).not.toContain('secret')
    expect(error.message).toContain('https://***@example.com')
  })
})
