/** Web 面板与宿主路由之间的纯类型管理 API 契约；面板导入它时不会打包宿主代码。 */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { HealthView, PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { ProjectTasksView } from './views/projects.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { SourceCheck } from '../setup.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { QueueSnapshot } from '../queue/model.ts'
import type { ResetReport } from './reset.ts'
import type { CredentialCheck } from '../secrets/check.ts'
import type { GitCredentialInput, GitCredentialView } from '../git-credentials/kind.ts'
import type { FeishuCredentialInput, FeishuCredentialView } from '../feishu-credentials/kind.ts'
import type { Project } from '../projects/kind.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** 上下文更新是已注入主会话，还是仍在等待投递。 */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'POST sources': { body: { kind: string; id?: string; name: string; config?: unknown }; response: { id: string; revision: number; restarting: true } }
  'POST sources/verify': {
    body: { kind: string; id?: string; name?: string; config?: unknown; field?: string }
    response: { checks: SourceCheck[] }
  }
  'DELETE sources/:id': { response: { removed: true; restarting: true } }
  'POST code-repos/verify': {
    body: { kind: 'github' | 'gitlab'; id?: string; name?: string; config?: unknown; field?: string; gitCredential?: string }
    response: { checks: SourceCheck[] }
  }
  /** 向导分支选择：按候选配置与 Git 凭据真实 ls-remote，返回分支列表与默认分支。 */
  'POST code-repos/branches': {
    body: { kind: 'github' | 'gitlab'; config?: unknown; gitCredential?: string }
    response: { remote: string; branches: string[]; defaultBranch: string }
  }
  /** 016 标准任务清单模板；内容是 base64 编码的 xlsx。 */
  'GET task-format/template': { response: { filename: string; content: string } }
  /** 任务来源预检：仓库候选与凭据由项目提供，驱动据此读取真实任务。 */
  'POST task-sources/verify': {
    body: { kind: string; id?: string; name?: string; config?: unknown; field?: string; projectId?: string
      repo?: { kind: 'github' | 'gitlab'; config: Record<string, unknown> }; gitCredential?: string; feishuCredential?: string }
    response: { checks: SourceCheck[] }
  }
  /** 新建项目接受完整配置：向导一次提交仓库、任务来源、执行目录、轮询、重试与状态策略。 */
  'POST projects': { body: { id?: string } & Project; response: { id: string; revision: number; restarting: boolean } }
  'DELETE projects/:id': { response: { removed: true; restarting: boolean } }
  'GET projects/:id/tasks': { response: ProjectTasksView }
  'GET git-credentials': { response: { credentials: GitCredentialView[] } }
  'GET git-credentials/:id': { response: GitCredentialView }
  'POST git-credentials': { body: { id?: string; value: GitCredentialInput }; response: { id: string; revision: number } }
  'PUT git-credentials/:id': { body: { value: GitCredentialInput; revision: number }; response: { revision: number } }
  'POST git-credentials/:id/rotate': { body: Partial<GitCredentialInput>; response: { revision: number } }
  'POST git-credentials/verify': {
    body: { id?: string; value?: Partial<GitCredentialInput>; repository?: string }
    response: { checks: CredentialCheck[] }
  }
  'DELETE git-credentials/:id': { response: { removed: true } }
  'GET feishu-credentials': { response: { credentials: FeishuCredentialView[] } }
  'GET feishu-credentials/:id': { response: FeishuCredentialView }
  'POST feishu-credentials': { body: { id?: string; value: FeishuCredentialInput }; response: { id: string; revision: number } }
  'PUT feishu-credentials/:id': { body: { value: FeishuCredentialInput; revision: number }; response: { revision: number } }
  'POST feishu-credentials/:id/rotate': { body: Partial<FeishuCredentialInput>; response: { revision: number } }
  /** 飞书群消息任务来源的群 ID 选择：按凭据真实列出机器人已加入的群。 */
  'POST feishu-im/chats': { body: { credential: string }; response: { chats: { id: string; name: string }[] } }
  'POST feishu-credentials/verify': {
    body: { id?: string; value?: Partial<FeishuCredentialInput>; spaceId?: string }
    response: { checks: CredentialCheck[] }
  }
  'DELETE feishu-credentials/:id': { response: { removed: true } }
  'GET health': { response: HealthView }
  'GET queue': { response: QueueSnapshot }
  'POST queue/:id/retry': { response: { retried: boolean } }
  'POST queue/:id/cancel': { response: { cancelled: boolean } }
  'POST queue/clear': { query?: { project?: string }; response: { cancelled: number } }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'POST admin/reset': { body: { confirm: 'RESET' }; response: ResetReport }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
