/**
 * 执行工作区回收：按工单结束时间保留目录，超过保留期后删除。
 * 只处理执行根下「项目目录/工单目录」两层结构，且只删除仍被某个已结束工单引用的目录；
 * 未结束工单（正在运行或等待输入）的目录、以及不属于任何工单的目录一律保留。
 */
import { readdir, rm, rmdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { Ticket } from '../core/index.ts'

/** 回收输入；`workRoot` 通常来自 `executionRoot(settings, stateDir)`。 */
export interface WorkspaceGcInput {
  /** 只读取工单记录的存储；测试可以提供最小替身。 */
  readonly tickets: { list(): readonly Ticket[] }
  readonly workRoot: string
  /** 保留期（毫秒）；小于等于 0 表示不回收。 */
  readonly retentionMs: number
  readonly now?: () => number
  /** 删除单个目录；默认递归删除。 */
  readonly remove?: (directory: string) => Promise<void>
}

/** 一次回收的结果；面板与调度健康条目据此报告。 */
export interface WorkspaceGcReport {
  at: string
  root: string
  disabled: boolean
  /** 检查过的工单目录数。 */
  scanned: number
  removed: string[]
  /** 仍在保留期内的目录数。 */
  kept: number
  /** 不属于任何工单、因而保留的目录数。 */
  unknown: number
  errors: string[]
}

const normalize = (path: string): string => {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** 目录严格位于 `root` 内（而不是根本身或外部路径）。 */
const inside = (root: string, directory: string): boolean => {
  const path = relative(root, directory)
  return !!path && !path.startsWith('..') && !path.startsWith('/') && !path.startsWith('\\')
}

/** 工单引用的所有目录；不属于这里的目录可能是人工创建的，始终保留。 */
function referencedDirectories(tickets: readonly Ticket[]): Set<string> {
  const referenced = new Set<string>()
  for (const ticket of tickets) {
    const directory = ticket.execution?.directory
    if (directory) referenced.add(normalize(directory))
  }
  return referenced
}

/** 已结束工单的目录与结束时间；未结束的工单不出现在映射里，以免被删除。 */
function endedDirectories(tickets: readonly Ticket[]): Map<string, number> {
  const ended = new Map<string, number>()
  for (const ticket of tickets) {
    const directory = ticket.execution?.directory
    if (!directory || !ticket.ended) continue
    const endedAt = Date.parse(ticket.ended.at)
    ended.set(normalize(directory), Number.isFinite(endedAt) ? endedAt : Date.parse(ticket.updatedAt))
  }
  return ended
}

/**
 * 回收超过保留期的工单执行目录。
 * 与运行中任务互斥：未结束工单（含等待输入、失败待重试）的目录始终保留；回收只在调度轮询中调用。
 */
export async function collectWorkspaces(input: WorkspaceGcInput): Promise<WorkspaceGcReport> {
  const now = input.now?.() ?? Date.now()
  const root = resolve(input.workRoot)
  const report: WorkspaceGcReport = { at: new Date(now).toISOString(), root, disabled: input.retentionMs <= 0,
    scanned: 0, removed: [], kept: 0, unknown: 0, errors: [] }
  if (report.disabled) return report
  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    // 执行根尚不存在：没有可回收的目录。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report
    report.errors.push(`${root}: ${String(error instanceof Error ? error.message : error)}`)
    return report
  }
  const tickets = input.tickets.list()
  const referenced = referencedDirectories(tickets)
  const ended = endedDirectories(tickets)
  const remove = input.remove ?? (async (directory: string) => { await rm(directory, { recursive: true, force: true }) })
  for (const project of projects) {
    const projectRoot = join(root, project)
    let children: string[]
    try {
      children = (await readdir(projectRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error) {
      report.errors.push(`${projectRoot}: ${String(error instanceof Error ? error.message : error)}`)
      continue
    }
    let remaining = children.length
    for (const child of children) {
      const directory = join(projectRoot, child)
      report.scanned++
      const key = normalize(directory)
      // 不属于任何工单的目录可能由人工或旧版本创建，保留并只计入统计。
      if (!referenced.has(key)) { report.unknown++; continue }
      // 未结束的工单（运行中、等待输入或待重试）不参与回收。
      const endedAt = ended.get(key)
      if (endedAt === undefined) { report.kept++; continue }
      if (!inside(root, directory)) { report.kept++; continue }
      if (!Number.isFinite(endedAt) || now - endedAt < input.retentionMs) { report.kept++; continue }
      try {
        await remove(directory)
        report.removed.push(directory)
        remaining--
      } catch (error) {
        report.errors.push(`${directory}: ${String(error instanceof Error ? error.message : error)}`)
      }
    }
    // 项目目录在清空后一并移除；非空或删除失败时忽略。
    if (remaining === 0) await rmdir(projectRoot).catch(() => { /* 仍有并发写入或不是空目录。 */ })
  }
  return report
}
