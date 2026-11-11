import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveFeishuSource, resolveGithubSource, resolveGitlabSource, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'
import { reference } from './fixtures/deployment.ts'
import { programSource, runProgram } from './fixtures/program.ts'

const exec = promisify(execFile)
let dir: string
let path: string
let ghCli: string
let larkCli: string
const program = (name: string, body = ''): string => programSource(join(dir, 'bin'), name, body)
const programIn = (directory: string, name: string, body = ''): string => programSource(directory, name, body)
/** 伪造的 gh CLI，以 `login` 身份登录，对 acme/widgets（包括其旧名 acme/gadgets）具有可配置的推送权限。 */
const gh = (name: string, login: string, push = true): string => program(name, `const args = argv.join(' ')
if (args === 'api user') { console.log(${JSON.stringify(JSON.stringify({ login, id: 7 }))}); return 0 }
if (args.startsWith('api repos/acme/') && args.endsWith('--jq {name: .full_name, push: .permissions.push}')) {
  console.log(${JSON.stringify(JSON.stringify({ name: 'acme/widgets', push }))}); return 0
}
return 1`)
/** 伪造的 lark-cli 程序，返回预设的认证、严格模式和机器人信息响应。 */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  program('lark-cli', `const args = argv.join(' ')
if (args === 'auth status') { console.log(${JSON.stringify(JSON.stringify(status))}); return 0 }
if (args === 'config strict-mode') { console.log(${JSON.stringify(`strict-mode: ${mode} (source: profile)`)}); return 0 }
if (args === 'api GET /open-apis/bot/v3/info --as bot --format ndjson') { console.log(${JSON.stringify(JSON.stringify(bot))}); return 0 }
return 1`)
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** 像执行器的 shell 那样运行命令，但在本地：替身程序优先于 PATH，之后是系统的 git。 */
const probe: Probe = async (argv, env = {}) => (await runProgram(argv[0]!, argv.slice(1), { env: { ...process.env, PATH: path, HOME: dir, ...env } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), join(dir, 'state', 'worker-bin') + sep, join(dir, 'bin'), '/usr/bin', '/bin'].join(delimiter)
  ghCli = gh('gh', 'Agent-Bot')
  larkCli = lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } })
  // 同名的陈旧执行器垫片必须被跳过，无论 PATH 是否规范化或是否经过符号链接。
  programIn(join(dir, 'state', 'worker-bin'), 'gh')
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// 测试并行运行时，Setup 启动的 CLI 子进程可能需要数秒。
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // 上限是易变引用，由加载器原地更新，调用方在用到时读取。
    expect({ stateDir: read.stateDir, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('gives the command timeout, CLIs and Git hosts defaults that the configuration can override', () => {
    const defaults = machineOf(Config(minimal()))
    expect([defaults.commandTimeoutMs.get(), defaults.githubCli.get(), defaults.gitlabCli.get(), defaults.githubHost.get(), defaults.gitlabHost.get(),
      defaults.workspaceRetentionDays.get()]).toEqual([90_000, 'gh', 'glab', 'github.com', 'gitlab.com', 14])
    const overridden = machineOf(Config(minimal({ commandTimeoutMs: 5000, githubCli: 'octo', gitlabCli: 'lab', githubHost: 'git.example.com',
      gitlabHost: 'lab.example.com', workspaceRetentionDays: 0 })))
    expect([overridden.commandTimeoutMs.get(), overridden.githubCli.get(), overridden.gitlabCli.get(), overridden.githubHost.get(),
      overridden.gitlabHost.get(), overridden.workspaceRetentionDays.get()]).toEqual([5000, 'octo', 'lab', 'git.example.com', 'lab.example.com', 0])
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on each GitHub Source record), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads each GitHub record\'s repository and account from its CLI, skipping the worker shims', async () => {
    const deployment = await resolveGithubSource(machine(), 'github-main', { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toEqual({ id: 'github-main', kind: 'github', instanceUrl: '', cli: ghCli, repository: 'acme/widgets', login: 'Agent-Bot',
      noreply: '7+Agent-Bot@users.noreply.github.com', auth: 'https', remote: '', sshKey: '' })
    // 重命名后的仓库仍可通过旧名解析；通知携带 GitHub 当前的全名（full_name）。
    expect((await resolveGithubSource(machine(), 'github-main', { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('resolves an SSH record from the local key without running gh', async () => {
    const source = await resolveGithubSource(machine(), 'github-ssh', { auth: 'ssh', repository: 'acme/widgets' }, probe, path)
    expect(source).toEqual({ id: 'github-ssh', kind: 'github', instanceUrl: '', cli: '', repository: 'acme/widgets', login: '', noreply: '',
      auth: 'ssh', remote: '', sshKey: '' })
    // 自定义远端可以替代仓库字段；两者都缺时给出明确错误，而不是交给 gh。
    expect((await resolveGithubSource(machine(), 'github-ssh', { auth: 'ssh', remote: 'git@example.com:acme/widgets.git' }, probe, path)).remote)
      .toBe('git@example.com:acme/widgets.git')
    await expect(resolveGithubSource(machine(), 'github-ssh', { auth: 'ssh' }, probe, path))
      .rejects.toEqual(setupError('github-ssh', 'repositoryUnset', {}))
    // 内嵌账号密码的远端在保存时就被拒绝，凭据只能来自本机 SSH key。
    await expect(resolveGithubSource(machine(), 'github-ssh', { auth: 'ssh', remote: 'https://user:pass@example.com/acme/widgets.git' }, probe, path))
      .rejects.toThrow()
  })
  it('points a self-hosted GitHub Enterprise record at its instance with GH_HOST', async () => {
    const enterprise = program('gh-enterprise', `const args = argv.join(' ')
if (args === 'api user') {
  if (process.env.GH_HOST !== 'git.example.com') { console.error('GH_HOST is ' + process.env.GH_HOST); return 1 }
  console.log('{"login":"Agent-Bot","id":7}'); return 0
}
if (args.startsWith('api repos/acme/widgets')) { console.log('{"name":"acme/widgets","push":true}'); return 0 }
return 1`)
    const source = await resolveGithubSource(machine(), 'enterprise', { repository: 'acme/widgets', cli: 'gh-enterprise', instanceUrl: 'https://git.example.com' }, probe, path)
    expect(source).toMatchObject({ id: 'enterprise', instanceUrl: 'https://git.example.com', repository: 'acme/widgets' })
    expect(source.cli).toBe(enterprise)
    // 实例地址只接受站点根地址；带路径的输入在保存时就会报错，而不是静默访问错误的 API。
    await expect(resolveGithubSource(machine(), 'enterprise', { repository: 'acme/widgets', cli: 'gh-enterprise', instanceUrl: 'https://git.example.com/group' }, probe, path)).rejects.toThrow()
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveGithubSource(machine(), place, github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github-main', 'repositoryUnset', {}, { cli: 'gh' })
    // 记录未指定 CLI 时使用宿主默认值 `gh`，并解析到 PATH 上的同名程序。
    expect(await resolveGithubSource(machine(), 'github-main', { repository }, probe, path)).toMatchObject({ cli: ghCli })
    await needs('github-main', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github-main', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github-main', 'agentCliSignedOut', {}, { repository, cli: program('gh-broken', 'return 1') })
    await needs('github-main', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh('gh-reader', 'Agent-Bot', false) })
    // 已登录，但该账号无法读取仓库，或 CLI 未指明任何账号。
    const unreadable = program('gh-outsider', `const args = argv.join(' ')
if (args === 'api user') { console.log('{"login":"Agent-Bot","id":7}'); return 0 }
console.error('HTTP 404')
return 1`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github-main', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github-main', 'agentCliNoAccount', {}, { repository, cli: program('gh-anonymous', `console.log('{}')`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads a Feishu record\'s bot from its bot-only lark-cli, and reports a record that names no CLI', async () => {
    await expect(resolveFeishuSource(machine(), 'feishu-main', {}, probe, path)).rejects.toEqual(setupError('feishu-main', 'feishuCliUnset', {}))
    expect(await resolveFeishuSource(machine(), 'feishu-main', { cli: 'lark-cli' }, probe, path)).toEqual({ id: 'feishu-main', kind: 'feishu', instanceUrl: '', cli: larkCli, appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuSource(machine(), 'feishu-main', { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu-main', code, values))
    lark({ identities: { bot: { status: 'ready' } } })
    await refuses('feishuNoApp')
    lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } })
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off')
    await refuses('feishuUserIdentity', { mode: 'off' })
    lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} })
    await refuses('feishuNoBot')
    program('lark-cli', `console.error('not configured')
return 1`)
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
  it('reads the Feishu app and bot through a CLI that prints a banner before its JSON, and defaults the brand to feishu', async () => {
    // lark-cli 的升级提示可能出现在 JSON 之前；凭据校验只认能解析成载荷的行，不取第一行。
    program('lark-cli', `const args = argv.join(' ')
if (args === 'auth status') {
  console.log('note: a newer lark-cli is available')
  console.log(${JSON.stringify(JSON.stringify({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }))})
  return 0
}
if (args === 'config strict-mode') { console.log('strict-mode: bot (source: profile)'); return 0 }
if (args === 'api GET /open-apis/bot/v3/info --as bot --format ndjson') {
  console.log('note: reading the bot from the cache')
  console.log('{"bot":{"open_id":"ou_bot","app_name":"Widgets Bot"}}')
  return 0
}
return 1`)
    expect(await resolveFeishuSource(machine(), 'feishu-main', { cli: 'lark-cli' }, probe, path)).toEqual({ id: 'feishu-main', kind: 'feishu', instanceUrl: '', cli: larkCli, appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot', name: 'Widgets Bot' })
  })
})

describe('gitlab setup', () => {
  const project = 'group/sub/widgets'
  const user = '{"id":7,"username":"Agent-Bot"}'
  const payload = (access: number | null = 30, group: number | null = null, path = project): string => JSON.stringify({ id: 42,
    path_with_namespace: path, namespace: { path: 'group/sub' },
    permissions: { project_access: access === null ? null : { access_level: access }, group_access: group === null ? null : { access_level: group } } })
  /** 伪造的 glab：报告已登录用户和一个项目载荷，类似 `glab api user` 与 `glab api projects/<encoded>`。 */
  const glab = (name: string, userJson = user, projectJson = payload()): string => program(name, `const args = argv.join(' ')
if (args === 'api user') { console.log(${JSON.stringify(userJson)}); return 0 }
if (args === 'api projects/group%2Fsub%2Fwidgets') { console.log(${JSON.stringify(projectJson)}); return 0 }
return 1`)
  it('reads the GitLab project and its Developer access from glab, and reports a record without a project', async () => {
    await expect(resolveGitlabSource(machine(), 'gitlab-main', {}, probe, path)).rejects.toEqual(setupError('gitlab-main', 'gitlabProjectUnset', {}))
    const cli = glab('glab')
    expect(await resolveGitlabSource(machine(), 'gitlab-main', { project, cli: 'glab' }, probe, path)).toEqual({ id: 'gitlab-main', kind: 'gitlab',
      instanceUrl: '', cli, project, projectId: 42, login: 'Agent-Bot', userId: 7, auth: 'https', remote: '', sshKey: '' })
    // SSH 记录不运行 glab，项目与账号字段留空，访问权限留给同步探测。
    expect(await resolveGitlabSource(machine(), 'gitlab-ssh', { auth: 'ssh', project }, probe, path)).toMatchObject({ auth: 'ssh', project,
      projectId: 0, login: '', userId: 0 })
    await expect(resolveGitlabSource(machine(), 'gitlab-ssh', { auth: 'ssh' }, probe, path))
      .rejects.toEqual(setupError('gitlab-ssh', 'gitlabProjectUnset', {}))
    // 群组访问权限与项目访问权限等价，且使用重命名后的规范路径。
    expect(await resolveGitlabSource(machine(), 'gitlab-main', { project, cli: glab('glab-group', user, payload(null, 30, 'group/renamed')) }, probe, path))
      .toMatchObject({ project: 'group/renamed' })
  })
  it('names what GitLab setup needs and where it is set', async () => {
    const needs = (code: string, values: Record<string, unknown>, cli: string, userJson?: string, projectJson?: string) =>
      expect(resolveGitlabSource(machine(), 'gitlab-main', { project, cli }, probe, path)).rejects.toEqual(setupError('gitlab-main', code, values))
    // 记录未指定 CLI 时回退到宿主配置的默认命令；用一个不存在的名字验证回退生效。
    await expect(resolveGitlabSource(machine({ gitlabCli: reference('glab-absent') }), 'gitlab-main', { project, cli: '' }, probe, path))
      .rejects.toEqual(setupError('gitlab-main', 'gitlabCliMissing', { output: 'glab-absent is not an executable file on PATH' }))
    await needs('gitlabCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, join(dir, 'missing'))
    await needs('gitlabCliSignedOut', {}, program('glab-broken', 'return 1'))
    await needs('gitlabNoAccount', {}, glab('glab-anonymous', '{}'))
    const unreadable = program('glab-outsider', `const args = argv.join(' ')
if (args === 'api user') { console.log(${JSON.stringify(user)}); return 0 }
console.error('HTTP 404')
return 1`)
    await needs('gitlabProjectUnreadable', { account: 'Agent-Bot', project, output: expect.stringContaining('HTTP 404') as unknown }, unreadable)
    await needs('gitlabProjectUnreported', { project }, glab('glab-empty-project', user, '{}'))
    await needs('gitlabReadOnly', { account: 'Agent-Bot', project }, glab('glab-reader', user, payload(20)))
  })
})
