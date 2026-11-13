/** 项目调度器的轮询与合并模块：读取任务来源，把轮询结果原子地合并进持久化队列；由 ProjectScheduler 组合。 */
import { projectRepoId } from '../projects/kind.ts'
import { splitTask, type RawTask } from '../task-sources/tasks.ts'
import type { TaskSourceRegistry } from '../task-sources/index.ts'
import type { Settings } from '../policy.ts'
import type { SchedulerHost } from './scheduler.ts'
import { queueActive, queueId, queueInFlight, queueItemKey, type QueueEntry } from '../queue/model.ts'

/** 终态条目在队列中的保留时长；更早的记录在轮询时清理。 */
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000
/** 项目有任务在执行时推迟轮询的间隔；取轮询间隔与该值的较小者，项目空闲后自然恢复。 */
const BUSY_RETRY_MS = 60_000

/** reconcile 模块所需的调度器内部状态与共享助手；由 ProjectScheduler 显式装配。 */
export interface ReconcileContext {
  readonly host: SchedulerHost
  /** 各项目的下次轮询时间；由模块推进，快照与定时检查读取。 */
  readonly nextPoll: Map<string, number>
  /** 各项目最近一次失败原因；成功轮询后清除。 */
  readonly errors: Map<string, string>
  /** 因项目忙而推迟轮询的原因与时间；下一次真正轮询时清除，供快照展示。 */
  readonly deferred: Map<string, { reason: string; at: string }>
  readonly registry: TaskSourceRegistry
  readonly syncRepo: (projectId: string) => Promise<string>
  /** 项目是否仍有任务在执行：执行器占用与队列中的在途条目任一成立即视为忙。 */
  busy(projectId: string): boolean
  /** 记录项目级轮询失败并刷新健康与快照。 */
  fail(projectId: string, message: string): void
  /** 把变更写回队列并通知上层；调用方已持有事务。 */
  save(entry: QueueEntry): void
  /** 取消一个队列条目；由 dispatch 模块提供，合并时用于取消消失或被取代的工作项。 */
  cancel(entry: QueueEntry, reason: string): void
  /** 把项目级飞书凭据注入驱动配置；驱动未声明该字段时不添加，避免严格 schema 拒绝。 */
  sourceConfig(fields: readonly { key: string }[], config: Record<string, unknown>, feishuCredential: string): Record<string, unknown>
  /** 通知上层队列发生变化。 */
  changed(): void
  now(): number
  stamp(): string
}

/** 轮询与合并：项目任务来源的一次读取结果原子地并入队列。 */
export class SchedulerReconcile {
  constructor(private readonly base: ReconcileContext) {}

  /** 轮询一个项目：读取任务来源，取消消失的任务，把新的工作项入队；`settings` 由调用链传入以避免重复读取。 */
  async poll(projectId: string, settings: Settings = this.base.host.settings()): Promise<void> {
    const project = settings.projects[projectId]
    if (!project?.enabled) return
    const interval = project.schedule.intervalMinutes * 60_000
    // 项目有任务在执行时不拉取：同步会改写轮询工作副本，与 worker 的检出互相踩。
    // 推迟到 `min(轮询间隔, BUSY_RETRY_MS)` 之后重试，原因写进快照供排障，不静默丢弃。
    if (this.base.busy(projectId)) {
      this.base.nextPoll.set(projectId, this.base.now() + Math.min(interval, BUSY_RETRY_MS))
      this.base.deferred.set(projectId, { reason: 'A task from this project is running; polling and the git pull are deferred', at: this.base.stamp() })
      this.base.changed()
      return
    }
    this.base.deferred.delete(projectId)
    this.base.nextPoll.set(projectId, this.base.now() + interval)
    const driver = this.base.registry.kind(project.taskSource.kind)
    if (!driver) return this.base.fail(projectId, `Unknown task source type: ${project.taskSource.kind}`)
    const parsed = driver.schema.safeParse(this.base.sourceConfig(driver.fields, project.taskSource.config, project.feishuCredential))
    if (!parsed.success) return this.base.fail(projectId, `Invalid task source configuration: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    const repoId = projectRepoId(projectId)
    let tasks: RawTask[]
    try {
      tasks = await driver.list(parsed.data, { signal: this.base.host.lifetime, commands: this.base.host.commands.scope(repoId),
        syncRepo: () => this.base.syncRepo(projectId), feishu: this.base.host.feishuWiki, feishuIm: this.base.host.feishuIm })
    } catch (error) {
      return this.base.fail(projectId, String(error instanceof Error ? error.message : error))
    }
    this.base.errors.delete(projectId)
    this.base.host.store.atomic(() => {
      this.reconcile(projectId, project, tasks)
      // 终态只保留有限窗口：活动条目才是队列事实来源，历史记录过期后清理。
      this.base.host.store.queue.prune(projectId, new Date(this.base.now() - TERMINAL_RETENTION_MS).toISOString())
    })
    this.base.changed()
  }

  /**
   * 项目轮询结果合并进队列：按「任务 + 工作项稳定键」核对，消失的工作项取消、
   * 内容变化的旧条目被取代、新工作项入队；已完成且内容未变的同项不重复。
   */
  private reconcile(projectId: string, project: Settings['projects'][string], tasks: readonly RawTask[]): void {
    const pending = new Set(project.taskPolicy.pendingStatuses.map(status => status.toLowerCase()))
    const present = new Map<string, RawTask>()
    for (const task of tasks) if (pending.has(task.status.trim().toLowerCase())) present.set(task.id, task)
    const entries = this.base.host.store.queue.list().filter(entry => entry.project === projectId)
    const latest = new Map<string, QueueEntry>()
    for (const entry of entries) latest.set(`${entry.task}\u0000${queueItemKey(entry)}`, entry)
    // 先处理整条任务消失：活动条目取消并留痕，其他条目记为不在来源中，等重新出现时再入队。
    for (const entry of entries) {
      if (present.has(entry.task)) continue
      const absent = entry.present ? { ...entry, present: false, updatedAt: this.base.stamp() } : entry
      if (entry.present) this.base.save(absent)
      if (queueActive(absent)) this.base.cancel(absent, 'The task disappeared from its source')
    }
    for (const task of present.values()) {
      const items = splitTask(task)
      const keys = new Set(items.map(item => item.itemKey))
      const owned = entries.filter(entry => entry.task === task.id)
      // 任务仍在，但某个工作项被删除、重排或改写：已排队的不再执行旧内容；执行中的先跑完再结算。
      for (const entry of owned) {
        if (keys.has(queueItemKey(entry))) continue
        const absent = entry.present ? { ...entry, present: false, updatedAt: this.base.stamp() } : entry
        if (entry.present) this.base.save(absent)
        if (absent.state === 'queued') this.base.cancel(absent, 'The work item changed or disappeared; its newer version is queued')
      }
      items.forEach((item, index) => {
        const previous = latest.get(`${task.id}\u0000${item.itemKey}`)
        if (previous) {
          const changed = previous.contentHash !== undefined && previous.contentHash !== item.contentHash
          if (queueInFlight(previous)) return
          if (previous.state === 'queued' && changed) this.base.cancel({ ...previous, present: false }, 'The work item changed; its newer version is queued')
          else if (queueActive(previous)) {
            if (!previous.present) this.base.save({ ...previous, present: true, updatedAt: this.base.stamp() })
            return
          } else if (previous.state === 'succeeded' && !changed) return
          else if (previous.present && !changed) return
        }
        const appearance = owned.filter(entry => queueItemKey(entry) === item.itemKey).length
        const entry: QueueEntry = {
          id: queueId(projectId, task.id, item.itemKey, appearance),
          project: projectId, task: task.id, item: index, itemKey: item.itemKey, contentHash: item.contentHash,
          title: item.title, text: item.text, taskTitle: task.title,
          state: 'queued', attempt: 0, seq: this.nextSeq(), enqueuedAt: this.base.stamp(), updatedAt: this.base.stamp(), dueAt: this.base.now(),
          tickets: [], present: true,
        }
        this.base.save(entry)
      })
    }
  }

  private nextSeq(): number {
    return this.base.host.store.queue.maxSeq() + 1
  }
}
