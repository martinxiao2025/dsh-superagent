import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, resolveFeishuBot, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'
import { programSource, runProgram } from './fixtures/program.ts'

const exec = promisify(execFile)
let dir: string
let path: string
let ghCli: string
let larkCli: string
const program = (name: string, body = ''): string => programSource(join(dir, 'bin'), name, body)
const programIn = (directory: string, name: string, body = ''): string => programSource(directory, name, body)
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (name: string, login: string, push = true): string => program(name, `const args = argv.join(' ')
if (args === 'api user') { console.log(${JSON.stringify(JSON.stringify({ login, id: 7 }))}); return 0 }
if (args.startsWith('api repos/acme/') && args.endsWith('--jq {name: .full_name, push: .permissions.push}')) {
  console.log(${JSON.stringify(JSON.stringify({ name: 'acme/widgets', push }))}); return 0
}
return 1`)
/** Fake lark-cli program returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  program('lark-cli', `const args = argv.join(' ')
if (args === 'auth status') { console.log(${JSON.stringify(JSON.stringify(status))}); return 0 }
if (args === 'config strict-mode') { console.log(${JSON.stringify(`strict-mode: ${mode} (source: profile)`)}); return 0 }
if (args === 'api GET /open-apis/bot/v3/info --as bot --format ndjson') { console.log(${JSON.stringify(JSON.stringify(bot))}); return 0 }
return 1`)
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await runProgram(argv[0]!, argv.slice(1), { env: { ...process.env, PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), join(dir, 'state', 'worker-bin') + sep, join(dir, 'bin'), '/usr/bin', '/bin'].join(delimiter)
  ghCli = gh('gh', 'Agent-Bot')
  larkCli = lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } })
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  programIn(join(dir, 'state', 'worker-bin'), 'gh')
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: ghCli, login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: ghCli, login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program('gh-broken', 'return 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh('gh-reader', 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program('gh-outsider', `const args = argv.join(' ')
if (args === 'api user') { console.log('{"login":"Agent-Bot","id":7}'); return 0 }
console.error('HTTP 404')
return 1`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program('gh-anonymous', `console.log('{}')`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: larkCli, appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
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
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: larkCli, appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot', name: 'Widgets Bot' })
  })
})
