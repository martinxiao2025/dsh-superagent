/** 探测仓库和账户 CLI、配置执行器执行环境与命令 shim，并跟踪初始化就绪状态。 */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, resolveGitlab, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * 通过探测 CLI 解析目标仓库、GitHub 账户和可选的飞书机器人，然后写入并应用执行器进程使用的隔离 git 和 shim 环境。
 * `Runtime` 在启动时运行它来把守编排就绪状态，而 `Settings` 用它校验账户变更、更新被阻止命令的 shim，并安排重启。
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  gitlabProblem?: SetupProblem
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
  /** 解析部署账户并应用执行器环境；将 `SetupError` 失败记录到 `problem`/`feishuProblem`，并重新抛出意外错误。 */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** 触发重启以重新运行初始化；若初始化、飞书和 GitLab 均已健康，则拒绝，以免打断运行中的分配。 */
  check(): void {
    if (this.configured() && !this.feishuProblem && !this.gitlabProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** 将重启推迟到下一个宏任务，使当前 HTTP 或工具调用方先收到响应。 */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** 在保存前校验被修改来源块的账户 CLI，忽略属于其他块的初始化错误。 */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : block === 'source:gitlab' ? resolveGitlab(machine, settings.sources.gitlab?.config, this.probe())
        : resolveDeployment(machine, settings.sources.github?.config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
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
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const gitlab = await resolveGitlab(machine, settings.sources.gitlab?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.gitlabProblem = error.problem
      context.logger.warn('dsh-superagent leaves GitLab out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}), ...(gitlab ? { gitlab } : {}) }
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
