/** 连接来源插件与应用的宿主和上下文接口；Web 面板也会导入，因此不得导入仅限 Node 的模块。 */
import type { ChannelRef, ReceiveResult, OutboundMessage, Thread, ThreadFact, ThreadRef, Ticket, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment, ResolvedSource } from '../deployment.ts'
import type { SourceRegistry } from './registry.ts'
import type { SetupProblem } from '../setup.ts'
import type { Family, Key } from '../kv.ts'
import { fill } from '../infra/text.ts'

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
export interface SourceHost {
  readonly sources: SourceRegistry
  /** 返回某条来源记录的上下文；它的 `report` 只写入该记录的健康条目。 */
  context(kind: { kind: string; health: readonly string[] }, id: string): SourceContext
}
/** 来源在线程上发布的显示标签、URL 和事实（`null` 删除某项事实）。 */
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }
/** 向来源种类暴露的应用能力：读取状态、接收触发器、管理线程/工单以及报告健康。 */
export interface SourceContext {
  /** 这条上下文所属的来源记录 ID；触发器、线程、健康项都按它命名。 */
  readonly id: string
  readonly deployment: Deployment
  /** 这条记录解析出的来源；记录尚未通过部署检查时为 undefined。 */
  readonly source: ResolvedSource | undefined
  readonly commands: Commands
  /** 应用状态目录；流水线等需要自有工作目录的来源使用它。 */
  readonly stateDir: string
  readonly ready: Promise<void>
  /** 设置解析出仓库和账号后为 true；来源只在此时轮询。 */
  configured(): boolean
  /** 这条记录的部署校验问题；没有问题时为 undefined。 */
  readonly problem?: SetupProblem | undefined
  /** 这条记录启用时返回它的配置，禁用或不存在时返回 undefined。 */
  config<C extends Record<string, unknown>>(): C | undefined
  /** 把触发器接入引擎并安排下一次评估；调用方应在推进读取游标前等待完成。 */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  atomic<T>(work: () => T): T
  /** 来源作用域的 KV 记录（例如读取游标）；设置 `undefined` 会删除条目。 */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void; keys<V>(family: Family<V, never>): Key<V>[] }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** 在重新读取线程后设置或删除（`undefined`）线程 `meta` 中的键；不存在的线程保持不变。 */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** 未关闭的工单，最新的在前。 */
    open(): Ticket[]
    /** 把未关闭的工单绑定为跟随来源线程（工单自己打开时 `own`），由线程关闭而非就绪报告结束工单。 */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** 报告被跟随的线程在 `at` 关闭；每个跟随它的未关闭工单在不再有 `own` 线程未关闭且没有恢复的工作仍在运行时结束。 */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; /** 线程上最新的触发器。 */ latest(thread: string): Trigger | undefined }
  notify(message: OutboundMessage): void
  /** 报告此种类声明的某个健康条目的状态；对未声明的条目名抛出。 */
  report(entry: string, health: Health): void
}
export const sourceContext = (host: SourceHost, kind: { kind: string; health: readonly string[] }, id: string): SourceContext =>
  host.context(kind, id)
