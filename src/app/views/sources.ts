/** 来源状态视图：每个来源实例的健康状态、24 小时触发器计数，以及最近被过滤或丢弃的消息。 */
import { threadKey } from '../../core/index.ts'
import type { Deployment } from '../../deployment.ts'
import type { Health } from '../../sources/host.ts'
import type { SourceInstance } from '../../sources/kind.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import type { SetupProblem } from '../../setup.ts'
import { dayAgo, snapshot, type ViewHost } from './records.ts'
import { preview } from './text.ts'

export type HealthMap = Record<string, Health>
/** 解析来源实例的健康项；已启用来源上过期的 `sourceOff` 项按 `starting` 处理。 */
export function sourceHealth(sources: SourceRegistry, instance: SourceInstance, health: HealthMap) {
  const kind = sources.kindByName(instance.kind)
  const starting: Health = { state: 'starting', detail: '' }
  const parts = (kind?.health ?? []).map(name => {
    const entry = health[name]
    return { name, ...(!entry || (instance.enabled && entry.code === 'sourceOff') ? starting : entry) }
  })
  return { id: instance.id, title: kind?.title ?? { zh: instance.id, en: instance.id }, health: parts }
}
export interface SetupState {
  /** 已解析的部署信息；机器级初始化失败时为 undefined。 */
  deployment?: Deployment | undefined
  /** 会停止所有来源的机器级初始化失败。 */
  problem?: SetupProblem | undefined
  /** 按来源记录 ID 索引的部署校验问题；单条记录失败只暂停该记录。 */
  sourceProblems?: Readonly<Record<string, SetupProblem>> | undefined
}
export const problemOf = (id: string, setup: SetupState): SetupProblem | undefined => setup.sourceProblems?.[id]
/** 来源生命周期状态，按优先级排列：类型缺失、已禁用、安装/部件错误、因全局安装受阻、启动中、已暂停或就绪。 */
export type SourceState = 'missing' | 'off' | 'error' | 'setup' | 'starting' | 'paused' | 'ready'
export function sourceState(instance: SourceInstance & { installed: boolean }, parts: { state: string }[], setup: SetupState): SourceState {
  if (!instance.installed) return 'missing'
  if (!instance.enabled) return 'off'
  if (problemOf(instance.id, setup) || parts.some(part => part.state === 'error')) return 'error'
  if (setup.problem) return 'setup'
  if (parts.some(part => part.state === 'starting')) return 'starting'
  return parts.some(part => part.state === 'paused') ? 'paused' : 'ready'
}
export function sourcesStatus(host: ViewHost, health: HealthMap, setup: SetupState) {
  const { store, sources } = host
  const view = snapshot(host)
  const since = dayAgo()
  const stats = store.read.triggerStats(since)
  const filtered = (source: string) => store.read.triggers({ source, filtered: true }, 0, 5).items.filter(trigger => trigger.at >= since)
    .map(trigger => ({ id: trigger.id, at: trigger.at, actor: view.actor(trigger.actor, trigger.human), preview: preview(trigger.text, 120),
      reason: store.triggers.disposition(trigger.id)?.filtered }))
  const dropped = droppedReplies(host)
  return sources.instances().map(instance => {
    const { health: parts, ...named } = sourceHealth(sources, instance, health)
    const problem = problemOf(instance.id, setup)
    return { ...named, installed: instance.installed, enabled: instance.enabled, state: sourceState(instance, parts, setup), health: parts,
      ...problem ? { problem } : {}, stats: stats[instance.id] ?? { received: 0, filtered: 0, lastAt: '' }, filtered: filtered(instance.id),
      dropped: dropped.filter(item => item.channel.source === instance.id) }
  })
}
export type SourceStatusView = ReturnType<typeof sourcesStatus>[number]
/** 过去 24 小时内被丢弃的回复，附带其关联的工单与线程。 */
export function droppedReplies({ store, links }: Pick<ViewHost, 'store' | 'links'>) {
  // 精确获取 24 小时内被丢弃的数量，使该列表长度与概览中的 `dropped` 指标一致。
  return store.read.droppedReplies(store.read.droppedSince(dayAgo())).map(item => {
    const ticket = item.ticketId ? store.tickets.get(item.ticketId) : undefined
    const { triggerId } = links(item.channel)
    const home = triggerId ? store.triggers.get(triggerId)?.threads[0] : undefined
    const thread = home ? threadKey(home) : store.threads.get(item.channel.thread) ? item.channel.thread : undefined
    return { id: item.id, kind: item.kind, channel: item.channel, preview: preview(item.text), dropped: item.dropped,
      ...ticket ? { ticket: { id: ticket.id, title: ticket.title } } : {}, ...thread ? { thread } : {} }
  })
}
