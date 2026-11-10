/** 启动记录与状态目录锁：用于解释“管理路由未挂载”这类启动期故障，并在锁竞争时自动重试。 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'

/** 启动阶段：按挂载、取锁、打开存储、就绪推进，失败时停在 `failed`。 */
export type StartupPhase = 'starting' | 'http-registered' | 'locked' | 'store-open' | 'ready' | 'failed'
/** 可写入启动记录的异常摘要；栈截断，避免记录无限膨胀。 */
export interface StartupError { readonly name: string; readonly message: string; readonly stack?: string }
/** 管理路由可报告的启动状态：运行时不存在的阶段由健康接口与 503 响应透出。 */
export interface StartupStatus {
  readonly phase: StartupPhase
  readonly detail: string
  readonly stateDir: string
  readonly error?: StartupError
}
/** 一份完整的启动记录，落到 `stateDir/startup.json`。 */
export interface StartupEntry extends StartupStatus {
  readonly at: string
  readonly pid: number
  readonly listen: { host: string; port: number }
}
export const STARTUP_FILE = 'startup.json'
export const STARTUP_PREV_FILE = 'startup.prev.json'

/** 把任意异常折叠成可写入 JSON 的字段。 */
export function startupError(error: unknown): StartupError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  return { name: error.name, message: error.message, ...error.stack === undefined ? {} : { stack: error.stack.slice(0, 4000) } }
}

/**
 * 写入一份启动记录（UTF-8 无 BOM）；旧记录先转存为 `startup.prev.json`。
 * 记录只用于诊断，写失败不应影响插件运行，因此异常被吞掉。
 */
export function recordStartup(stateDir: string, entry: StartupEntry): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const target = join(stateDir, STARTUP_FILE), previous = join(stateDir, STARTUP_PREV_FILE)
    if (existsSync(target)) {
      rmSync(previous, { force: true })
      renameSync(target, previous)
    }
    const temporary = `${target}.tmp`
    writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8' })
    rmSync(target, { force: true })
    renameSync(temporary, target)
  } catch { /* 启动记录是诊断信息，写入失败不能阻止插件启动。 */ }
}

/** 已取得的状态目录锁；`onCompromised` 允许在 Runtime 构造完成后补登记抢占处理。 */
export interface StateLock {
  release(): Promise<void>
  onCompromised(handler: (error: Error) => void): void
}
export interface StateLockOptions {
  /** 总等待时长，默认 35 秒：覆盖上一个实例被强杀后锁的 30 秒过期窗口。 */
  readonly timeoutMs?: number
  /** 两次尝试之间的间隔，默认 1 秒。 */
  readonly intervalMs?: number
  /** 每次等待时收到通知，用于更新启动记录（不要在等待期间逐次打日志）。 */
  readonly onWait?: (elapsedMs: number) => void
}
const isLocked = (error: unknown): boolean => (error as { code?: string } | undefined)?.code === 'ELOCKED'

/**
 * 取得状态目录锁；锁被另一个实例持有时按间隔重试，超时后抛出最后一次错误。
 * 取锁必须发生在 `Runtime` 构造之前：服务名在构造时就被注册，构造失败后无法再次 new，
 * 因此重试只能围绕取锁进行。
 */
export async function acquireStateLock(stateDir: string, options: StateLockOptions = {}): Promise<StateLock> {
  const timeout = options.timeoutMs ?? 35_000, interval = options.intervalMs ?? 1_000, started = Date.now()
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  let handler: ((error: Error) => void) | undefined
  for (;;) {
    try {
      const release = lockSync(stateDir, { stale: 30_000, onCompromised: error => { handler?.(error) } })
      return { release: async () => { release() }, onCompromised: next => { handler = next } }
    } catch (error) {
      if (!isLocked(error) || Date.now() - started >= timeout) throw error
      options.onWait?.(Date.now() - started)
      await new Promise(resolve => setTimeout(resolve, interval))
    }
  }
}
