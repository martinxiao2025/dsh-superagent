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
  /** 该项目全部条目数（活动 + 终态）；面板据此显示「加载更多」。 */
  total?: number
  /** 分页窗口之后是否还有更早的条目。 */
  more?: boolean
}

/** 仓库在面板上的短名：优先仓库路径，其次远端地址，最后退回类型名。 */
export function repoLabel(kind: ProjectRepo['kind'], config: Record<string, unknown>): string {
  const text = config.repository ?? config.project ?? config.remote
  return typeof text === 'string' && text ? text : kind
}

/** 组装项目详情页所需的数据；队列条目只保留属于 `id` 的部分，终态历史按页窗口展示。 */
export function projectTasksView(id: string, project: Project, snapshot: QueueSnapshot,
  page: { offset: number; limit: number } = { offset: 0, limit: 50 }): ProjectTasksView {
  const all = snapshot.items.filter(item => item.project === id)
  const items = all.slice(page.offset, page.offset + page.limit)
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
    queued: all.filter(item => item.state === 'queued').length,
    running: all.filter(item => item.state === 'running' || item.state === 'starting').length,
    items,
    total: all.length,
    ...(all.length > page.offset + page.limit ? { more: true } : {}),
    // 调度状态可选：没有轮询过或没有错误的项目不携带这些字段。
    ...(status?.nextPollAt ? { nextPollAt: status.nextPollAt } : {}),
    ...(status?.lastError ? { lastError: status.lastError } : {}),
    ...(status?.deferred ? { deferred: status.deferred } : {}),
  }
}
