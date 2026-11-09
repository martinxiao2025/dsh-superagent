/** 线程列表、时间线详情、跨实体搜索，以及决策列表视图。 */
import { threadKey, type Thread, type Ticket, type Trigger } from '../../core/index.ts'
import type { ThreadFilter } from '../api.ts'
import type { TextCache } from '../cache.ts'
import { awaitingEval, channelLink, dayAgo, decisionView, newestFirst, page, snapshot, threadSummary, threadTitle, ticketLine,
  ticketSummary, triggerView, type ViewHost } from './records.ts'
import { attribute } from './text.ts'

export function threadList(host: ViewHost, filter: ThreadFilter, offset: number, limit: number) {
  const { store } = host
  const view = snapshot(host)
  const since = dayAgo()
  const open = new Set(store.tickets.open().map(ticket => ticket.id))
  const live = (thread: Thread) => thread.subscriptions.some(id => open.has(id))
  const lastAt = (thread: Thread) => thread.lastAt ?? thread.createdAt
  const kept = (thread: Thread) => filter === 'recent' ? lastAt(thread) >= since
    : filter === 'all' || (filter === 'subscribed' ? live(thread) : !!thread.evaluating || awaitingEval(view, thread).length > 0)
  const candidates = filter === 'subscribed' ? store.read.subscribedThreads()
    : filter === 'evaluating' ? store.threads.active() : store.threads.list()
  const threads = candidates.filter(kept).sort((a, b) => lastAt(b).localeCompare(lastAt(a)))
  const result = page(threads, offset, limit)
  return { ...result, items: result.items.map(thread => threadSummary(view, thread)) }
}
export type ThreadListView = ReturnType<typeof threadList>
/**
 * 线程时间线，触发器按从旧到新排列，内联展示决策与所订阅的工单。
 * `before` 向前翻页；`around` 将页锚定在指定的触发器上。
 */
export function threadDetail(host: ViewHost, key: string, before: string | undefined, limit: number, around?: string) {
  const { store } = host
  const thread = store.threads.get(key)
  if (!thread) return undefined
  const view = snapshot(host)
  const target = around ? store.triggers.get(around) : undefined
  // 游标同时携带时间戳与 id，使同一秒内的触发器（例如 GitHub 的时间戳）能确定性地分页。
  const [at = '', id = ''] = before?.split('|') ?? []
  const triggers = target ? store.read.threadTriggers(key, limit + 1, target, true)
    : store.read.threadTriggers(key, limit + 1, before ? { at, id } : undefined)
  const decisions = store.decisions.byThread(key)
  const more = triggers.length > limit
  const shown = more ? triggers.slice(1) : triggers
  const first = store.read.firstTrigger(key)
  const url = attribute(thread.meta.url) ?? first?.url ?? (first?.channel ? channelLink(view, first.channel).url : undefined)
  // `context` 列出仅因上下文而让执行器跟随该线程的工单（消息会到达它们，但不授予权限）。
  return { ...threadSummary(view, thread), url, context: thread.context ?? [],
    correlated: thread.correlated.map(other => {
      const value = store.threads.get(other)
      return { key: other, title: value ? threadTitle(store, value) : other }
    }),
    tickets: thread.subscriptions.flatMap(id => { const ticket = store.tickets.get(id); return ticket ? [ticketLine(view, ticket)] : [] }),
    decisions: decisions.slice().reverse().map(decision => decisionView(view, decision)),
    timeline: shown.map(trigger => triggerView(view, trigger, decisions)), earlier: more ? `${shown[0]!.at}|${shown[0]!.id}` : null }
}
export type ThreadDetailView = NonNullable<ReturnType<typeof threadDetail>>
/**
 * 按文本、ID、来源提取的引用（例如 `#N`、URL）或缓存的飞书 AppLink 搜索触发器、线程与工单。
 * @param links - 自启动以来缓存的飞书消息 AppLink，以会话和消息 ID 为键。
 */
export function search(host: ViewHost, query: string, links: Pick<TextCache, 'entries'>) {
  const { store, sources } = host
  const value = query.trim()
  if (!value) return { tickets: [], items: [], threads: [] }
  const view = snapshot(host)
  const named = sources.find(value)
  const terms = new Set([value, ...named.terms])
  for (const [name, url] of links.entries()) if (url === value) terms.add(name.split(':').at(-1)!)
  const found = new Map<string, Trigger>()
  for (const term of terms) for (const trigger of store.read.search(term)) found.set(trigger.id, trigger)
  const threads = named.threads.flatMap(key => { const thread = store.threads.get(key); return thread ? [threadSummary(view, thread)]
    : [] })
  const lower = value.toLowerCase()
  // 按工单拥有（例如绑定的 PR）或订阅的线程匹配，同时也按标题匹配。
  const reaches = (ticket: Ticket) => [...(ticket.follows ?? []).map(follow => follow.thread),
    ...view.threadsOf(ticket.id).map(thread => thread.key)]
  const matches = (ticket: Ticket) => reaches(ticket).some(key => named.threads.includes(key)) || ticket.title.toLowerCase().includes(lower)
  const tickets = store.tickets.list().filter(matches).sort(newestFirst).slice(0, 10).map(ticketSummary)
  // 省略 `threads` 中已包含的线程里的自动触发器。
  const shownThreads = new Set(threads.map(thread => thread.key))
  const item = (trigger: Trigger) => {
    const home = store.threads.get(threadKey(trigger.threads[0]!))
    const { text: _text, ...row } = triggerView(view, trigger)
    // 被其来源过滤的触发器没有线程记录；改为展示过滤原因。
    const filtered = home ? {} : { filtered: store.triggers.disposition(trigger.id)?.filtered ?? '' }
    return { ...row, threadTitle: home ? threadTitle(store, home) : undefined, ...filtered }
  }
  const items = [...found.values()].filter(trigger => trigger.human || !shownThreads.has(threadKey(trigger.threads[0]!)))
  return { tickets, items: items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20).map(item), threads }
}
export type SearchView = ReturnType<typeof search>
export function decisionList(host: ViewHost, kinds: string[], offset: number, limit: number, since = '') {
  const { items, more } = host.store.read.decisions({ kinds, since }, offset, limit)
  const view = snapshot(host)
  return { items: items.map(decision => decisionView(view, decision)), next_offset: more ? offset + limit : null }
}
export type DecisionListView = ReturnType<typeof decisionList>
