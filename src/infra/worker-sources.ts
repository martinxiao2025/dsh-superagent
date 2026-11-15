/**
 * 工单来源记录的进程侧分发数据：记录 ID → CLI，以及工单目录 → 记录 ID。
 * 工作单元会话的环境变量无法按工单注入，因此垫片与 git 凭据助手通过「当前目录的祖先登记」选择记录；
 * 准备命令的目录尚未登记，改用显式传入的 `DSH_SUPERAGENT_SOURCE`。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { normalizePath } from './win32.ts'
import { WORKER_DISPATCH_BODY } from './worker-dispatch-source.ts'
export { WORKER_DISPATCH_BODY }

/** 调度器脚本路径；垫片与 git 凭据助手都经由它执行记录自己的 CLI。 */
export const workerDispatch = (stateDir: string): string => join(stateDir, 'worker-dispatch.mjs')
/** 分发数据文件路径。 */
const workerSources = (stateDir: string): string => join(stateDir, 'worker-sources.json')

/** 一条来源记录在执行侧需要的信息。 */
export interface WorkerRecord { kind: string; cli: string }
/** 分发数据：每个记录的种类与 CLI，以及已登记的工单目录。 */
interface WorkerSources { clis: Record<string, WorkerRecord>; tickets: Record<string, string> }

/**
 * 目录键：绝对路径，Windows 上统一小写（环境变量名与路径大小写不敏感）。
 * 规则单源在 `infra/win32.ts` 的 `normalizePath`；调度器（workspace-gc、code-repos/sync）使用同一函数查找。
 */
export function ticketKey(directory: string): string {
  return normalizePath(directory)
}

/**
 * 按 `stateDir` 串行化读改写：`writeEnvironment` 与工单登记是两个模块，共用同一个队列才不会互相覆盖。
 * 前一次失败不影响后一次。
 */
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  const key = ticketKey(stateDir)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(run, run)
  queues.set(key, next.catch(() => { /* 失败由调用方处理；队列继续。 */ }))
  return next
}

/** 读取分发数据；文件不存在或损坏时视为空。 */
async function read(stateDir: string): Promise<WorkerSources> {
  try {
    const parsed = JSON.parse(await readFile(workerSources(stateDir), 'utf8')) as Partial<WorkerSources>
    return { clis: parsed.clis ?? {}, tickets: parsed.tickets ?? {} }
  } catch { return { clis: {}, tickets: {} } }
}

/** 原子写入分发数据，使并发的调度器进程总能看到完整内容。 */
async function write(stateDir: string, value: WorkerSources): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const file = workerSources(stateDir)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * 重写记录列表，保留工单登记，并清掉两类悬空登记：指向已删除记录的，以及目录已消失的
 * （评审 E6）——后者使登记表随工作区回收自愈收缩，而不是单调膨胀。
 */
export async function writeWorkerRecords(stateDir: string, records: Record<string, WorkerRecord>): Promise<void> {
  await serialized(stateDir, async () => {
    const current = await read(stateDir)
    const tickets = Object.fromEntries(Object.entries(current.tickets)
      .filter(([directory, id]) => id in records && existsSync(directory)))
    await write(stateDir, { clis: records, tickets })
  })
}

/** 登记工单目录的来源记录；工作单元的 shell 在该目录及其子目录中执行时据此选择 CLI。 */
export async function recordTicketSource(stateDir: string, directory: string, recordId: string): Promise<void> {
  await serialized(stateDir, async () => {
    const current = await read(stateDir)
    current.tickets[ticketKey(directory)] = recordId
    await write(stateDir, current)
  })
}

/**
 * 注销工单目录的来源登记（评审 E6）：目录被工作区回收后不再参与祖先匹配——陈旧映射
 * 会让复用旧路径的新会话选中已删除工单的记录，也使文件随工单数无界增长。
 */
export async function forgetTicketSource(stateDir: string, directory: string): Promise<void> {
  await serialized(stateDir, async () => {
    const current = await read(stateDir)
    const key = ticketKey(directory)
    if (!(key in current.tickets)) return
    delete current.tickets[key]
    await write(stateDir, current)
  })
}

