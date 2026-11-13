/** 触发器摄入、线程关联、订阅分发与评估排队。 */
import { key } from './ids.ts'
import { isoTime, liveTicket, threadKey } from './model.ts'
import type { Ticket, Trigger } from './model.ts'
import { EnginePart, touchThread, type EngineOptions, type Requeues } from './part.ts'
import type { Tickets } from './tickets.ts'
import type { Inputs } from './inputs.ts'

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/**
 * 摄入来自来源的传入触发器，先按 SourceScope 去重和过滤，再记录线程关联。
 * 把被监听的触发器通过 Tickets 分发给已订阅的工单，并把每个没有工单的工作单元决定的触发器
 * 在其主线程上排队等待评估（见 `followupOwners`）。
 * Engine 把触发器接收工作委托给该部分。
 */
export class Intake extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly inputs: Inputs, private readonly requeues: Requeues) {
    super(options)
  }

  receive(received: Trigger): ReceiveResult {
    // 把来源时间戳（例如 GitHub 的整秒时间）规范化为标准 ISO 形式。
    const trigger = { ...received, at: isoTime(received.at) }
    if (!trigger.threads.length) throw new Error('A trigger must belong to at least one thread')
    if (this.repo.triggers.get(trigger.id)) return 'duplicate'
    const at = this.now()
    const filter = this.options.scope.scope(trigger)
    if (!filter.listened) {
      this.repo.triggers.save(trigger); this.repo.triggers.saveDisposition(trigger.id, { filtered: { code: filter.reason }, fanout: [], at })
      return 'filtered'
    }
    this.repo.triggers.save(trigger)
    const keys = trigger.threads.map(threadKey)
    // 记录到达的工单以及是否仅通过上下文线程到达（工单自身的线程会使 `context` 为 false）。
    const reached = new Map<string, { ticket: Ticket; context: boolean }>()
    for (const ref of trigger.threads) {
      const thread = touchThread(this.repo, ref, trigger.at, at)
      thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
      for (const ticketId of thread.subscriptions) {
        const ticket = this.repo.tickets.get(ticketId)
        // 只有非上下文线程上的人的消息才能恢复已结束的工单；机器人和 CI 不行（执行器恢复时会重新读取
        // 线程），被人停止的工单什么也不会收到，因为其授权已被撤回。
        const followed = !!thread.context?.includes(ticketId)
        const resumes = trigger.human && ticket?.ended?.by !== 'human' && !followed
        if (!ticket || (!liveTicket(ticket) && !resumes)) continue
        reached.set(ticketId, { ticket, context: followed && (reached.get(ticketId)?.context ?? true) })
      }
      this.repo.threads.save(thread)
    }
    for (const [ticketId, { ticket, context: followed }] of reached) {
      this.inputs.addInput(ticket, { id: key('input', ticketId, 'trigger', trigger.id), kind: 'trigger', triggerId: trigger.id, at,
        ...trigger.human ? { human: true } : {}, ...followed ? { context: true } : {} })
    }
    const fanout = [...reached.keys()], context = fanout.filter(id => reached.get(id)!.context)
    const disposition = { fanout, ...context.length ? { context } : {}, at }
    this.repo.triggers.saveDisposition(trigger.id, disposition)
    // 没有工单决定的人的消息（例如只到达了被人停止的工单、或为上下文而关注该线程的工单的消息），
    // 以及所有机器人的消息，都进入评估。
    if (!this.owners(trigger).length) this.requeues.queueForEval(trigger)
    for (const ticketId of fanout) this.tickets.wake(ticketId)
    this.emit('trigger.received', { triggerId: trigger.id, threads: trigger.threads.map(threadKey) })
    return 'stored'
  }
}
