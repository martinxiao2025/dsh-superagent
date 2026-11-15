/** 主会话工具的宿主依赖与共享响应格式化；工具定义按文件拆分在 `definitions/`，都从这里取类型。 */
import type { Context } from '@deepseek-ai/cordis'
import { ticketCard } from '../cards.ts'
import type { DecisionKind, EngineForMainSession, EngineForPeople } from '../../core/index.ts'
import type { MasterAssessor } from '../assessment.ts'
import type { Prompts } from '../prompts.ts'
import type { ResourceHost } from '../resources.ts'
import type { Sessions } from '../sessions.ts'
import type { Settings } from '../settings.ts'
import type { Store } from '../store.ts'

export interface MainToolsHost {
  readonly context: Context
  readonly engine: Pick<EngineForMainSession, 'decide' | 'attach' | 'reply' | 'requestStatus' | 'note'> & EngineForPeople
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'threads' | 'atomic' | 'replyStatus' | 'settings'>
  readonly prompts: Pick<Prompts, 'preview' | 'save'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery' | 'modelRetry'>
  readonly settings: Pick<Settings, 'view' | 'block' | 'save' | 'pause' | 'sync'>
  readonly assessor: Pick<MasterAssessor, 'context' | 'read' | 'decide'>
  readonly resources: ResourceHost
  /** 安排一次执行，以完成由引擎命令排队的工作（例如一次 Eval 或工单恢复）。 */
  requestPass(): void
  sendReplies(): Promise<void>
  /** 在不发出自身通知的情况下运行由主会话发起的引擎命令。 */
  quietly<T>(run: () => T): T
}
/** 安排一次引擎执行以执行已记录的路由决策，并格式化工具响应。 */
export function routed(host: MainToolsHost, result: { decision?: DecisionKind; reason: string; ticketId?: string | undefined }) {
  host.requestPass()
  const ticket = result.ticketId ? host.store.tickets.get(result.ticketId) : undefined
  return { ...(result.decision ? { decision: result.decision } : {}), reason: result.reason,
    ...(ticket ? { ticket: ticketCard(ticket) } : {}) }
}
