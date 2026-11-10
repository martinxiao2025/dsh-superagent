/**
 * 流水线运行器：同步代码 → 读取任务 → 拆解规划 → 逐项准入 → 等待工单 → 回写。
 * 运行状态与任务项状态写入来源作用域的 KV，进程重启后按记录续跑。
 */
import type { ScheduledTicket, Ticket, Trigger } from '../core/index.ts'
import { key } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Key } from '../kv.ts'
import { KV } from '../kv.ts'
import { health, type Health } from '../sources/host.ts'
import { syncCode, type CodeSyncResult } from './code.ts'
import { pipelineProblems, type PipelineConfig } from './config.ts'
import { createTaskSource } from './task-source.ts'
import { finalFailure, plannable, workItems, type ItemRecord, type ItemRecords, type WorkItem } from './tasks.ts'
import { writeTaskStatus } from './writeback.ts'

/** 运行阶段；`failed` 表示本次运行失败，下一次按时间表继续。 */
export type Phase = 'idle' | 'syncing-code' | 'loading-tasks' | 'planning' | 'running' | 'writing-back' | 'done' | 'failed'
/** 持久化的运行状态。 */
export interface RunState {
  phase: Phase
  at: string
  detail?: string
  commit?: string
  opened?: number
  writtenBack?: number
  deferred?: number
}
/** 一次运行的摘要，供健康条目与日志使用。 */
export interface RunSummary { phase: Phase; commit?: string; opened: number; writtenBack: number; deferred: number }

/** 运行器需要的应用能力；由 `pipeline` 来源适配器从 `SourceContext` 组装。 */
export interface PipelineHost {
  readonly recordId: string
  readonly stateDir: string
  readonly commands: Commands
  /** 引擎定时准入；同一触发器幂等。 */
  schedule(input: ScheduledTicket): { ticketId: string; created: boolean }
  tickets: { get(id: string): Ticket | undefined }
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void }
  /** 记录启用时返回配置，停用或删除时返回 undefined。 */
  config(): PipelineConfig | undefined
  /** 记录 ID → 来源种类，用于校验代码来源与飞书来源引用。 */
  codeKinds(): Record<string, string>
  report(entry: string, health: Health): void
  /** 当前时间；测试可注入固定时间。 */
  now?(): string
  /** 等待若干毫秒，可被停止信号打断。 */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

const POLL_MS = 5_000
const WAIT_MS = 60_000

/**
 * 运行一次流水线。
 * 代码同步或任务读取失败时直接抛出，由调用方记为本次运行失败，不产生新工单。
 */
export async function runPipeline(host: PipelineHost, signal: AbortSignal): Promise<RunSummary> {
  const now = (): string => host.now?.() ?? new Date().toISOString()
  const sleep = host.sleep ?? wait
  const config = host.config()
  if (!config) throw new Error('流水线记录已停用或不存在')
  const problems = pipelineProblems(config, host.codeKinds())
  if (problems.length) throw new Error(problems.join('；'))
  const scope = host.commands.scope(config.codeSource)
  const source = scope.source
  if (source?.kind !== 'github' && source?.kind !== 'gitlab') throw new Error('代码来源记录必须是 GitHub 或 GitLab')
  const state = (phase: Phase, detail?: string): RunState => {
    const value: RunState = { phase, at: now(), ...(detail ? { detail } : {}) }
    host.state.set(KV.pipeline.state(host.recordId), value)
    return value
  }

  let synced: CodeSyncResult
  try {
    state('syncing-code')
    synced = await syncCode({ commands: host.commands, stateDir: host.stateDir, codeSource: config.codeSource,
      branch: config.branch, directory: config.directory || defaultDirectory(host), signal })
    host.report('code', health('ready', 'pipelineCode', { commit: short(synced.commit) }))
  } catch (error) {
    state('failed', messageOf(error))
    throw error
  }

  let items: WorkItem[]
  try {
    state('loading-tasks')
    const reader = createTaskSource(config, config.taskKind === 'feishu' ? host.commands.scope(config.feishuSource) : host.commands)
    const tasks = await reader.load({ signal })
    const pending = new Set(config.pendingStatuses.split(',').map(item => item.trim()).filter(Boolean))
    const eligible = tasks.filter(task => task.status === '' || pending.has(task.status))
    items = workItems(eligible, host.recordId)
    host.report('tasks', health('ready', 'pipelineTasks', { total: String(tasks.length), pending: String(items.length) }))
  } catch (error) {
    state('failed', messageOf(error))
    throw error
  }

  state('planning')
  const records: ItemRecords = host.state.get(KV.pipeline.items(host.recordId)) ?? {}
  recover(host, records)
  const candidates = plannable(items, records, config.maxRetries)
  const limit = Math.max(1, config.concurrency)

  state('running')
  const queue = [...candidates]
  const running = new Map<string, { item: WorkItem; ticketId: string }>()
  let opened = 0

  /** 持久化一个任务项记录。 */
  const remember = (item: WorkItem, value: ItemRecord): void => {
    records[item.key] = value
    host.state.set(KV.pipeline.items(host.recordId), records)
  }

  while (!signal.aborted && (queue.length || running.size)) {
    while (running.size < limit && queue.length) {
      const item = queue.shift()!
      const prior = records[item.key]
      if (prior?.state === 'failed' && !retryDue(prior, config, Date.parse(now()))) {
        queue.push(item)
        break
      }
      const attempt = (prior?.attempts ?? 0) + 1
      remember(item, { state: 'queued', attempts: attempt, at: now() })
      const admitted = host.schedule({ trigger: triggerOf(host, config, item, now()), pipeline: host.recordId,
        task: item.taskId, title: item.title, scope: item.title, reason: `Scheduled task ${item.taskId}` })
      remember(item, { state: 'running', ticket: admitted.ticketId, attempts: attempt, at: now() })
      running.set(item.key, { item, ticketId: admitted.ticketId })
      if (admitted.created) opened += 1
    }
    if (!running.size) break
    await sleep(POLL_MS, signal)
    for (const [itemKey, entry] of [...running]) {
      const ticket = host.tickets.get(entry.ticketId)
      if (!ticket?.ended) continue
      running.delete(itemKey)
      const failed = ticket.ended.outcome === 'stopped' || ticket.ended.outcome === 'dropped'
      remember(entry.item, { state: failed ? 'failed' : 'succeeded', ticket: entry.ticketId,
        attempts: records[itemKey]!.attempts, at: now(), ...(failed ? { reason: ticket.ended.reason ?? ticket.ended.outcome } : {}) })
    }
  }

  const deferred = signal.aborted ? 0 : queue.length
  if (signal.aborted) return { phase: 'running', commit: synced.commit, opened, writtenBack: 0, deferred }

  state('writing-back')
  for (const item of items) {
    const record = records[item.key]
    if (record && finalFailure(record, config.maxRetries)) {
      remember(item, { ...record, state: 'failed', reason: record.reason ?? '达到重试上限' })
    }
  }
  const writtenBack = await writeBack(host, config, items, records, remember, now)
  const summary: RunSummary = { phase: 'done', commit: synced.commit, opened, writtenBack, deferred }
  host.state.set(KV.pipeline.state(host.recordId), { ...summary, at: now() })
  return summary
}

/**
 * 记录的运行循环：配置有效时按 `intervalMinutes` 运行，未配置或停用时只等待。
 * 循环内的失败只写健康，不中断循环。
 */
export async function watchPipeline(host: PipelineHost, signal: AbortSignal): Promise<void> {
  const sleep = host.sleep ?? wait
  let first = true
  while (!signal.aborted) {
    const config = host.config()
    if (!config) {
      host.report('pipeline', health('paused', 'pipelineOff'))
      await sleep(WAIT_MS, signal)
      continue
    }
    const problems = pipelineProblems(config, host.codeKinds())
    if (problems.length) {
      host.report('pipeline', health('paused', 'pipelineUnset', { detail: problems.join('；') }))
      await sleep(WAIT_MS, signal)
      continue
    }
    if (first && !config.runOnStart) {
      first = false
      await sleep(config.intervalMinutes * 60_000, signal)
      continue
    }
    first = false
    host.report('pipeline', health('starting', 'pipelineRunning'))
    try {
      const summary = await runPipeline(host, signal)
      host.report('pipeline', health('ready', 'pipelineDone', { opened: String(summary.opened),
        written: String(summary.writtenBack), deferred: String(summary.deferred) }))
    } catch (error) {
      if (!signal.aborted) host.report('pipeline', health('error', 'pipelineRunFailed', { error: messageOf(error) }))
    }
    await sleep(config.intervalMinutes * 60_000, signal)
  }
}

/**
 * 按任务聚合回写：一条任务的全部工作项都结束后才写一次状态，避免拆分项互相覆盖。
 * 回写失败单独记为 `writeback-failed`，不回退已完成的工作，也不重跑工单。
 */
async function writeBack(host: PipelineHost, config: PipelineConfig, items: readonly WorkItem[], records: ItemRecords,
  remember: (item: WorkItem, value: ItemRecord) => void, now: () => string): Promise<number> {
  let written = 0
  const tasks = new Map<string, WorkItem[]>()
  for (const item of items) tasks.set(item.taskId, [...tasks.get(item.taskId) ?? [], item])
  for (const [taskId, group] of tasks) {
    const recordsOf = group.map(item => records[item.key])
    const finalFailed = recordsOf.some(record => record?.state === 'failed' && finalFailure(record, config.maxRetries))
    const terminal = recordsOf.every((record, index) => record && (record.state === 'succeeded' || record.state === 'written-back'
      || record.state === 'writeback-failed' || (finalFailed && recordsOf[index]!.state === 'failed')))
    if (!terminal) continue
    const failed = finalFailed
    const target = { taskId, taskTitle: group[0]!.taskTitle }
    try {
      await writeTaskStatus(config, target, failed ? config.failedStatus : config.doneStatus)
      for (const item of group) {
        const record = records[item.key]!
        remember(item, { ...record, state: failed ? 'failed' : 'written-back', at: now() })
      }
      written += 1
    } catch (error) {
      for (const item of group) {
        const record = records[item.key]!
        remember(item, { ...record, state: 'writeback-failed', at: now(), reason: messageOf(error) })
      }
      host.report('tasks', health('error', 'pipelineWritebackFailed', { error: messageOf(error) }))
    }
  }
  return written
}

/**
 * 恢复上次运行留下的未决记录：仍在执行的工单保持 `running`，已结束或已丢失的工单改写为最终状态。
 * 这样进程在任意步骤重启后都不会重复开单，也不会把已结束的工作永远卡住。
 */
function recover(host: PipelineHost, records: ItemRecords): void {
  for (const [itemKey, record] of Object.entries(records)) {
    if (record.state !== 'queued' && record.state !== 'running') continue
    const ticket = record.ticket ? host.tickets.get(record.ticket) : undefined
    if (!ticket) {
      records[itemKey] = { ...record, state: 'failed', reason: '工单已丢失' }
      continue
    }
    if (!ticket.ended) continue
    const failed = ticket.ended.outcome === 'stopped' || ticket.ended.outcome === 'dropped'
    records[itemKey] = { ...record, state: failed ? 'failed' : 'succeeded', at: ticket.ended.at,
      ...(failed ? { reason: ticket.ended.reason ?? ticket.ended.outcome } : {}) }
  }
}

/** 默认代码目录：按记录隔离，避免多条流水线互相覆盖。 */
function defaultDirectory(host: PipelineHost): string {
  return `${host.stateDir.replace(/[\\/]+$/, '')}/pipeline/${host.recordId}/code`
}

/** 构造任务触发器：来源指向代码来源记录，使执行器使用该记录的凭据与环境。 */
function triggerOf(host: PipelineHost, config: PipelineConfig, item: WorkItem, at: string): Trigger {
  const scoped = host.commands.scope(config.codeSource)
  const repo = scoped.source?.kind === 'github' ? scoped.github.repository : scoped.gitlab?.project ?? ''
  return {
    id: key('pipeline-task', host.recordId, item.key),
    source: config.codeSource,
    threads: [{ source: config.codeSource, id: `pipeline/${host.recordId}/${item.taskId}` }],
    actor: { source: host.recordId, id: 'schedule' },
    human: false,
    at,
    text: item.text,
    meta: { repo, pipeline: host.recordId, task: item.taskId },
  }
}

/** 失败任务项是否已过退避时间；首次失败立即允许重试。 */
function retryDue(record: ItemRecord, config: PipelineConfig, now: number): boolean {
  if (record.attempts <= 1) return true
  const backoff = config.retryBackoffSeconds * 1000 * 2 ** Math.max(0, record.attempts - 2)
  return now - Date.parse(record.at) >= backoff
}

/** 可中止的等待。 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** 提交短哈希，用于健康详情。 */
const short = (commit: string): string => commit.slice(0, 8)

/** 提取错误文本，不包含堆栈。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
