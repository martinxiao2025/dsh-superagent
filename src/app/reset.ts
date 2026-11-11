/**
 * 状态目录重置：先把整个状态目录复制到备份目录，再删除本插件拥有的条目，然后从空白基线启动。
 * 调用方必须先停止调度、关闭数据库并释放状态目录锁；本模块只做文件系统操作，不感知运行时状态。
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 插件在状态目录中拥有的条目；重置只删除这些，其他文件保留并列入报告。 */
const STATE_ENTRIES: readonly string[] = [
  'orchestrator.sqlite', 'orchestrator.sqlite-wal', 'orchestrator.sqlite-shm',
  'repos', 'work', 'secrets', 'worker-bin', 'worker-gitconfig', 'worker-dispatch.mjs', 'worker-sources.json',
  'startup.json', 'startup.prev.json',
]
/** 每次准入评估写入的临时镜像文件。 */
const STATE_PREFIXES: readonly string[] = ['admission-image-']

export interface ResetOptions {
  /** 状态目录；数据库、仓库缓存与工作单元文件都在其中。 */
  readonly stateDir: string
  /** 备份根目录；默认 `~/dsh-superagent-backup`。 */
  readonly backupRoot?: string
  /** 是否在删除前备份；默认 true。 */
  readonly backup?: boolean
  /** 注入时间以便测试备份目录名确定。 */
  readonly now?: () => Date
}

/** 一次重置的结果；面板与命令据此展示备份位置和保留的文件。 */
export interface ResetReport {
  at: string
  stateDir: string
  /** 备份目录；未启用备份时缺省。 */
  backup?: string
  /** 已删除的状态条目（相对路径）。 */
  removed: string[]
  /** 因不属于本插件而保留的条目。 */
  kept: string[]
}

/** 备份或删除失败时抛出；`report.backup` 指向可用备份，便于人工恢复。 */
export class ResetError extends Error {
  constructor(message: string, readonly backup?: string) { super(message) }
}

const owned = (name: string): boolean => STATE_ENTRIES.includes(name) || STATE_PREFIXES.some(prefix => name.startsWith(prefix))
const stamp = (date: Date): string => date.toISOString().replace(/[:.]/g, '-')

/** 把整个状态目录复制到备份根下的时间戳目录；目录内容不一致时抛错，避免删除唯一副本。 */
async function backUp(stateDir: string, backupRoot: string, now: Date): Promise<string> {
  await mkdir(backupRoot, { recursive: true })
  const target = join(backupRoot, stamp(now))
  await cp(stateDir, target, { recursive: true, errorOnExist: false, force: true })
  // 逐项核对备份，复制中途失败时不要让调用方继续删除原始数据。
  const entries = await readdir(stateDir)
  for (const name of entries) {
    await stat(join(target, name)).catch(() => {
      throw new ResetError(`The state backup at ${target} is incomplete: ${name} is missing`, target)
    })
  }
  return target
}

/**
 * 备份并清空状态目录中由本插件拥有的条目。
 * 备份在删除之前完成；删除中途失败会尝试从备份恢复，并把错误抛给调用方。
 */
export async function resetState(options: ResetOptions): Promise<ResetReport> {
  const stateDir = resolve(options.stateDir)
  const now = options.now?.() ?? new Date()
  const report: ResetReport = { at: now.toISOString(), stateDir, removed: [], kept: [] }
  let entries: string[]
  try {
    entries = await readdir(stateDir)
  } catch (error) {
    // 状态目录尚不存在：已经是空基线。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report
    throw error
  }
  const doomed = entries.filter(owned)
  report.kept = entries.filter(name => !owned(name))
  if (options.backup !== false) {
    try {
      report.backup = await backUp(stateDir, options.backupRoot ?? join(homedir(), 'dsh-superagent-backup'), now)
    } catch (error) {
      if (error instanceof ResetError) throw error
      throw new ResetError(`Could not back up the state directory before resetting: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const name of doomed) {
    try {
      await rm(join(stateDir, name), { recursive: true, force: true })
      report.removed.push(name)
    } catch (error) {
      // 删除失败：把备份内容复制回状态目录，尽量恢复到重置前的状态。
      if (report.backup) await cp(report.backup, stateDir, { recursive: true, force: true }).catch(() => { /* 保留原始错误。 */ })
      throw new ResetError(`Could not remove ${name} from the state directory: ${error instanceof Error ? error.message : String(error)}`, report.backup)
    }
  }
  return report
}
