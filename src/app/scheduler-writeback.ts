/** 项目调度器的回写模块：把工单终态持久化为副作用，并在副作用处理器中真实写回任务来源；由 ProjectScheduler 组合。 */
import { key } from '../core/ids.ts'
import { Later } from './effects.ts'
import { projectRepoId } from '../projects/kind.ts'
import type { TaskSourceRegistry } from '../task-sources/index.ts'
import type { SchedulerHost } from './scheduler.ts'
import type { QueueEntry } from '../queue/model.ts'

/** 写入外部清单的持久化副作用载荷；键由队列条目与尝试次数决定，重复投递幂等。 */
export interface WritebackPayload {
  project: string
  task: string
  taskTitle: string
  status: string
  /**
   * 期望的清单当前状态（评审 C3 的 CAS）：写入前校验清单行的状态列仍是期望值，
   * 不匹配说明有人在结算间隙手工改过清单——写入被拒绝并告警，由人工仲裁，
   * 而不是无提示覆盖人工修改。
   */
  expectedStatus?: string
}

/** 回写副作用的键：队列条目 + 终态种类 + 尝试次数；入队与取消四处共用这一构造。 */
export const writebackKey = (entry: Pick<QueueEntry, 'id' | 'attempt'>, kind: 'done' | 'failed'): string =>
  key('writeback', entry.id, kind, String(entry.attempt))

/** writeback 模块所需的调度器内部状态与共享助手；由 ProjectScheduler 显式装配。 */
export interface WritebackContext {
  readonly host: SchedulerHost
  readonly registry: TaskSourceRegistry
  /**
   * 回写路径的仓库同步：与轮询共用的无损语义不同，这里允许在分叉时重置到远端
   * （评审 S1）——本副作用仍在重试中，丢弃的只是自己未推送成功的提交，写入随后重放。
   */
  readonly syncRepo: (projectId: string) => Promise<string>
  /** 把回写产生的本地提交推送远端（评审 S1）；驱动声明 push 能力时在回写后调用。 */
  readonly pushRepo?: (projectId: string) => Promise<void>
  /** 项目是否仍有任务在执行；回写需要同步工作副本，与 worker 的检出互斥。 */
  busy(projectId: string): boolean
  /** 项目是否正被轮询（评审 S9）：回写与轮询都要触碰同一份工作副本，必须互斥。 */
  polling(projectId: string): boolean
  /** 把项目级飞书凭据注入驱动配置；驱动未声明该字段时不添加，避免严格 schema 拒绝。 */
  sourceConfig(fields: readonly { key: string }[], config: Record<string, unknown>, feishuCredential: string): Record<string, unknown>
}

/** 结果回写：入队持久化副作用与真实写回任务来源。 */
export class SchedulerWriteback {
  constructor(private readonly base: WritebackContext) {}

  /** 成功后回写任务状态；失败只记录在队列条目上，不改变工单结果。
   *  回写按「任务」聚合（评审 C3）：只有该任务的全部工作项条目都已终态时才入队一次回写，
   *  最终状态由全部条目的结果聚合而成——多工作项任务不再由「最后结算的那个工作项」决定清单状态。
   */
  writeBack(entry: QueueEntry, kind: 'done' | 'failed'): void {
    const project = this.base.host.project(entry.project)
    const driver = project && this.base.registry.kind(project.taskSource.kind)
    if (!project || !driver?.writeback) return
    // 任务聚合：同任务的其他工作项仍在活动态时不回写，等最后一个工作项结算时统一写。
    const siblings = this.base.host.store.queue.list().filter(item => item.project === entry.project && item.task === entry.task)
    if (siblings.some(item => item.id !== entry.id && (item.state === 'queued' || item.state === 'starting' || item.state === 'running'))) return
    const succeeded = siblings.filter(item => item.state === 'succeeded' || (item.id === entry.id && kind === 'done')).length
    // 聚合语义：全部工作项成功 → doneStatus；任一最终失败 → failedStatus（与既有单工作项行为一致）。
    const finalStatus = succeeded === siblings.length ? project.taskPolicy.doneStatus : project.taskPolicy.failedStatus
    // 持久化副作用：进程重启后仍会重试；键含尝试次数，重复投递不会改变结果。
    // CAS：expectedStatus 取任务准入的待处理状态（回写前清单上它仍是待处理），驱动写前校验。
    this.base.host.effects.enqueue('writeback', writebackKey(entry, kind),
      { project: entry.project, task: entry.task, taskTitle: entry.taskTitle, status: finalStatus,
        expectedStatus: project.taskPolicy.pendingStatuses[0] })
  }

  /** 副作用处理器：把状态写回任务来源；失败抛出，由 `Effects` 退避重试并上报健康度。 */
  async writeBackNow(payload: WritebackPayload): Promise<void> {
    // 回写需要同步工作副本，同样是 git 拉取；项目仍在执行任务时推迟，不消耗失败次数也不报错。
    if (this.base.busy(payload.project)) throw new Later('The project is running a task; the writeback is deferred until it is idle')
    // 与轮询互斥（评审 S9）：poll 副作用正在 fetch/merge 同一镜像时推迟回写，
    // 避免写回提交落在 checkout 覆盖后的内容上或制造 index.lock 冲突。
    if (this.base.polling(payload.project)) throw new Later('The project is being polled; the writeback is deferred until the poll finishes')
    const project = this.base.host.project(payload.project)
    const driver = project && this.base.registry.kind(project.taskSource.kind)
    if (!project || !driver?.writeback) throw new Error(`The task source for ${payload.project} is unavailable`)
    const parsed = driver.schema.safeParse(this.base.sourceConfig(driver.fields, project.taskSource.config, project.feishuCredential))
    if (!parsed.success) throw new Error(`Invalid task source configuration: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    await driver.writeback(parsed.data,
      { taskId: payload.task, taskTitle: payload.taskTitle, ...(payload.expectedStatus !== undefined ? { expectedStatus: payload.expectedStatus } : {}) },
      payload.status,
      { signal: this.base.host.lifetime, syncRepo: () => this.base.syncRepo(payload.project),
        commands: this.base.host.commands.scope(projectRepoId(payload.project)),
        feishu: credential => this.base.host.feishuWiki?.(credential) ?? Promise.resolve(undefined) })
    // 回写提交后推送远端（评审 S1）：驱动声明 push 才推送（飞书走 API，无 git 提交）。
    // 推送失败随本副作用退避重试——下一次同步按 resetOnDivergence 重置并重放写入后重推，收敛。
    if (driver.push && this.base.pushRepo) {
      await driver.push(parsed.data,
        { signal: this.base.host.lifetime, syncRepo: () => this.base.syncRepo(payload.project),
          commands: this.base.host.commands.scope(projectRepoId(payload.project)),
          feishu: credential => this.base.host.feishuWiki?.(credential) ?? Promise.resolve(undefined),
          push: () => this.base.pushRepo!(payload.project) })
    }
  }
}
