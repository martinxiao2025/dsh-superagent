/** 跨会话重启向 DSH 智能体进行幂等的消息投递。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-superagent': { kind: 'dsh-superagent' } & ContextFormed
  }
}

type Seen = { ids: Set<string>; loaded?: Promise<void> }
/** 在 `requestId` 下投递的消息 id，每次重试都相同。 */
export const messageId = (requestId: string) => MessageId(`dsh-superagent:${requestId}`)
/** 从当前或旧版插件消息来源中提取幂等键。 */
function deliveryId(message: UserMessage): string | undefined {
  // 持久化的来源可能早于当前按生产者区分的来源映射。
  const source: { kind: string; plugin?: unknown; rpcId?: unknown } = message.source
  if (source.kind === 'dsh-superagent' || (source.kind === 'plugin' && source.plugin === 'dsh-superagent')) return message.id
  // 经旧版用户 RPC 接纳的请求保留其原始归属。
  if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string') return messageId(source.rpcId)
}

/**
 * 在活跃会话和恢复的会话之间，按请求 ID 向 DSH 智能体至多投递一次消息。
 * 从实时会话事件、持久化历史和待处理收件箱中跟踪已投递的消息 ID，使 `Sessions` 的重试不会重复投递；
 * 并使用 `dsh-superagent` 自身的来源（`dsh-superagent`）而不是用户 RPC 来标记已投递消息，使其永远不会被误认为人写的消息。
 */
export class AgentDelivery {
  private readonly seen = new WeakMap<Session, Seen>()
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const id = deliveryId(event.data)
      if (id) this.seen.get(session)?.ids.add(id)
    })
  }
  private async history(agent: Agent): Promise<Seen> {
    let seen = this.seen.get(agent.session)
    if (!seen) { seen = { ids: new Set() }; this.seen.set(agent.session, seen) }
    const state = seen
    state.loaded ??= (async () => {
      await this.ctx.sessionPersistence.flush()
      await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      for (let offset = 0; ; ) {
        const { events } = await handle.read(offset, 512)
        if (!events.length) break
        for (const event of events) {
          if (event.type !== 'user/message') continue
          const id = deliveryId(event.data)
          if (id) state.ids.add(id)
        }
        offset += events.length
      }
    })().catch(error => { state.loaded = undefined; throw error })
    await state.loaded
    return state
  }
  async holds(agent: Agent, requestId: string): Promise<boolean> {
    const id = messageId(requestId)
    return (await this.history(agent)).ids.has(id) || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
  }
  /** 向选定的收件箱投递一次，或不唤醒智能体直接注入历史；在向生产者确认前刷新会话持久化。 */
  async send(agent: Agent, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, signal: AbortSignal, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    signal.throwIfAborted()
    const seen = await this.history(agent)
    signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    authorize?.()
    const id = messageId(requestId)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
    if (!seen.ids.has(id) && !pending) {
      const source = typeof mode === 'object' ? { kind: 'dsh-superagent' as const, form: 'notice' as const, summary: mode.inject }
        : { kind: 'dsh-superagent' as const, form: 'relay' as const }
      const message = freezeMessage({ id, role: 'user' as const, content: [{ type: 'text' as const, text }], source })
      if (typeof mode === 'object') { agent.inject(message); seen.ids.add(id) }
      else if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
    }
    accepted?.()
    await this.ctx.sessionPersistence.flush()
  }
}
