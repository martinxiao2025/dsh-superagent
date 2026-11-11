/** 按来源记录探测仓库、项目与账户 CLI，配置执行器环境与命令 shim，并跟踪初始化就绪状态。 */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import {
  SETUP_FIELDS, checkGithubAccount, checkGithubRepository, checkGitlabAccount, checkGitlabProject, hostOf,
  resolveFeishuSource, resolveGithubSource, resolveGitlabSource, workerProbe,
  type Deployment, type Machine, type Probe, type ResolvedSource,
} from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import { Commands } from '../infra/commands.ts'
import { repoDirectory, syncRepoWorkCopy } from '../code-repos/work.ts'
import { taskSources, type TaskSourceVerifyMeta } from '../task-sources/index.ts'
import { TaskRepoError } from '../task-sources/kind.ts'
import { LIMITS } from '../limits.ts'
import type { LarkCall } from '../task-sources/feishu-doc.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import type { SourceInstance } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { SetupError, type SetupProblem, type SourceCheck } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

/**
 * 比较两份设置里各来源记录的部署相关字段：记录 ID、类型、启用状态与 `SETUP_FIELDS` 列出的配置。
 * 新增、删除或启停记录同样会改变结果，因此都会触发重启，使来源循环按新记录重新启动。
 */
const setupMaterial = (settings: Settings) => JSON.stringify({
  sources: Object.entries(settings.sources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, record]) => [id, record.kind, record.enabled, (SETUP_FIELDS[record.kind] ?? []).map(key => record.config[key] ?? '')]),
  // 代码仓库也要出现在部署里：任务来源读取清单前需要同步工作副本，git 凭据按记录 ID 绑定。
  codeRepos: Object.entries(settings.codeRepos)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, record]) => [id, record.kind, record.enabled, (SETUP_FIELDS[record.kind] ?? []).map(key => record.config[key] ?? '')]),
})
export const setupChanged = (before: Settings | undefined, after: Settings): boolean => !before || setupMaterial(before) !== setupMaterial(after)
const checkPassed = (field: string, code: string, values: Record<string, string> = {}): SourceCheck => ({ field, ok: true, scope: 'check', code, values })
const checkFailed = (field: string, code: string, values: Record<string, string> = {}): SourceCheck => ({ field, ok: false, scope: 'check', code, values })
/** `SetupError` 保留初始化问题的原始文案；其他异常只把消息暴露到 `output`。 */
const checkThrown = (field: string, error: unknown): SourceCheck => error instanceof SetupError
  ? { field, ok: false, scope: 'setup', code: error.problem.code, values: error.problem.values }
  : checkFailed(field, 'checkFailed', { output: error instanceof Error ? error.message : String(error) })
/** 新增来源表单的字段级检查顺序；消息来源目前只有飞书。 */
const checkFields = (kind: string): string[] => kind === 'feishu' ? ['instanceUrl', 'cli'] : []
const checkName = (name: string): SourceCheck => {
  const value = name.trim()
  if (!value) return checkFailed('name', 'sourceNameRequired')
  if (value.length > LIMITS.sourceName) return checkFailed('name', 'sourceNameTooLong', { limit: String(LIMITS.sourceName) })
  if (/[\u0000-\u001f\u007f]/.test(value)) return checkFailed('name', 'sourceNameInvalid')
  return checkPassed('name', 'sourceNameOk', { name: value })
}
const checkId = (id: string, sources: SourceRegistry): SourceCheck => {
  if (!id) return checkPassed('id', 'sourceIdAuto')
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return checkFailed('id', 'sourceIdInvalid', { id })
  if (sources.record(id)) return checkFailed('id', 'sourceIdTaken', { id })
  return checkPassed('id', 'sourceIdOk', { id })
}

/**
 * 逐条来源记录探测 CLI，然后写入并应用执行器进程使用的隔离 git 和 shim 环境。
 * `Runtime` 在启动时运行它来把守编排就绪状态，而 `Settings` 用它校验账户变更、更新被阻止命令的 shim，并安排重启。
 * 单条记录失败只记录该记录的问题，不阻止其他记录或机器级环境初始化。
 */
export class Setup {
  private resolved?: Deployment
  /** 机器级初始化问题（状态目录、git、shim 写入）；来源记录的问题在 `sourceProblems` 中。 */
  problem?: SetupProblem
  /** 按记录 ID 索引的部署校验问题；重启后重新计算。 */
  sourceProblems: Readonly<Record<string, SetupProblem>> = {}
  /** 去除了执行器 shim 目录的 PATH，使宿主自身的 CLI 调用会调用真实二进制文件。 */
  private readonly path: string
  /** 指向隔离 git 配置和命令 shim 的、供智能体子进程使用的环境变量。 */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** 应用了智能体 git 变量、并从 PATH 中排除了执行器 shim 目录的宿主命令环境。 */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** 解析每条来源记录并应用执行器环境；记录级 `SetupError` 存入 `sourceProblems`，机器级问题存入 `problem`。 */
  async run(settings: Settings): Promise<boolean> {
    this.problem = undefined
    this.sourceProblems = {}
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.resolved = undefined
      this.problem = error.problem
      return false
    }
  }
  /** 触发重启以重新运行初始化；若初始化已健康且没有记录问题，则拒绝，以免打断运行中的分配。 */
  check(): void {
    if (this.configured() && !this.problem && !Object.keys(this.sourceProblems).length) throw new UserError('setupComplete')
    this.restart()
  }
  /** 将重启推迟到下一个宏任务，使当前 HTTP 或工具调用方先收到响应。 */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** 在保存前校验被修改来源块的 CLI，只忽略属于其他记录的问题。 */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    if (!block.startsWith('source:')) return
    const id = block.slice('source:'.length)
    const record = settings.sources[id]
    if (!record) return
    // 清空 CLI 是操作者的明确选择：记录会保留并在来源页以可读的问题暂停，保存本身不应被拒绝。
    if (!record.config.cli) return
    await this.resolveRecord(id, record, this.probe()).catch((error: unknown) => {
      if (!(error instanceof SetupError) || error.place === id) throw error
    })
  }
  /**
   * 对新增来源表单里的候选配置做字段级预检：真实运行 CLI、读取任务清单或知识库，但不写设置、不重启。
   * `field` 为 `all` 时先检查必填的项目名称，再按类型的关键字段依次检查；`id` 只做记录登记检查。
   */
  async checkSource(kind: string, config: unknown, field: string, sources: SourceRegistry,
    meta: { id?: string; name?: string } = {}): Promise<SourceCheck[]> {
    const spec = sources.kindByName(kind)
    if (!spec) return [checkFailed(field === 'all' ? 'kind' : field, 'sourceKindUnknown', { kind })]
    if (field === 'name') return [checkName(meta.name ?? '')]
    if (field === 'id') return [checkId(meta.id ?? '', sources)]
    const parsed = spec.schema.safeParse(config ?? {})
    if (!parsed.success) {
      return [checkFailed(field === 'all' ? 'kind' : field, 'sourceConfigInvalid', {
        detail: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') })]
    }
    if (field === 'kind') return [checkPassed('kind', 'sourceKindOk', { kind })]
    const data = parsed.data as Record<string, unknown>
    const fields = field === 'all'
      ? ['name', ...(meta.id === undefined ? [] : ['id']), ...checkFields(kind)]
      : [field]
    const probe = this.probe()
    const checks: SourceCheck[] = []
    for (const name of fields) {
      if (name === 'name') { checks.push(checkName(meta.name ?? '')); continue }
      if (name === 'id') { checks.push(checkId(meta.id ?? '', sources)); continue }
      checks.push(await this.checkField(kind, name, data, probe))
    }
    return checks
  }
  /**
   * 任务来源的字段级预检：由驱动真实读取清单或文档，但这里不写设置、不重启。
   * 面板「全部验证」先检查名称，再按驱动声明的非高级字段依次检查。
   */
  async checkTaskSource(kind: string, config: unknown, field: string, settings: Settings,
    meta: TaskSourceVerifyMeta = {}): Promise<SourceCheck[]> {
    return taskSources.verify(kind, config, field, { ...meta, taken: id => settings.taskSources[id] !== undefined }, {
      lark: async source => this.taskSourceLark(source, settings),
      syncRepo: async repo => this.taskSourceRepo(repo, settings),
    })
  }
  /** 任务来源选中的飞书记录必须存在且类型正确；解析失败同样视为不可用。 */
  private async taskSourceLark(source: string, settings: Settings): Promise<LarkCall | undefined> {
    const record = settings.sources[source]
    if (!record || record.kind !== 'feishu') return undefined
    const probe = this.probe()
    try {
      const resolved = await this.resolveRecord(source, record, probe)
      return resolved?.kind === 'feishu' ? this.larkCall(resolved, probe) : undefined
    } catch { return undefined }
  }
  /** 同步任务来源绑定的代码仓库并返回工作副本目录；失败按原因分类，供预检给出可读提示。 */
  private async taskSourceRepo(repo: string, settings: Settings): Promise<string> {
    const record = settings.codeRepos[repo]
    if (!record) throw new TaskRepoError('repoMissing', `代码仓库记录不存在：${repo}`)
    if (!record.enabled) throw new TaskRepoError('repoNotReady', `代码仓库记录已停用：${repo}`)
    const probe = this.probe()
    let resolved: ResolvedSource | undefined
    try { resolved = await this.resolveRecord(repo, record, probe) }
    catch (error) {
      throw new TaskRepoError('repoNotReady', `代码仓库记录尚未就绪：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!resolved || (resolved.kind !== 'github' && resolved.kind !== 'gitlab')) {
      throw new TaskRepoError('repoNotReady', `代码仓库记录尚未配置仓库：${repo}`)
    }
    // 记录可能刚创建、尚未进入启动时的部署，因此在按需解析后叠加到部署上再执行 git。
    const deployment: Deployment = { ...this.host.machine, sources: { ...(this.resolved?.sources ?? {}), [repo]: resolved } }
    const commands = new Commands(() => deployment, this.commandEnvironment, this.host.lifetime).scope(repo)
    try {
      await syncRepoWorkCopy({ commands, stateDir: this.host.machine.stateDir, repo, signal: this.host.lifetime })
    } catch (error) {
      throw new TaskRepoError('syncFailed', `代码仓库同步失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return repoDirectory(this.host.machine.stateDir, repo)
  }
  /** 按类型分派一次字段预检；`SetupError` 转成 `setup` 作用域的结果，其余异常转成可读失败。 */
  private async checkField(kind: string, field: string, config: Record<string, unknown>, probe: Probe): Promise<SourceCheck> {
    try {
      if (kind === 'github') return await this.checkGithub(field, config, probe)
      if (kind === 'gitlab') return await this.checkGitlab(field, config, probe)
      if (kind === 'feishu') return await this.checkFeishu(field, config, probe)
      return checkFailed(field, 'checkUnsupported', { field })
    } catch (error) { return checkThrown(field, error) }
  }
  private async checkGithub(field: string, config: Record<string, unknown>, probe: Probe): Promise<SourceCheck> {
    if (field === 'repository') {
      const access = await checkGithubRepository(this.host.machine, 'candidate', config, probe)
      return checkPassed(field, 'githubRepositoryOk', { repository: access.repository, login: access.account.login })
    }
    const account = await checkGithubAccount(this.host.machine, 'candidate', config, probe)
    if (field === 'instanceUrl') return checkPassed(field, 'githubInstanceOk', { host: hostOf(account.instanceUrl, this.host.machine.githubHost.get()) })
    if (field === 'cli') return checkPassed(field, 'githubAccountOk', { login: account.login })
    return checkFailed(field, 'checkUnsupported', { field })
  }
  private async checkGitlab(field: string, config: Record<string, unknown>, probe: Probe): Promise<SourceCheck> {
    if (field === 'project') {
      const access = await checkGitlabProject(this.host.machine, 'candidate', config, probe)
      return checkPassed(field, 'gitlabProjectOk', { project: access.project, login: access.account.login })
    }
    const account = await checkGitlabAccount(this.host.machine, 'candidate', config, probe)
    if (field === 'instanceUrl') return checkPassed(field, 'gitlabInstanceOk', { host: hostOf(account.instanceUrl, this.host.machine.gitlabHost.get()) })
    if (field === 'cli') return checkPassed(field, 'gitlabAccountOk', { login: account.login })
    return checkFailed(field, 'checkUnsupported', { field })
  }
  private async checkFeishu(field: string, config: Record<string, unknown>, probe: Probe): Promise<SourceCheck> {
    const resolved = await resolveFeishuSource(this.host.machine, 'candidate', config, probe)
    if (field === 'cli') return checkPassed(field, 'feishuAccountOk', { name: resolved.name })
    if (field === 'instanceUrl') return checkPassed(field, 'feishuInstanceOk', { host: hostOf(resolved.instanceUrl, 'feishu.cn') })
    return checkFailed(field, 'checkUnsupported', { field })
  }
  /** 用已解析飞书记录的 CLI 运行 OpenAPI 调用；返回 `data`，失败时带出 CLI 的错误消息。 */
  private larkCall(resolved: Extract<ResolvedSource, { kind: 'feishu' }>, probe: Probe): LarkCall {
    return async (args: string[]) => {
      const output = await probe([resolved.cli, ...args, '--as', 'bot', '--format', 'json'],
        { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' })
      const result = JSON.parse(output) as { ok: boolean; data: unknown; error?: { code?: number; message?: string } }
      if (!result.ok) throw new Error(`${result.error?.message ?? '飞书命令失败'}${result.error?.code ? ` (${result.error.code})` : ''}`)
      return result.data
    }
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** 按执行器 shell 运行它们的方式探测 CLI；以 `stateDir` 作为 `cwd`，因为即使在仓库克隆有效之前它也存在。 */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  /** 只验证一条记录；未知类型直接返回，因为它没有可运行的部署检查。 */
  private async resolveRecord(id: string, record: Pick<SourceInstance, 'kind' | 'config'>, probe: ReturnType<Setup['probe']>): Promise<ResolvedSource | undefined> {
    const { machine } = this.host
    switch (record.kind) {
      case 'github': return resolveGithubSource(machine, id, record.config, probe)
      case 'gitlab': return resolveGitlabSource(machine, id, record.config, probe)
      case 'feishu': return resolveFeishuSource(machine, id, record.config, probe)
      default: return undefined
    }
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const sources: Record<string, ResolvedSource> = {}
    const problems: Record<string, SetupProblem> = {}
    // 逐条独立解析：一条记录失败不影响其他记录，也不阻止机器级环境初始化。
    for (const [id, record] of Object.entries(settings.sources)) {
      if (!record.enabled) continue
      try {
        const resolved = await this.resolveRecord(id, record, probe)
        if (resolved) sources[id] = resolved
      } catch (error) {
        if (!(error instanceof SetupError)) throw error
        problems[id] = error.problem
        context.logger.warn('dsh-superagent leaves source %s out: %s', id, error.message)
      }
    }
    // 代码仓库也进入部署：git 凭据按记录 ID 绑定，任务来源同步工作副本时复用同一套命令入口。
    for (const [id, record] of Object.entries(settings.codeRepos)) {
      if (!record.enabled || sources[id]) continue
      try {
        const resolved = await this.resolveRecord(id, record, probe)
        if (resolved) sources[id] = resolved
      } catch (error) {
        if (!(error instanceof SetupError)) throw error
        problems[id] = error.problem
        context.logger.warn('dsh-superagent leaves code repo %s out: %s', id, error.message)
      }
    }
    this.sourceProblems = problems
    const resolved: Deployment = { ...machine, sources }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
