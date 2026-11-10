/** 按来源记录探测仓库、项目与账户 CLI，配置执行器环境与命令 shim，并跟踪初始化就绪状态。 */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import {
  SETUP_FIELDS, resolveFeishuSource, resolveGithubSource, resolveGitlabSource, workerProbe,
  type Deployment, type Machine, type ResolvedSource,
} from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import type { SourceInstance } from '../sources/kind.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

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
const setupMaterial = (settings: Settings) => JSON.stringify(Object.entries(settings.sources)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([id, record]) => [id, record.kind, record.enabled, (SETUP_FIELDS[record.kind] ?? []).map(key => record.config[key] ?? '')]))
export const setupChanged = (before: Settings | undefined, after: Settings): boolean => !before || setupMaterial(before) !== setupMaterial(after)

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
