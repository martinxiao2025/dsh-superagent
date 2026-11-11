/** 项目运行视图：项目配置、该项目在队列中的条目，以及全局运行时占用。 */
import type { Project, ProjectRepo, ProjectTaskSource } from '../../projects/kind.ts'
import type { QueueSnapshot } from '../../queue/model.ts'

export interface ProjectTasksView {
  project: {
    id: string
    name: string
    enabled: boolean
    codeRepo: { kind: ProjectRepo['kind']; name: string }
    taskSource: { kind: ProjectTaskSource['kind']; name: string }
    execution: Project['execution']
    schedule: Project['schedule']
    retry: Project['retry']
    taskPolicy: Project['taskPolicy']
  }
  at: string
  /** 全局并发上限与当前占用；排队与运行数只统计本项目。 */
  maxWorkers: number
  used: number
  queued: number
  running: number
  /** 下次轮询时间；尚未调度过的项目没有该字段。 */
  nextPollAt?: string
  /** 最近一次轮询失败的原因；成功后清除。 */
  lastError?: string
  /** 因本项目有任务在执行而推迟轮询的原因与时间；下一次真正轮询时清除。 */
  deferred?: { reason: string; at: string }
  items: QueueSnapshot['items']
}

/** 仓库在面板上的短名：优先仓库路径，其次远端地址，最后退回类型名。 */
export function repoLabel(kind: ProjectRepo['kind'], config: Record<string, unknown>): string {
  const text = config.repository ?? config.project ?? config.remote
  return typeof text === 'string' && text ? text : kind
}

/** 组装项目详情页所需的数据；队列条目只保留属于 `id` 的部分。 */
export function projectTasksView(id: string, project: Project, snapshot: QueueSnapshot): ProjectTasksView {
  const items = snapshot.items.filter(item => item.project === id)
  const status = snapshot.projects.find(item => item.id === id)
  return {
    project: {
      id,
      name: project.name,
      enabled: project.enabled,
      codeRepo: { kind: project.codeRepo.kind, name: repoLabel(project.codeRepo.kind, project.codeRepo.config) },
      taskSource: { kind: project.taskSource.kind, name: project.taskSource.kind },
      execution: project.execution,
      schedule: project.schedule,
      retry: project.retry,
      taskPolicy: project.taskPolicy,
    },
    at: snapshot.at,
    maxWorkers: snapshot.maxWorkers,
    used: snapshot.used,
    queued: items.filter(item => item.state === 'queued').length,
    running: items.filter(item => item.state === 'running' || item.state === 'starting').length,
    items,
    // 调度状态可选：没有轮询过或没有错误的项目不携带这些字段。
    ...(status?.nextPollAt ? { nextPollAt: status.nextPollAt } : {}),
    ...(status?.lastError ? { lastError: status.lastError } : {}),
    ...(status?.deferred ? { deferred: status.deferred } : {}),
  }
}
