/** 子进程封装，用于在部署配置的账号下运行 gh、lark-cli 和 git 命令。 */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Deployment, ResolvedFeishuSource, ResolvedGithubSource, ResolvedGitlabSource, ResolvedSource } from '../deployment.ts'
import { hostOf } from '../deployment.ts'
import { redact } from './text.ts'

const exec = promisify(execFile)
/** 未配置 `commandTimeoutMs` 时的默认命令超时；与配置 schema 的默认值保持一致。 */
const TIMEOUT_MS = 90_000
/** Windows 上的 CLI 可能被安装为批处理文件，而 Windows 无法在无 shell 的情况下启动它。 */
const BATCH = /\.(?:cmd|bat)$/i
/** 为 `cmd.exe /c` 命令行引用一个参数，按 cmd 的预期把内嵌引号加倍。 */
const cmdQuote = (argument: string): string => `"${argument.replaceAll('"', '""')}"`
/**
 * 子进程运行 `program` 所需的 argv：`.cmd` 或 `.bat` 形式的 CLI（用于选择账号的包装脚本）经由 `cmd.exe` 执行，
 * 因为 Windows 无法直接启动批处理文件。
 */
export function spawnArgv(program: string, args: readonly string[]): string[] {
  if (process.platform !== 'win32' || !BATCH.test(program)) return [program, ...args]
  return [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', [program, ...args].map(cmdQuote).join(' ')]
}
/**
 * `program` 的完整启动调用，供自行启动进程的调用方使用：批处理文件作为一个带引号的命令交给 `cmd.exe`，
 * 该命令必须以原样传递，因为 cmd 会在 `/s /c` 之后剥掉一层引号，而 Node 自身的参数转义会破坏内层引用。
 */
export function spawnCommand(program: string, args: readonly string[]): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (process.platform !== 'win32' || !BATCH.test(program)) return { file: program, args: [...args], windowsVerbatimArguments: false }
  const command = [program, ...args].map(cmdQuote).join(' ')
  return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true }
}
/**
 * Commands 在 CLI 调用失败时抛出的错误，保留 stderr 诊断信息、API 错误码和退出状态，但不会回显命令参数。
 * 来源渠道和轮询器会检查其 code，以区分已删除的会话和可重试的失败。
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
/** 从失败的子进程中提取脱敏后的错误，不回显可能包含消息正文的 argv。 */
export function commandError(error: unknown, program = 'command', timeoutMs = TIMEOUT_MS): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* 非 JSON 的 CLI 诊断信息会在下方保留。 */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(redact(`${parsed.error.message}${code ? ` (${code})` : ''}`), code, exitCode)
    // `gh` 在 HTTP 错误（如 `gh: Not Found (HTTP 404)`）和 `gh: HTTP 304` 时会以非零状态退出，ETag 轮询依赖后者。
    if (stderr) return new CliError(redact(stderr.slice(0, 2000)), Number(stderr.match(/\bHTTP (\d{3})\b/)?.[1]) || undefined, exitCode)
  }
  return new CliError(`${basename(program)} ${ended(error, timeoutMs)}`, undefined, exitCode)
}
function ended(error: unknown, timeoutMs = TIMEOUT_MS): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` 超时会用 SIGTERM 终止进程，并设置 `killed: true`。
  if (killed && signal === 'SIGTERM') return `timed out after ${timeoutMs / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** 按 schema 解析数组元素，跳过无效项并递增 `tally.skipped`。 */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** 重写飞书错误 232011（机器人不在会话中），并附上修复指引。 */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}
/**
 * 使用部署账号凭据、超时和中止信号执行 gh、lark-cli 和 git 子进程。
 * 每条来源记录通过 `scope(记录ID)` 得到自己的命令：仓库、项目与 CLI 都取自该记录解析出的来源。
 * 把 GitHub API 调用限制在记录配置的仓库内，并将 CLI 失败转换为 CliError 实例，供 Sources、MasterAssessor、Outbox 和 Settings 使用。
 */
export class Commands {
  /** 每条记录的绑定只创建一次，使同一来源的调用方共享同一个命令对象。 */
  private readonly scopes = new Map<string, Commands>()
  /**
   * @param resolved - 返回已解析的部署配置；配置尚未完成时抛出异常。
   * @param environment - 覆盖每条命令所用 `process.env` 的变量（例如隔离的 git 设置）。
   * @param record - 绑定的来源记录 ID；未绑定时只有 `run` 和 `git` 可用。
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal,
    private readonly record?: string) {}
  get deployment(): Deployment { return this.resolved() }
  /**
   * 绑定到来源记录 `record` 的命令；未知或未解析的记录在取用仓库/项目/CLI 时报错。
   * 已经绑定到同一记录时返回自身，其余记录复用同一个绑定，使重复调用不会丢掉替身对象上的状态。
   */
  scope(record: string): Commands {
    if (this.record === record) return this
    const existing = this.scopes.get(record)
    if (existing) return existing
    const scoped = new Commands(this.resolved, this.environment, this.signal, record)
    this.scopes.set(record, scoped)
    return scoped
  }
  /** 这条命令绑定的记录解析出的来源；未绑定或记录尚未解析时为 undefined。 */
  get source(): ResolvedSource | undefined { return this.record === undefined ? undefined : this.deployment.sources[this.record] }
  get github(): ResolvedGithubSource {
    const source = this.source
    if (source?.kind !== 'github') throw new Error(this.record === undefined ? 'No GitHub Source is selected' : `Source ${this.record} is not a GitHub Source`)
    return source
  }
  get gitlab(): ResolvedGitlabSource | undefined { const source = this.source; return source?.kind === 'gitlab' ? source : undefined }
  get feishu(): ResolvedFeishuSource | undefined { const source = this.source; return source?.kind === 'feishu' ? source : undefined }
  get repository(): string { return this.github.repository }
  withSignal(signal?: AbortSignal): Commands {
    return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal]), this.record) : this
  }
  async run(program: string, args: string[], cwd?: string): Promise<string> {
    const timeoutMs = this.deployment.commandTimeoutMs.get()
    try {
      const { file, args: argv, windowsVerbatimArguments } = spawnCommand(program, args)
      const { stdout } = await exec(file, argv, { cwd, signal: this.signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsVerbatimArguments,
        env: { ...process.env, ...this.environment, ...this.hostEnvironment(), GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      return stdout
    } catch (error) { throw commandError(error, program, timeoutMs) }
  }
  /** 企业实例的 `gh` / `glab` 调用需要以 `GH_HOST` / `GITLAB_HOST` 路由到该站点；官方站点不设置，保持默认行为。 */
  private hostEnvironment(): Record<string, string> {
    const source = this.source
    if (!source?.instanceUrl) return {}
    if (source.kind === 'github') return { GH_HOST: hostOf(source.instanceUrl, '') }
    if (source.kind === 'gitlab') return { GITLAB_HOST: hostOf(source.instanceUrl, '') }
    return {}
  }
  /** 运行智能体的 GitHub CLI 并解析其 JSON 输出；调用方应优先使用 `api`，它会限制在配置的仓库内并校验输出。 */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.github.cli, args)) as T }
  /**
   * 在配置的仓库内的某个路径上调用 GitHub API：提供 schema 时校验 JSON 输出，
   * 省略时返回原始 CLI 输出（例如原始文件或 `--include` 响应头）。
   * @throws 失败时抛出 CliError，其 `code` 为 GitHub 的 HTTP 状态码。
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.github.cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** 在配置的仓库内获取 GitHub API 列表的全部分页，跳过未通过 schema 校验的项。 */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  /** 运行智能体的 GitLab CLI 并解析其 JSON 输出；优先使用 `gitlabApi`，它会限制项目并校验输出。 */
  async glab<T>(args: string[]): Promise<T> {
    const gitlab = this.gitlab
    if (!gitlab) throw new Error('The GitLab Source has no working CLI')
    return JSON.parse(await this.run(gitlab.cli, args)) as T
  }
  /**
   * 在配置的项目内调用 GitLab API：提供 schema 时校验 JSON 输出，
   * 省略时返回原始 CLI 输出。
   * @throws 失败时抛出 CliError，其 `code` 为 GitLab 的 HTTP 状态码。
   */
  async gitlabApi<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async gitlabApi(path: string, ...flags: string[]): Promise<string>
  async gitlabApi<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    const gitlab = this.gitlab
    if (!gitlab) throw new Error('The GitLab Source has no working CLI')
    if (typeof schema === 'string') return this.run(gitlab.cli, ['api', this.gitlabPath(schema, gitlab), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.glab(['api', this.gitlabPath(path, gitlab), ...flags]))
  }
  /** 使用显式的 `per_page=100&page=N` 获取 GitLab API 列表的全部分页，遇到第一个不满页即停止。 */
  async gitlabPages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; ; page += 1) {
      const separator = path.includes('?') ? '&' : '?'
      const listed = await this.gitlabApi(z.array(z.unknown()), `${path}${separator}per_page=100&page=${page}`)
      out.push(...validItems(item, listed, tally))
      if (listed.length < 100) break
    }
    return out
  }
  /** GitLab REST 路径可以使用 URL 编码的命名空间或数字项目 id，但不得超出配置的项目范围。 */
  private gitlabPath(path: string, gitlab: { project: string; projectId: number }): string {
    const bases = [`projects/${encodeURIComponent(gitlab.project)}`, `projects/${gitlab.projectId}`]
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    const inside = bases.some(base => path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`))
    if (outside || !inside) throw new Error('GitLab calls are restricted to the configured project')
    return path
  }
  /**
   * 运行飞书机器人的 `lark-cli` 并返回 JSON 的 `data` 负载。
   * @throws 失败时抛出带飞书错误码的 CliError（机器人不在会话中时重写 232011）。
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** 在 PATH 上使用智能体隔离的 git 环境和凭据助手运行 `git`。 */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}
