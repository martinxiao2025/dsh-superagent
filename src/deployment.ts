/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { spawnArgv } from './infra/commands.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** A drive-letter or UNC root as Windows writes it, or the POSIX root; a relative path starts with neither. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/
const absolute = (description: string) => s.string().pattern(ABSOLUTE_PATH).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** GitLab 项目可以位于多级命名空间；`project` 为空表示未启用该可选来源。 */
export const GitlabProjectSchema = z.object({
  project: z.string().trim().regex(/^([A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+)?$/, 'group/project').default(''),
  cli: z.string().trim().default('glab'),
})
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape), gitlab: Object.keys(GitlabProjectSchema.shape),
}

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
  gitlab?: GitlabProject
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
export interface GitlabProject { cli: string; project: string; projectId: number; login: string; id: number }

/** Extensions Windows appends to a bare command name, as `cmd` and `where` do; POSIX appends none. */
const EXTENSIONS: readonly string[] = process.platform === 'win32'
  ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : []
/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  // Windows separates with both `\` and `/`, and resolves a bare name to `gh.exe` or `gh.cmd`; POSIX separates with `/` only.
  if (/[\\/]/.test(name) && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const bases = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  const candidates = bases.flatMap(base => [base, ...(EXTENSIONS.length && !extname(base) ? EXTENSIONS.map(extension => base + extension) : [])])
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

/** A startup check: run `argv` and return its standard output, optionally under extra environment entries. */
export type Probe = (argv: string[], env?: Record<string, string>) => Promise<string>
/**
 * Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper
 * script reaches the real binary. PATH travels as a spawn environment entry because Windows has no `env` command.
 */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return (argv, env) => runAsWorker(subprocess, spawnArgv(argv[0]!, argv.slice(1)), cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    { PATH: path, ...env })
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Returns the first line of CLI output that parses as `schema`, skipping banners or warnings printed before the payload. */
function firstParsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  for (const line of text.split(/\r?\n/)) {
    const value = parsed(schema, line)
    if (value) return value
  }
  return undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const GitlabUser = z.object({ id: z.number().int().positive(), username: z.string().regex(/^[A-Za-z0-9_.-]+$/) })
const GitlabAccess = z.object({ access_level: z.number().int() })
const GitlabProject = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/),
  permissions: z.object({ project_access: GitlabAccess.nullable().optional(), group_access: GitlabAccess.nullable().optional() }).nullish(),
  namespace: z.object({ path: z.string() }).nullish(),
})
/**
 * 验证可选的 GitLab 账号：CLI 能读到用户，项目可读，并且项目或群组权限达到 Developer（30）以上。
 * 未填写 project 时返回 undefined，表示该可选来源关闭；其他失败抛出 SetupError，由 setup 只禁用 GitLab 源。
 */
export async function resolveGitlab(machine: Machine, config: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<GitlabProject | undefined> {
  const accounts = GitlabProjectSchema.parse(config ?? {})
  const requested = accounts.project
  if (!requested) return undefined
  if (!accounts.cli) throw new SetupError('gitlabCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }) }
  const user = parsed(GitlabUser, await probe([cli, 'api', 'user']).catch((error: unknown) => {
    throw new SetupError('gitlabCliSignedOut', { output: reason(error) })
  }))
  if (!user) throw new SetupError('gitlabNoAccount')
  // GitLab 的 REST 路径用 URL 编码的完整命名空间，因此多级 group/subgroup/project 也能读取。
  const access = parsed(GitlabProject, await probe([cli, 'api', `projects/${encodeURIComponent(requested)}`]).catch((error: unknown) => {
    throw new SetupError('gitlabProjectUnreadable', { account: user.username, project: requested, output: reason(error) })
  }))
  if (!access) throw new SetupError('gitlabProjectUnreported', { project: requested })
  const project = access.path_with_namespace
  const level = Math.max(access.permissions?.project_access?.access_level ?? 0, access.permissions?.group_access?.access_level ?? 0)
  if (level < 30) throw new SetupError('gitlabReadOnly', { account: user.username, project })
  return { cli, project, projectId: access.id, login: user.username, id: user.id }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe([cli, ...args],
    { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`. A CLI may print a
  // banner before its NDJSON, so the first line that is the bot payload is taken rather than the first line.
  const info = firstParsed(BotInfo, await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson'))
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
