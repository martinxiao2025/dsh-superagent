/** 持久化队列条目：一条工作项从入队到终态的状态、重试与工单历史。 */
import { z } from 'zod'
import { key } from '../core/ids.ts'

/** 队列状态：等待出队、正在建单、已建单执行、成功、最终失败、取消。 */
export const QUEUE_STATES = ['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type QueueState = typeof QUEUE_STATES[number]

export const QueueEntrySchema = z.object({
  id: z.string().min(1),
  /** 项目记录 ID。 */
  project: z.string().min(1),
  /** 任务来源中的稳定编号。 */
  task: z.string().min(1),
  /** 任务内的工作项序号；单工作项任务为 0。 */
  item: z.number().int().nonnegative(),
  /** 工作项的稳定键：由内容派生，任务内列表增删或重排时仍能对应。旧记录没有该字段时按序号匹配。 */
  itemKey: z.string().min(1).optional(),
  /** 工作项内容的摘要；变化时旧条目被取代，新内容重新入队。 */
  contentHash: z.string().min(1).optional(),
  /** 工作项标题，用作工单标题。 */
  title: z.string(),
  /** 交给工作单元的正文。 */
  text: z.string(),
  /** 任务原始标题，回写与展示用。 */
  taskTitle: z.string(),
  state: z.enum(QUEUE_STATES),
  /** 已失败的次数；达到项目 `maxRetries` 后进入最终失败。 */
  attempt: z.number().int().nonnegative(),
  /** 全局 FIFO 序号，只增不减。 */
  seq: z.number().int().nonnegative(),
  enqueuedAt: z.string(),
  updatedAt: z.string(),
  /** 最早的出队时间（毫秒时间戳）；退避期间晚于当前时间。 */
  dueAt: z.number(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  /** 当前这次尝试创建的工单。 */
  ticketId: z.string().optional(),
  /** 这个工作项历次尝试的工单，按创建顺序排列。 */
  tickets: z.array(z.string()).default([]),
  /** 上一次轮询时任务是否仍在来源中；用于区分「连续存在」与「消失后重新出现」。 */
  present: z.boolean().default(true),
  /** 终态或退避原因；供面板与排障读取。 */
  reason: z.string().optional(),
}).strict()
export type QueueEntry = z.infer<typeof QueueEntrySchema>

/** 单个项目的调度状态：下次轮询时间与最近一次失败原因，供面板排障读取。 */
export interface QueueProjectStatus {
  id: string
  name: string
  enabled: boolean
  /** 下次轮询时间；从未调度过的项目没有该字段。 */
  nextPollAt?: string
  /** 最近一次轮询失败的原因；成功后清除。 */
  lastError?: string
}

/** 队列快照：P5 面板读取的只读视图。 */
export interface QueueSnapshot {
  at: string
  maxWorkers: number
  used: number
  /** 周期检查自身的最近错误；单项目错误见 `projects[].lastError`。 */
  error?: string
  items: {
    id: string
    project: string
    projectName: string
    task: string
    item: number
    title: string
    state: QueueState
    attempt: number
    dueAt: number
    ticketId?: string
    reason?: string
    enqueuedAt: string
    updatedAt: string
  }[]
  /** 按项目汇总的轮询状态；与 `items` 一起构成调度可观测性的最小闭环。 */
  projects: QueueProjectStatus[]
}

export const queueActive = (entry: Pick<QueueEntry, 'state'>): boolean =>
  entry.state === 'queued' || entry.state === 'starting' || entry.state === 'running'
export const queueInFlight = (entry: Pick<QueueEntry, 'state'>): boolean =>
  entry.state === 'starting' || entry.state === 'running'

/** 队列条目 ID：同一任务的工作项按稳定键与出现次数区分，让取消后重新出现的工作项保留上一段记录。 */
export const queueId = (project: string, task: string, itemKey: string, appearance: number): string =>
  key('queue', project, task, itemKey, String(appearance))

/** 条目对应的稳定工作项键；旧记录没有 `itemKey` 时退回序号。 */
export const queueItemKey = (entry: Pick<QueueEntry, 'item' | 'itemKey'>): string => entry.itemKey ?? `#${entry.item}`

