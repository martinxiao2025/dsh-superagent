/** 主插件入口：先挂载管理路由、再取得状态目录锁并初始化 Runtime，使启动失败可被健康接口诊断。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { AdminMount } from './app/admin-mount.ts'
import { acquireStateLock, recordStartup, startupError, type StartupPhase, type StartupStatus } from './app/startup.ts'
import { ADAPTERS } from './sources/adapters.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { resetState } from './app/reset.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  // 配置校验必须在挂载任何路由之前完成：旧模型的键应当让插件直接失败，而不是留下半个管理接口。
  const machine = machineOf(config)
  // 管理面板自带设置界面，因此禁用 DSH 自动生成的设置页。
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // 易变的限制可就地更新而无需重启；账号变更会重启 dsh-superagent。dsh-superagent 重启期间
  // DSH 的设置服务会停止提供该条目，且只在写入配置时重新读取它，因此在重启后触发 `describe()`，
  // 让已打开的配置表单保持可编辑而无需刷新页面。
  // TODO: 当 DSH 的设置服务会在插件重新激活时重读条目后，移除这次读取。
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // 管理路由先于任何可能失败的初始化步骤挂载：取锁或初始化失败时前缀仍由本插件持有，
  // 健康接口与 503 响应会说明阶段与原因，而不是让宿主返回空体 404。
  const mount = new AdminMount(ctx, machine.stateDir)
  ctx.effect(() => () => mount.dispose())
  /** 更新启动阶段：同时写入管理路由的诊断状态与 `stateDir/startup.json`。 */
  const record = (phase: StartupPhase, detail: string, error?: unknown): void => {
    const status: StartupStatus = { phase, detail, stateDir: machine.stateDir, ...error === undefined ? {} : { error: startupError(error) } }
    mount.set(status)
    recordStartup(machine.stateDir, { ...status, at: new Date().toISOString(), pid: process.pid,
      listen: { host: ctx.webServer.host, port: ctx.webServer.port } })
  }
  record('http-registered', `管理路由已挂载：/orchestrator/api（${ctx.webServer.host}:${ctx.webServer.port}）`)
  let runtime: Runtime | undefined
  try {
    const lock = await acquireStateLock(machine.stateDir, { onWait: elapsed => {
      if (mount.status().phase !== 'locked') record('locked', `状态目录锁被占用，最多等待 35 秒（已等待 ${Math.round(elapsed / 1000)} 秒）`)
    } })
    // 一次性启动参数：取得锁之后、打开数据库之前备份并清空状态目录，随后按空基线启动。
    if (config.resetState) {
      record('resetting', 'resetState 已开启：正在备份并清空状态目录')
      const report = await resetState({ stateDir: machine.stateDir })
      record('reset', `状态目录已重置${report.backup ? `，备份在 ${report.backup}` : ''}；保留 ${report.kept.length} 个非插件条目`)
    }
    record('store-open', '已取得状态目录锁，正在打开数据库')
    runtime = new Runtime(ctx, machine, restart, { mount, lock })
    ctx.effect(() => async () => { await runtime?.stop() })
    await runtime.ready
    // 来源是用户数据：注册内置适配器，并为每条已存储的记录启动独立循环。
    runtime.startSources(ADAPTERS)
    record('ready', runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel'
      : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
  } catch (error) {
    // 初始化失败不抛出：保持插件激活与路由挂载，失败原因写进启动记录并由健康接口报告。
    mount.detach()
    const phase: StartupPhase = (error as { code?: string } | undefined)?.code === 'ELOCKED' ? 'locked' : 'failed'
    record(phase, phase === 'locked' ? '状态目录被另一个实例占用，已放弃本次启动' : `dsh-superagent 初始化失败：${error instanceof Error ? error.message : String(error)}`, error)
    ctx.logger.error('dsh-superagent did not start: %s', String(error))
  }
  ctx.logger.info(runtime?.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel'
    : runtime ? `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`
      : 'dsh-superagent is not running; GET /orchestrator/api/health reports the startup phase')
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
