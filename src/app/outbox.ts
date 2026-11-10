/** 基于持久化回执和重试回复副作用的可靠出站消息投递。 */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'kindOf' | 'channelAllowed' | 'send'>
  readonly commands: Commands
  paused(): boolean
}

/**
 * 将出站渠道消息持久化为回执，并通过 `Effects` 和 `SourceRegistry` 依次投递。
 * 为核心 `Outbox` 端口实现 `Engine` 和来源上下文所需的语义，确保每个工单在每个会话中的顺序，直到较早的消息反复失败。
 * 处理暂停或来源不可用时消息会等待；当目标会话被忽略或已不存在时，会以丢弃状态结算。
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /** 原子地记录消息回执并为其投递副作用入队；重复的消息 ID 会被忽略。 */
  send(message: OutboundMessage): void {
    // 在此校验 IM 回复长度；回执在决定时已校验过。
    if (message.kind === 'reply' && this.host.sources.kindOf(message.channel.source)?.kind === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.add(message)) effects.enqueue('reply', message.id, {}) })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }
  sent(): Promise<void> { return this.host.effects.idle('reply') }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // 同一工单、同一会话的后续消息会排在较早的待处理消息之后，直到后者超过失败阈值。
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // 永久不可达的目标（如已撤回的消息或已删除的 Issue）以 `channelGone` 结算，其回执可防止重试。
    const result = await sources.send(receipt, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
