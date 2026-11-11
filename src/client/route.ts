/** 类型化面板路由、路由解析器，以及 sessionStorage 位置历史。 */
import { THREAD_FILTERS, TICKET_FILTERS, type ThreadFilter, type TicketFilter } from '../app/api.ts'
import type { SetupPlace } from '../setup.ts'
import { DECISION_FILTERS, type DecisionFilter } from './api.ts'
import type { T } from './text.ts'

/** 面板可路由的页面；消息来源状态保留直达链接，但不再占据主菜单。 */
export const TABS = ['overview', 'projects', 'source', 'trigger', 'eval', 'execution', 'settings'] as const
export type Tab = typeof TABS[number]
/** 主菜单：概览之后先进入项目这一交付单元；消息来源从概览与项目设置进入。 */
export const MENU_TABS: readonly Tab[] = ['overview', 'projects', 'trigger', 'eval', 'execution', 'settings']
/** 设置分组按创建与使用流程排列：先凭据，再项目（含仓库与任务来源），最后系统级配置。 */
export const SETTINGS_GROUPS = ['gitCredentials', 'feishuCredentials', 'projects', 'eval', 'execution', 'prompts', 'deployment'] as const
export type SettingsGroup = typeof SETTINGS_GROUPS[number]
export type Route = { page: 'overview' | 'source'; id?: undefined; query?: undefined }
  | { page: 'projects'; id?: string; query?: undefined }
  | { page: 'trigger'; id?: undefined; query?: { filter?: ThreadFilter } }
  | { page: 'trigger'; id: string; query?: { trigger?: string } }
  | { page: 'eval'; id?: undefined; query?: { filter?: DecisionFilter; window?: '24h' } }
  | { page: 'execution'; id?: undefined; query?: { filter?: TicketFilter } }
  | { page: 'execution'; id: string; query?: undefined }
  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup; source?: string; version?: string } }
export const HOME: Route = { page: 'overview' }
export const settingsRoute = (group: SettingsGroup, query: { source?: string; version?: string } = {}): Route =>
  ({ page: 'settings', query: { group, ...query } })
export const setupPage = (place: SetupPlace): Route => {
  if (place === 'deployment') return settingsRoute('deployment')
  // 项目仓库的来源标识带 `repo-` 前缀；打开对应的项目设置卡片。
  return settingsRoute('projects', { source: place.startsWith('repo-') ? place.slice(5) : place })
}
export const routeLabel = (t: T, route: Route): string =>
  route.id ? t(route.page === 'trigger' ? 'term.thread' : route.page === 'projects' ? 'term.project' : 'term.ticket') : t(`tab.${route.page}`)

const pick = <V extends string>(values: readonly V[], value: unknown): V | undefined => values.find(item => item === value)
function compact<Q extends object>(query: Q): Q | undefined {
  const set = Object.entries(query).filter(([, value]) => value !== undefined)
  return set.length ? Object.fromEntries(set) as Q : undefined
}
/** 校验并规范化已存储的路由，丢弃无法识别的查询过滤条件或已移除的标签（例如遗留的 `policy` 标签）。 */
export function parseRoute(value: unknown): Route | undefined {
  const { page, id, query } = (value ?? {}) as { page?: unknown; id?: unknown; query?: Record<string, unknown> }
  const text = (name: string) => typeof query?.[name] === 'string' ? query[name] as string : undefined
  const record = typeof id === 'string' && id ? id : undefined
  switch (page) {
    case 'overview': case 'source': return { page }
    case 'projects': return record ? { page, id: record } : { page }
    case 'trigger': return record ? { page, id: record, query: compact({ trigger: text('trigger') }) }
      : { page, query: compact({ filter: pick(THREAD_FILTERS, query?.filter) }) }
    case 'eval': return { page, query: compact({ filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' as const : undefined }) }
    case 'execution': return record ? { page, id: record } : { page, query: compact({ filter: pick(TICKET_FILTERS, query?.filter) }) }
    case 'settings': return { page, query: { group: pick(SETTINGS_GROUPS, query?.group) ?? 'projects',
      ...compact({ source: text('source'), version: text('version') }) } }
    default: return undefined
  }
}

const ROUTE_KEY = 'dsh-superagent/route'
export interface Location { route: Route; stack: Route[]; group?: SettingsGroup | undefined }
export const lastSettingsGroup = ({ route, group }: Location): SettingsGroup => route.page === 'settings' ? route.query.group
  : group ?? 'projects'
export function initialLocation(): Location {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') as { route?: unknown; stack?: unknown; group?: unknown } | null
    const route = parseRoute(stored?.route)
    const stack = Array.isArray(stored?.stack) ? stored.stack as unknown[] : []
    if (route) return { route, stack: stack.flatMap(item => parseRoute(item) ?? []), group: pick(SETTINGS_GROUPS, stored?.group) }
  } catch (error) {
    // 路由记忆只是一种便利；无法读取的值会回退到 HOME。
    void error
  }
  return { route: HOME, stack: [] }
}
export function remember(location: Location): void {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch (failure) { void failure /* 路由记忆只是一种便利。 */ }
}
