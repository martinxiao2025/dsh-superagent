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
}

/** writeback 模块所需的调度器内部状态与共享助手；由 ProjectScheduler 显式装配。 */
export interface WritebackContext {
  readonly host: SchedulerHost
  readonly registry: TaskSourceRegistry
  readonly syncRepo: (projectId: string) => Promise<string>
  /** 项目是否仍有任务在执行；回写需要同步工作副本，与 worker 的检出互斥。 */
  busy(projectId: string): boolean
  /** 把项目级飞书凭据注入驱动配置；驱动未声明该字段时不添加，避免严格 schema 拒绝。 */
  sourceConfig(fields: readonly { key: string }[], config: Record<string, unknown>, feishuCredential: string): Record<string, unknown>
}

/** 结果回写：入队持久化副作用与真实写回任务来源。 */
export class SchedulerWriteback {
  constructor(private readonly base: WritebackContext) {}

  /** 成功后回写任务状态；失败只记录在队列条目上，不改变工单结果。 */
  writeBack(entry: QueueEntry, kind: 'done' | 'failed'): void {
    const settings = this.base.host.settings()
    const project = settings.projects[entry.project]
    const driver = project && this.base.registry.kind(project.taskSource.kind)
    if (!project || !driver?.writeback) return
    const status = kind === 'done' ? project.taskPolicy.doneStatus : project.taskPolicy.failedStatus
    // 持久化副作用：进程重启后仍会重试；键含尝试次数，重复投递不会改变结果。
    this.base.host.effects.enqueue('writeback', key('writeback', entry.id, kind, String(entry.attempt)),
      { project: entry.project, task: entry.task, taskTitle: entry.taskTitle, status })
  }

  /** 副作用处理器：把状态写回任务来源；失败抛出，由 `Effects` 退避重试并上报健康度。 */
  async writeBackNow(payload: WritebackPayload): Promise<void> {
    // 回写需要同步工作副本，同样是 git 拉取；项目仍在执行任务时推迟，不消耗失败次数也不报错。
    if (this.base.busy(payload.project)) throw new Later('The project is running a task; the writeback is deferred until it is idle')
    const settings = this.base.host.settings()
    const project = settings.projects[payload.project]
    const driver = project && this.base.registry.kind(project.taskSource.kind)
    if (!project || !driver?.writeback) throw new Error(`The task source for ${payload.project} is unavailable`)
    const parsed = driver.schema.safeParse(this.base.sourceConfig(driver.fields, project.taskSource.config, project.feishuCredential))
    if (!parsed.success) throw new Error(`Invalid task source configuration: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    await driver.writeback(parsed.data, { taskId: payload.task, taskTitle: payload.taskTitle }, payload.status,
      { signal: this.base.host.lifetime, syncRepo: () => this.base.syncRepo(payload.project),
        commands: this.base.host.commands.scope(projectRepoId(payload.project)) })
  }
}
