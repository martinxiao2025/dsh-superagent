/** 插件配置，以及按来源记录解析仓库访问和智能体 CLI 身份。 */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { Volatile } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { spawnArgv } from './infra/commands.ts'
import { hostOf } from './infra/host.ts'
import { pathExtensions } from './infra/win32.ts'
import { SetupError } from './setup.ts'
// 已解析来源与部署形态的权威定义在零依赖叶子层；这里导入并具名再导出，保持既有导入路径不变。
// `RepoAuth` 与其 zod schema 都留在本文件：schema 属于配置层，叶子层只有它的类型形态。
import type { Deployment as DeploymentShape, Machine as MachineShape, ResolvedGithubSource, ResolvedGitlabSource,
  ResolvedFeishuSource, ResolvedSource } from './deployment-types.ts'
import { firstSource, isGithubSource, isGitlabSource, isFeishuSource, sourceOf } from './deployment-types.ts'
export type { ResolvedGithubSource, ResolvedGitlabSource, ResolvedFeishuSource, ResolvedSource }
export { firstSource, isGithubSource, isGitlabSource, isFeishuSource, sourceOf }

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** Windows 写法的盘符或 UNC 根路径，或 POSIX 根路径；相对路径两者都不以之开头。 */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/
const absolute = (description: string) => s.string().pattern(ABSOLUTE_PATH).description(`${description} Absolute path.`)
/** dsh-superagent 条目的插件配置。易变字段无需重启即可生效，因为 dsh-superagent 在每次使用时读取它们；修改 `stateDir` 会重新挂载插件。 */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
  commandTimeoutMs: s.number().min(LIMITS.commandTimeoutMs.min).max(LIMITS.commandTimeoutMs.max).step(1).default(90_000)
    .description('Time limit of one CLI command, in milliseconds.').volatile(),
  gitTimeoutMs: s.number().min(LIMITS.gitTimeoutMs.min).max(LIMITS.gitTimeoutMs.max).step(1).default(600_000)
    .description('Time limit of one git command (clone, fetch, merge), in milliseconds; larger than the CLI timeout because a first clone of a big repository takes minutes. A project\'s git timeout setting overrides this per command.').volatile(),
  githubCli: s.string().default('gh').description('GitHub CLI used when a GitHub code repository record leaves it empty.').volatile(),
  gitlabCli: s.string().default('glab').description('GitLab CLI used when a GitLab code repository record leaves it empty.').volatile(),
  githubHost: s.string().default('github.com').description('Host used for GitHub records that leave the instance address empty.').volatile(),
  gitlabHost: s.string().default('gitlab.com').description('Host used for GitLab records that leave the instance address empty.').volatile(),
  workspaceRetentionDays: s.number().min(LIMITS.workspaceRetentionDays.min).max(LIMITS.workspaceRetentionDays.max).step(1)
    .default(14).description('Days an ended ticket\'s execution workspace is kept before it is reclaimed; 0 disables reclaiming.')
    .volatile(),
  resetState: s.boolean().default(false)
    .description('Back up and clear the state directory before starting, then start from an empty baseline. Takes effect once per start.'),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine extends MachineShape {
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
  commandTimeoutMs: Volatile<number>
  gitTimeoutMs: Volatile<number>
  githubCli: Volatile<string>
  gitlabCli: Volatile<string>
  githubHost: Volatile<string>
  gitlabHost: Volatile<string>
  workspaceRetentionDays: Volatile<number>
}
export interface Deployment extends DeploymentShape {}
const MOVED: Record<string, string> = {
  repository: 'on each GitHub Source record', branchPrefix: 'in the prepare command of the Execution settings', github: 'on each GitHub Source record',
  feishu: 'on each Feishu Source record', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** 读取机器设置，并拒绝未知配置键（同时指明已弃用键迁移到了何处）。 */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, commandTimeoutMs, gitTimeoutMs, githubCli, gitlabCli, githubHost,
    gitlabHost, workspaceRetentionDays } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, commandTimeoutMs, gitTimeoutMs, githubCli, gitlabCli, githubHost,
    gitlabHost, workspaceRetentionDays }
}

/**
 * 来源实例地址：留空表示官方站点（github.com / gitlab.com / 飞书开放平台）。
 * 自建 GitLab 或 GitHub Enterprise 填站点根地址，例如 `https://git.example.com`；路径和查询串会被拒绝，
 * 因为该字段同时用于 `GH_HOST` / `GITLAB_HOST` 和网页链接的基地址。
 */
const instanceUrl = () => z.string().trim().default('').refine(value => {
  if (!value) return true
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/' && !url.search && !url.hash
  } catch { return false }
}, 'the site root, such as https://git.example.com')
/**
 * 代码仓库的远端认证方式：`https` 使用智能体 CLI 的凭据助手，`ssh` 使用本机 SSH key，
 * 后者不依赖 `gh` / `glab`，适合运维者已经配置好 SSH 的私有仓库。
 */
export const RepoAuthSchema = z.enum(['https', 'ssh'])
export type RepoAuth = z.infer<typeof RepoAuthSchema>
/** 自定义远端地址：允许 `https://`、`ssh://` 或 `user@host:path`，但拒绝内嵌凭据。 */
const remoteAddress = () => z.string().trim().max(2000).default('').refine(value => !value || (
  !/[^/@\s]+:[^/@\s]+@/.test(value) && /^(?:https?:\/\/|ssh:\/\/|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:)/.test(value)
), 'an https://, ssh:// or user@host:path address without embedded credentials')
/** SSH 私钥路径；留空时使用 ssh-agent、`~/.ssh/config` 或默认密钥。 */
const sshKeyPath = () => z.string().trim().max(1000).default('')
/** GitHub 来源记录的配置：仓库、CLI、实例地址与远端认证方式。 */
export const GithubSourceSchema = z.object({
  instanceUrl: instanceUrl(),
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
  auth: RepoAuthSchema.default('https'),
  remote: remoteAddress(),
  sshKey: sshKeyPath(),
})
/** 飞书来源记录的配置：机器人 CLI 与实例地址。 */
export const FeishuSourceSchema = z.object({ instanceUrl: instanceUrl(), cli: z.string().trim().default('') })
/** GitLab 项目可以位于多级命名空间；`project` 为空表示记录尚未配置项目。 */
export const GitlabSourceSchema = z.object({
  instanceUrl: instanceUrl(),
  project: z.string().trim().regex(/^([A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+)?$/, 'group/project').default(''),
  cli: z.string().trim().default(''),
  auth: RepoAuthSchema.default('https'),
  remote: remoteAddress(),
  sshKey: sshKeyPath(),
})
/**
 * 影响部署解析、且修改后需要重启的来源配置键（按适配器类型）。
 * 记录 ID、类型和启用状态由 `setupChanged` 单独比较，因此新增、删除或启停记录也会触发重启。
 */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  github: ['instanceUrl', 'repository', 'cli', 'auth', 'remote', 'sshKey'],
  feishu: ['instanceUrl', 'cli'],
  gitlab: ['instanceUrl', 'project', 'cli', 'auth', 'remote', 'sshKey'],
}

// ResolvedGithubSource / ResolvedGitlabSource / ResolvedFeishuSource / ResolvedSource / Deployment
// 与三个守卫函数都已上移到 ./deployment-types.ts 并在文件头具名再导出，保持既有导入路径不变。
/** 实例地址的站点主机名；留空时使用 `fallback`。定义在 `infra/host.ts`（零依赖叶子），此处具名再导出保持既有导入路径。 */
export { hostOf } from './infra/host.ts'
/** 实例地址的网页基地址；留空时使用 `fallback`。 */
export const webBaseOf = (instanceUrl: string, fallback: string): string => instanceUrl || fallback
/** 探测 CLI 时只在自建实例上设置 `GH_HOST` / `GITLAB_HOST`。 */
const hostVariable = (name: string, instanceUrl: string): Record<string, string> | undefined =>
  instanceUrl ? { [name]: hostOf(instanceUrl, '') } : undefined

/** 把命令名或绝对路径解析为可执行文件，忽略工作单元垫片目录。 */
export function executable(name: string, path: string, exclude?: string): string {
  // Windows 用 `\` 和 `/` 两种分隔符，并把裸名字解析为 `gh.exe` 或 `gh.cmd`；POSIX 只用 `/` 分隔。
  if (/[\\/]/.test(name) && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const extensions = pathExtensions()
  const bases = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  const candidates = bases.flatMap(base => [base, ...(extensions.length && !extname(base) ? extensions.map(extension => base + extension) : [])])
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* 此处没有可执行文件；尝试下一个 PATH 目录。 */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

/** 一次启动检查：运行 `argv` 并返回其标准输出，可选地在额外的环境变量项下运行。 */
export type Probe = (argv: string[], env?: Record<string, string>) => Promise<string>
/**
 * 通过 DSH 的工作单元子进程服务运行启动检查，同时从 PATH 中移除工作单元垫片，使 `gh` 包装脚本
 * 到达真实二进制。PATH 作为 spawn 环境项传递，因为 Windows 没有 `env` 命令。
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
  try { value = JSON.parse(text) } catch { return undefined /* 非 JSON 输出；由调用方暴露配置失败。 */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** 返回 CLI 输出中第一个能按 `schema` 解析的行，跳过负载之前打印的横幅或警告。 */
function firstParsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  for (const line of text.split(/\r?\n/)) {
    const value = parsed(schema, line)
    if (value) return value
  }
  return undefined
}
/** 一条 GitHub 记录的 CLI 身份；`noreply` 是该账户提交时使用的邮箱。 */
export interface GithubAccount { cli: string; instanceUrl: string; login: string; noreply: string }
const GithubAccountSchema = GithubSourceSchema.pick({ instanceUrl: true, cli: true })
/** 只验证 CLI 身份与登录状态，不要求仓库字段，供「凭据」与「实例地址」的字段级预检使用。 */
async function githubAccount(machine: Machine, id: string, accounts: { instanceUrl: string; cli: string }, probe: Probe, path: string): Promise<GithubAccount> {
  // 记录未指定 CLI 时使用宿主默认值；两者都为空才视为未配置。
  const configured = accounts.cli || machine.githubCli.get()
  if (!configured) throw new SetupError('agentCliUnset', {}, id)
  let cli: string
  try { cli = executable(configured, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }, id) }
  const env = hostVariable('GH_HOST', accounts.instanceUrl)
  const text = await probe([cli, 'api', 'user'], env).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }, id) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount', {}, id)
  return { cli, instanceUrl: accounts.instanceUrl, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` }
}
/** 只验证 GitHub CLI 身份；预检不写设置，因此用调用方提供的配置。 */
export async function checkGithubAccount(machine: Machine, id: string, github: unknown, probe: Probe,
  path = process.env.PATH ?? ''): Promise<GithubAccount> {
  return githubAccount(machine, id, GithubAccountSchema.parse(github ?? {}), probe, path)
}
export interface GithubRepositoryAccess { account: GithubAccount; repository: string }
/**
 * 验证一条 GitHub 记录的 CLI 身份及对配置仓库的推送权限。
 * 自建 GitHub Enterprise 通过 `GH_HOST` 让 `gh` 访问该实例；失败以记录 ID 为 `place` 抛出 `SetupError`。
 */
export async function checkGithubRepository(machine: Machine, id: string, github: unknown, probe: Probe,
  path = process.env.PATH ?? ''): Promise<GithubRepositoryAccess> {
  const accounts = GithubSourceSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset', {}, id)
  const account = await githubAccount(machine, id, accounts, probe, path)
  // 使用 GitHub 返回的规范仓库名，使改名后的仓库也能匹配收到的通知。
  const access = parsed(RepositoryAccess, await probe([account.cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}'],
    hostVariable('GH_HOST', accounts.instanceUrl)).catch((error: unknown) => {
      throw new SetupError('repositoryUnreadable', { account: account.login, repository: remote, output: reason(error) }, id)
    }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote }, id)
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: account.login, repository: access.name }, id)
  return { account, repository: access.name }
}
/** 完整解析一条 GitHub 记录；字段级预检复用同一组探测，避免两套口径。 */
export async function resolveGithubSource(machine: Machine, id: string, github: unknown, probe: Probe,
  path = process.env.PATH ?? ''): Promise<ResolvedGithubSource> {
  const config = GithubSourceSchema.parse(github ?? {})
  // SSH 模式只依赖本机 SSH key，不运行 gh；仓库是否存在与可用性由字段预检和同步时探测。
  if (config.auth === 'ssh') {
    if (!config.repository && !config.remote) throw new SetupError('repositoryUnset', {}, id)
    return { id, kind: 'github', instanceUrl: config.instanceUrl, cli: config.cli, repository: config.repository,
      login: '', noreply: '', auth: 'ssh', remote: config.remote, sshKey: config.sshKey }
  }
  const { account, repository } = await checkGithubRepository(machine, id, config, probe, path)
  return { id, kind: 'github', instanceUrl: account.instanceUrl, cli: account.cli, repository, login: account.login, noreply: account.noreply,
    auth: 'https', remote: config.remote, sshKey: config.sshKey }
}

const GitlabUser = z.object({ id: z.number().int().positive(), username: z.string().regex(/^[A-Za-z0-9_.-]+$/) })
const GitlabAccess = z.object({ access_level: z.number().int() })
const GitlabProject = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/),
  permissions: z.object({ project_access: GitlabAccess.nullable().optional(), group_access: GitlabAccess.nullable().optional() }).nullish(),
  namespace: z.object({ path: z.string() }).nullish(),
})
/** 一条 GitLab 记录的 CLI 身份。 */
export interface GitlabAccount { cli: string; instanceUrl: string; login: string; userId: number }
const GitlabAccountSchema = GitlabSourceSchema.pick({ instanceUrl: true, cli: true })
async function gitlabAccount(machine: Machine, id: string, accounts: { instanceUrl: string; cli: string }, probe: Probe, path: string): Promise<GitlabAccount> {
  // 记录未指定 CLI 时使用宿主默认值；两者都为空才视为未配置。
  const configured = accounts.cli || machine.gitlabCli.get()
  if (!configured) throw new SetupError('gitlabCliUnset', {}, id)
  let cli: string
  try { cli = executable(configured, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }, id) }
  const env = hostVariable('GITLAB_HOST', accounts.instanceUrl)
  const user = parsed(GitlabUser, await probe([cli, 'api', 'user'], env).catch((error: unknown) => {
    throw new SetupError('gitlabCliSignedOut', { output: reason(error) }, id)
  }))
  if (!user) throw new SetupError('gitlabNoAccount', {}, id)
  return { cli, instanceUrl: accounts.instanceUrl, login: user.username, userId: user.id }
}
/** 只验证 GitLab CLI 身份，不要求项目字段。 */
export async function checkGitlabAccount(machine: Machine, id: string, config: unknown, probe: Probe,
  path = process.env.PATH ?? ''): Promise<GitlabAccount> {
  return gitlabAccount(machine, id, GitlabAccountSchema.parse(config ?? {}), probe, path)
}
export interface GitlabProjectAccess { account: GitlabAccount; project: string; projectId: number }
/** 验证 GitLab 项目可读，并且项目或群组权限达到 Developer（30）以上。 */
export async function checkGitlabProject(machine: Machine, id: string, config: unknown, probe: Probe,
  path = process.env.PATH ?? ''): Promise<GitlabProjectAccess> {
  const accounts = GitlabSourceSchema.parse(config ?? {})
  const requested = accounts.project
  if (!requested) throw new SetupError('gitlabProjectUnset', {}, id)
  const account = await gitlabAccount(machine, id, accounts, probe, path)
  // GitLab 的 REST 路径用 URL 编码的完整命名空间，因此多级 group/subgroup/project 也能读取。
  const access = parsed(GitlabProject, await probe([account.cli, 'api', `projects/${encodeURIComponent(requested)}`],
    hostVariable('GITLAB_HOST', accounts.instanceUrl)).catch((error: unknown) => {
      throw new SetupError('gitlabProjectUnreadable', { account: account.login, project: requested, output: reason(error) }, id)
    }))
  if (!access) throw new SetupError('gitlabProjectUnreported', { project: requested }, id)
  const project = access.path_with_namespace
  const level = Math.max(access.permissions?.project_access?.access_level ?? 0, access.permissions?.group_access?.access_level ?? 0)
  if (level < 30) throw new SetupError('gitlabReadOnly', { account: account.login, project }, id)
  return { account, project, projectId: access.id }
}
/**
 * 完整解析一条 GitLab 记录：CLI 能读到用户，项目可读，并且项目或群组权限达到 Developer（30）以上。
 * 自建 GitLab 通过 `GITLAB_HOST` 让 `glab` 访问该实例；失败以记录 ID 为 `place` 抛出 `SetupError`。
 */
export async function resolveGitlabSource(machine: Machine, id: string, config: unknown, probe: Probe,
  path = process.env.PATH ?? ''): Promise<ResolvedGitlabSource> {
  const parsed = GitlabSourceSchema.parse(config ?? {})
  // 与 GitHub 一致：SSH 模式不运行 glab，远端访问权限留给预检与同步探测。
  if (parsed.auth === 'ssh') {
    if (!parsed.project && !parsed.remote) throw new SetupError('gitlabProjectUnset', {}, id)
    return { id, kind: 'gitlab', instanceUrl: parsed.instanceUrl, cli: parsed.cli, project: parsed.project, projectId: 0,
      login: '', userId: 0, auth: 'ssh', remote: parsed.remote, sshKey: parsed.sshKey }
  }
  const { account, project, projectId } = await checkGitlabProject(machine, id, parsed, probe, path)
  return { id, kind: 'gitlab', instanceUrl: account.instanceUrl, cli: account.cli, project, projectId, login: account.login, userId: account.userId,
    auth: 'https', remote: parsed.remote, sshKey: parsed.sshKey }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * 校验一条飞书来源记录的 CLI 已以机器人身份认证，并受限在严格模式 `bot` 下。
 * 工作单元会以 `lark-cli` 调用该 CLI，若 CLI 同时允许用户身份，工作单元就可能以该用户身份行动。
 */
export async function resolveFeishuSource(machine: Machine, id: string, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<ResolvedFeishuSource> {
  const { cli: name, instanceUrl: host } = FeishuSourceSchema.parse(feishu ?? {})
  if (!name) throw new SetupError('feishuCliUnset', {}, id)
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }, id) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe([cli, ...args],
    { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' }).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp', {}, id))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }, id))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }, id))
  // `--format json` 只解包 `data`，而此端点把负载放在 `bot` 下。CLI 可能在 NDJSON 前打印
  // 横幅，因此取第一行属于机器人负载的内容，而不是真正的第一行。
  const info = firstParsed(BotInfo, await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson'))
  if (!info) return fail(new SetupError('feishuNoBot', {}, id))
  return { id, kind: 'feishu', instanceUrl: host, cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
