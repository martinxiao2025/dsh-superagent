/** 组件健康状态与登记表，在总览和来源状态面板中显示；类型在此定义，来源宿主等模块按需导入。 */
import { fill } from './text.ts'

/** 固定的英文健康模板（`{name}` 占位符）；面板按界面语言本地化每个 `code`。 */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  feishuCliUnset: 'The Source is on, and its bot lark-cli is not set',
  feishuBotMissing: 'Waiting for the Feishu bot',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
/** 健康条目所属的子系统；面板据此区分运行时、写回、调度、同步与沟通故障。 */
export const HEALTH_CATEGORIES = ['runtime', 'writeback', 'schedule', 'sync', 'workspace', 'communication'] as const
export type HealthCategory = typeof HEALTH_CATEGORIES[number]
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: HealthCode; values?: Record<string, string>;
  category?: HealthCategory }
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} }
}

export interface HealthEntry {
  get(): Health | undefined
  set(health: Health): void
  /** 从登记板注销该条目（例如某种来源类型被注销时）；之后的 `set` 调用变为空操作。 */
  release(): void
}

/**
 * 组件健康条目的中央登记表，按条目名称强制单一写入者所有权。
 * 由 Runtime、Effects、Sessions、DshExecutor、Settings 和 SourceRegistry 认领，并由管理 HTTP 路由读取。
 */
export class HealthBoard {
  private readonly entries: Record<string, Health> = {}
  private readonly claimed = new Set<string>()
  claim(name: string, initial?: Health): HealthEntry {
    if (this.claimed.has(name)) throw new Error(`The health entry ${name} is reported by another part`)
    this.claimed.add(name)
    if (initial) this.entries[name] = initial
    let held = true
    return {
      get: () => this.entries[name],
      set: health => { if (held) this.entries[name] = health },
      release: () => {
        if (!held) return
        held = false
        this.claimed.delete(name)
        delete this.entries[name]
      },
    }
  }
  get all(): Readonly<Record<string, Health>> { return this.entries }
}
