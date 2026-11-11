/** 按来源记录探测仓库、项目与账户 CLI，配置执行器环境与命令 shim，并跟踪初始化就绪状态。 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
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
import { probeRemote, remoteOf, sshKeyFile, type GitAuth } from '../code-repos/sync.ts'
import { codeRepoType } from '../code-repos/types.ts'
import { repositoryOfRemote } from '../code-repos/kind.ts'
import { taskSources, type TaskSourceVerifyMeta } from '../task-sources/index.ts'
import { TaskRepoError } from '../task-sources/kind.ts'
import { LIMITS } from '../limits.ts'
import { projectRepoId, type ProjectRepo } from '../projects/kind.ts'
import type { FeishuWikiApi } from '../task-sources/feishu-api.ts'
import type { FeishuImApi } from '../task-sources/feishu-im-api.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import type { SourceInstance } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { SetupError, type SetupProblem, type SourceCheck } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  /** 按飞书凭据 ID 取知识库读取能力；凭据未安装或材料不可用时返回 undefined。 */
  feishuWiki?(credential: string): Promise<FeishuWikiApi | undefined>
  /** 按飞书凭据 ID 取群消息读取能力；凭据未安装或材料不可用时返回 undefined。 */
  feishuIm?(credential: string): Promise<FeishuImApi | undefined>
  /** 只读取 Git 凭据的认证方式与账号名，不接触材料；用于解析项目仓库。 */
  gitCredential?(id: string): { kind: 'ssh' | 'https'; username: string } | undefined
  /** 按 Git 凭据 ID 取一次同步使用的材料；未安装时返回 undefined。 */
  gitAuth?(id: string): GitAuth | undefined
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
  // 项目仓库进入部署：每个项目把自己的仓库配置解析成来源，Git 凭据随项目保存。
  projects: Object.entries(settings.projects)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, project]) => [id, project.enabled, project.codeRepo.kind,
      (SETUP_FIELDS[project.codeRepo.kind] ?? []).map(key => project.codeRepo.config[key] ?? ''), project.gitCredential]),
})
export const setupChanged = (before: Settings | undefined, after: Settings): boolean => !before || setupMaterial(before) !== setupMaterial(after)
const checkPassed = (field: string, code: string, values: Record<string, string> = {}): SourceCheck => ({ field, ok: true, scope: 'check', code, values })
const checkFailed = (field: string, code: string, values: Record<string, string> = {}): SourceCheck => ({ field, ok: false, scope: 'check', code, values })
/**
 * 按候选配置与 Git 凭据解析仓库远端：凭据决定认证方式；未绑定时沿用配置里的 auth 与 SSH key，
 * 与项目保存后的解析保持同一套规则。
 */
const resolveCodeRepoRemote = (kind: string, config: Record<string, unknown>,
  credential: { kind: 'ssh' | 'https'; username: string } | undefined, credentialAuth: GitAuth | undefined,
  hosts: { github?: string; gitlab?: string }): { remote: string; credentialAuth: GitAuth | undefined; key: string } => {
  const auth = credential?.kind ?? (config.auth === 'ssh' ? 'ssh' as const : 'https' as const)
  const source = kind === 'github'
    ? { kind: 'github' as const, instanceUrl: String(config.instanceUrl ?? ''), repository: String(config.repository ?? ''),
      auth, remote: String(config.remote ?? '') }
    : { kind: 'gitlab' as const, instanceUrl: String(config.instanceUrl ?? ''), project: String(config.project ?? ''),
      auth, remote: String(config.remote ?? '') }
  return { remote: remoteOf(source, '', hosts), credentialAuth, key: String(config.sshKey ?? '') }
}
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
const checkId = (id: string, sources: { record(id: string): unknown }): SourceCheck => {
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
   * 仓库与飞书凭据由项目提供，这里注入到候选配置后再交给驱动。
   */
  async checkTaskSource(kind: string, config: unknown, field: string, meta: TaskSourceVerifyMeta & {
    feishuCredential?: string
    projectId?: string
    repo?: ProjectRepo
    gitCredential?: string
  } = {}): Promise<SourceCheck[]> {
    const driver = taskSources.kind(kind)
    const repoId = projectRepoId(meta.projectId || 'candidate')
    const injected: Record<string, unknown> = {}
    if (driver?.fields.some(item => item.key === 'repo')) injected.repo = repoId
    if (driver?.fields.some(item => item.key === 'feishuCredential')) injected.feishuCredential = meta.feishuCredential ?? ''
    const merged = config && typeof config === 'object'
      ? { ...config as Record<string, unknown>, ...injected } : injected
    return taskSources.verify(kind, merged, field, {}, {
      feishu: async credential => this.host.feishuWiki?.(credential) ?? undefined,
      feishuIm: async credential => this.host.feishuIm?.(credential) ?? undefined,
      syncRepo: async () => this.projectRepo(repoId, meta.repo, meta.gitCredential),
    })
  }
  /**
   * 向导分支选择：按候选配置与 Git 凭据真实 `ls-remote`，返回分支列表与默认分支；
   * 空仓库返回空列表。配置无效或远端不可达时抛错，由面板直接展示原因。
   */
  async listCodeRepoBranches(kind: string, config: unknown,
    gitCredential = ''): Promise<{ remote: string; branches: string[]; defaultBranch: string }> {
    const type = codeRepoType(kind)
    if (!type) throw new Error(`未知的代码仓库类型：${kind}`)
    const parsed = type.schema.safeParse(config ?? {})
    if (!parsed.success) throw new Error(`仓库配置无效：${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`)
    const { remote, credentialAuth, key } = resolveCodeRepoRemote(kind, parsed.data as Record<string, unknown>,
      gitCredential ? this.host.gitCredential?.(gitCredential) : undefined, gitCredential ? this.host.gitAuth?.(gitCredential) : undefined,
      { github: this.host.machine.githubHost.get(), gitlab: this.host.machine.gitlabHost.get() })
    const refs = await probeRemote(this.probe(), remote, gitCredential ? '' : key, credentialAuth)
    return { remote, branches: refs.branches, defaultBranch: refs.defaultBranch }
  }
  /**
   * 代码仓库的字段级预检：优先使用项目选择的 Git 凭据探测远端；
   * 未选择凭据时沿用 gh/glab 或本机 SSH key，保持无需凭据的既有用法。
   */
  async checkCodeRepo(kind: string, config: unknown, field: string,
    meta: { gitCredential?: string } = {}): Promise<SourceCheck[]> {
    const type = codeRepoType(kind)
    if (!type) return [checkFailed(field === 'all' ? 'kind' : field, 'sourceKindUnknown', { kind })]
    const parsed = type.schema.safeParse(config ?? {})
    if (!parsed.success) {
      return [checkFailed(field === 'all' ? 'kind' : field, 'sourceConfigInvalid', {
        detail: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') })]
    }
    if (field === 'kind') return [checkPassed('kind', 'sourceKindOk', { kind })]
    const data = parsed.data as Record<string, unknown>
    const injected = meta.gitCredential ? ['gitCredential'] : []
    const fields = field === 'all'
      ? [...type.checkFields.filter(name => name !== 'auth' && name !== 'sshKey'), ...injected]
      : [field]
    const probe = this.probe()
    const checks: SourceCheck[] = []
    for (const name of fields) checks.push(await this.checkCodeRepoField(kind, name, data, probe, meta.gitCredential))
    return checks
  }
  /** 单个代码仓库字段：有 Git 凭据时真实探测远端，否则沿用 SSH key 或 gh/glab 检查。 */
  private async checkCodeRepoField(kind: string, field: string, config: Record<string, unknown>, probe: Probe,
    gitCredential = ''): Promise<SourceCheck> {
    try {
      const credential = gitCredential ? this.host.gitCredential?.(gitCredential) : undefined
      const credentialAuth = gitCredential ? this.host.gitAuth?.(gitCredential) : undefined
      const auth = credential?.kind ?? (config.auth === 'ssh' ? 'ssh' as const : 'https' as const)
      const defaultHost = kind === 'gitlab' ? this.host.machine.gitlabHost.get() : this.host.machine.githubHost.get()
      const host = hostOf(String(config.instanceUrl ?? ''), defaultHost)
      const { remote: resolved, key } = resolveCodeRepoRemote(kind, config, credential, credentialAuth,
        { github: this.host.machine.githubHost.get(), gitlab: this.host.machine.gitlabHost.get() })
      const remote = () => resolved
      if (field === 'gitCredential') {
        if (!gitCredential) return checkPassed(field, 'codeRepoCredentialAuto')
        if (!credential || !credentialAuth) return checkFailed(field, 'codeRepoCredentialUnusable', { credential: gitCredential })
        return checkPassed(field, 'codeRepoCredentialOk', { kind: auth, login: credential.username })
      }
      if (field === 'auth') return checkPassed(field, auth === 'ssh' ? 'codeRepoAuthSsh' : 'codeRepoAuthHttps')
      if (field === 'instanceUrl') {
        if (credential || auth === 'ssh') return checkPassed(field, 'codeRepoInstanceOk', { host })
        const account = kind === 'github'
          ? await checkGithubAccount(this.host.machine, 'candidate', config, probe)
          : await checkGitlabAccount(this.host.machine, 'candidate', config, probe)
        return checkPassed(field, 'codeRepoInstanceOk', { host: hostOf(account.instanceUrl, defaultHost) })
      }
      if (field === 'sshKey') {
        if (credential) return checkPassed(field, 'codeRepoKeyIdle', { key: '' })
        const file = sshKeyFile(key)
        if (!file) return checkPassed(field, 'codeRepoKeyDefault')
        if (!isAbsolute(file) || !existsSync(file) || !statSync(file).isFile()) return checkFailed(field, 'codeRepoKeyMissing', { key: file })
        if (auth !== 'ssh') return checkPassed(field, 'codeRepoKeyIdle', { key: file })
        try {
          await probeRemote(probe, remote(), key)
          return checkPassed(field, 'codeRepoKeyOk', { key: file })
        } catch (error) {
          return checkFailed(field, 'codeRepoKeyUnusable', { key: file, output: error instanceof Error ? error.message : String(error) })
        }
      }
      if (field === 'remote') {
        if (!String(config.remote ?? '').trim()) return checkPassed(field, 'codeRepoRemoteAuto', { remote: remote() })
        const refs = await probeRemote(probe, remote(), credential ? '' : key, credentialAuth)
        return refs.branches.length
          ? checkPassed(field, 'codeRepoAccessible', { remote: remote(), branches: String(refs.branches.length) })
          : checkFailed(field, 'codeRepoEmpty', { remote: remote() })
      }
      if (field === 'repository' || field === 'project') {
        if (credential || auth === 'ssh') {
          if (credential && !credentialAuth) return checkFailed(field, 'codeRepoCredentialUnusable', { credential: gitCredential })
          const refs = await probeRemote(probe, remote(), credential ? '' : key, credentialAuth)
          return refs.branches.length
            ? checkPassed(field, 'codeRepoAccessible', { remote: remote(), branches: String(refs.branches.length) })
            : checkFailed(field, 'codeRepoEmpty', { remote: remote() })
        }
        if (kind === 'github') {
          const access = await checkGithubRepository(this.host.machine, 'candidate', config, probe)
          return checkPassed(field, 'githubRepositoryOk', { repository: access.repository, login: access.account.login })
        }
        const access = await checkGitlabProject(this.host.machine, 'candidate', config, probe)
        return checkPassed(field, 'gitlabProjectOk', { project: access.project, login: access.account.login })
      }
      if (field === 'cli') {
        if (credential || auth === 'ssh') return checkPassed(field, 'codeRepoCliOptional')
        const account = kind === 'github'
          ? await checkGithubAccount(this.host.machine, 'candidate', config, probe)
          : await checkGitlabAccount(this.host.machine, 'candidate', config, probe)
        return checkPassed(field, kind === 'github' ? 'githubAccountOk' : 'gitlabAccountOk', { login: account.login })
      }
      return checkFailed(field, 'checkUnsupported', { field })
    } catch (error) { return checkThrown(field, error) }
  }
  /** 同步项目自己的代码仓库并返回工作副本目录；失败按原因分类，供预检给出可读提示。 */
  private async projectRepo(repoId: string, repo: ProjectRepo | undefined, gitCredential = ''): Promise<string> {
    if (!repo) throw new TaskRepoError('repoUnset', '项目尚未配置代码仓库')
    const probe = this.probe()
    let resolved: ResolvedSource
    try { resolved = await this.projectSource(repoId, repo, gitCredential, probe) }
    catch (error) {
      throw new TaskRepoError('repoNotReady', `代码仓库尚未就绪：${error instanceof Error ? error.message : String(error)}`)
    }
    // 候选配置可能尚未进入启动时的部署，因此在按需解析后叠加到部署上再执行 git。
    const deployment: Deployment = { ...this.host.machine, sources: { ...(this.resolved?.sources ?? {}), [repoId]: resolved } }
    const commands = new Commands(() => deployment, this.commandEnvironment, this.host.lifetime).scope(repoId)
    const auth = gitCredential ? this.host.gitAuth?.(gitCredential) : undefined
    try {
      const result = await syncRepoWorkCopy({ commands, stateDir: this.host.machine.stateDir, repo: repoId, signal: this.host.lifetime,
        ...(auth ? { auth } : {}) })
      // 空仓库同步本身成功，但没有分支和提交；单独分类，避免提示成笼统的同步失败。
      if (result.empty) throw new TaskRepoError('repoEmpty', '代码仓库为空，没有分支或提交')
    } catch (error) {
      if (error instanceof TaskRepoError) throw error
      throw new TaskRepoError('syncFailed', `代码仓库同步失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return repoDirectory(this.host.machine.stateDir, repoId)
  }
  /** 把项目内嵌的仓库配置解析成部署来源；有 Git 凭据时不依赖 CLI 登录。 */
  private async projectSource(id: string, repo: ProjectRepo, gitCredential: string,
    probe: ReturnType<Setup['probe']>): Promise<ResolvedSource> {
    const { machine } = this.host
    const credential = gitCredential ? this.host.gitCredential?.(gitCredential) : undefined
    // 项目表单只填仓库全地址（config.remote）；站点与仓库路径在这里补齐，兼容旧的 owner/name 形态。
    const derived = repositoryOfRemote(String(repo.config.remote ?? ''))
    if (!credential) {
      const config = { ...repo.config, auth: repo.config.auth === 'ssh' ? 'ssh' : 'https',
        ...(derived && !String(repo.config.repository ?? '') && !String(repo.config.project ?? '')
          ? { repository: derived.repository, project: derived.repository } : {}) }
      return repo.kind === 'github'
        ? resolveGithubSource(machine, id, config, probe)
        : resolveGitlabSource(machine, id, config, probe)
    }
    if (repo.kind === 'github') {
      const repository = String(repo.config.repository ?? '') || (derived?.repository ?? '')
      if (!repository) throw new SetupError('repositoryUnset', {}, id)
      return {
        id, kind: 'github', instanceUrl: String(repo.config.instanceUrl ?? ''),
        cli: String(repo.config.cli ?? ''), repository, login: credential.username, noreply: '',
        auth: credential.kind, remote: String(repo.config.remote ?? ''), sshKey: '', gitCredential,
      }
    }
    const project = String(repo.config.project ?? '') || (derived?.repository ?? '')
    if (!project) throw new SetupError('gitlabProjectUnset', {}, id)
    return {
      id, kind: 'gitlab', instanceUrl: String(repo.config.instanceUrl ?? ''),
      cli: String(repo.config.cli ?? ''), project, projectId: 0, login: credential.username, userId: 0,
      auth: credential.kind, remote: String(repo.config.remote ?? ''), sshKey: '', gitCredential,
    }
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
    // 每个启用的项目把自己的仓库解析成部署来源，任务来源同步工作副本时复用同一套命令入口。
    for (const [id, project] of Object.entries(settings.projects)) {
      if (!project.enabled) continue
      const repoId = projectRepoId(id)
      try {
        sources[repoId] = await this.projectSource(repoId, project.codeRepo, project.gitCredential, probe)
      } catch (error) {
        if (!(error instanceof SetupError)) throw error
        problems[repoId] = error.problem
        context.logger.warn('dsh-superagent leaves project repo %s out: %s', id, error.message)
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
