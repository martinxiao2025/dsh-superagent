/** `orchestrator_route`：一次调用中按顺序为多个触发器给出路由决策。 */
import { z } from 'zod'
import { UserError, reasonText, type Decision, type DecisionKind } from '../../../core/index.ts'
import { IM_WORDS, NOTE_WORDS, wordCount } from '../../../infra/text.ts'
import { ticketCard } from '../../cards.ts'
import { WorktreeNameSchema } from '../../../executor/format.ts'
import type { MainToolsHost } from '../host.ts'
import { AcknowledgementSchema, tool, type Tool } from '../tool.ts'

const RoutingNoteSchema = z.string().trim()
  .refine(text => wordCount(text) <= NOTE_WORDS, `Routing note must not exceed ${NOTE_WORDS} words (Chinese uses word segmentation). Shorten it; do not split it across deliveries.`)
  .describe(`Optional routing background or explicit human constraint, at most ${NOTE_WORDS} words. Never add implementation instructions or replace the original source.`)
const fromDecision = (decision: Decision) => ({ decision: decision.kind, reason: reasonText(decision.reason), ticketId: decision.ticketId })
/**
 * `orchestrator_route` 的一条路由决策。该 schema 只约束其结构：每种 kind 的字段在其条目执行时才校验
 * （见 `FIELDS`），因此缺少某字段或取值越限的条目只会单独被拒绝。
 */
const RouteItemSchema = z.object({
  kind: z.enum(['accept', 'attach', 'ignore', 'stop']),
  trigger_id: z.string().describe('The candidate card\'s trigger_id; deciding it decides its batch.'),
  ticket_id: z.string().nullish().describe('attach and stop: the ticket.'),
  title: z.string().nullish().describe('accept: a short label of at most 200 characters describing the original request; no added requirements or implementation advice.'),
  worktree_name: z.string().nullish().describe(`accept: ${WorktreeNameSchema.description ?? ''}`),
  acknowledgement: z.string().nullish().describe(`accept: one brief sentence of at most ${IM_WORDS} words naming the concrete change and intended result in the source language. It is posted as a reply to the original source on acceptance, so do not quote the source; quote an earlier proposal briefly only when the trigger merely confirms it and the sentence does not already state it. No generic I will handle it.`),
  note: z.string().nullish().describe(`accept and attach: ${RoutingNoteSchema.description ?? ''}`),
  reason: z.string().nullish().describe('ignore and stop: why, at most 500 characters; an ignore needs it.'),
}).strict()
type RouteItem = z.infer<typeof RouteItemSchema>
type Kind = RouteItem['kind']
type Field = Exclude<keyof RouteItem, 'kind' | 'trigger_id'>
/** 每个字段的校验规则、会读取该字段的 kind 以及必须提供该字段的 kind；其他 kind 的条目不会读取它。 */
const FIELDS: Record<Field, { check: z.ZodType; reads: readonly Kind[]; needs: readonly Kind[] }> = {
  ticket_id: { check: z.string(), reads: ['attach', 'stop'], needs: ['attach', 'stop'] },
  title: { check: z.string().max(200), reads: ['accept'], needs: ['accept'] },
  worktree_name: { check: WorktreeNameSchema, reads: ['accept'], needs: ['accept'] },
  acknowledgement: { check: AcknowledgementSchema, reads: ['accept'], needs: ['accept'] },
  note: { check: RoutingNoteSchema, reads: ['accept', 'attach'], needs: [] },
  reason: { check: z.string().max(500), reads: ['ignore', 'stop'], needs: ['ignore'] },
}
/** 条目无法执行的原因：其 kind 需要的字段缺失，或其读取的字段超出限制。 */
function invalid(item: RouteItem): string | undefined {
  for (const [field, { check, reads, needs }] of Object.entries(FIELDS) as [Field, typeof FIELDS[Field]][]) {
    const value = item[field]
    if (!reads.includes(item.kind)) continue
    if (value === undefined || value === null || value.trim() === '') {
      if (needs.includes(item.kind)) return `${item.kind} needs ${field}`
      continue
    }
    const checked = check.safeParse(value)
    if (!checked.success) return `${field}: ${checked.error.issues[0]?.message ?? 'invalid'}`
  }
  return undefined
}
type Routed = { decision?: DecisionKind; reason: string; ticketId?: string | undefined; triggerIds?: readonly string[] }
/**
 * 在独立事务中把一条路由决策作为其引擎命令执行。`decided` 保存本次调用中较早条目已决定的触发器及其批次。
 */
function route(host: MainToolsHost, item: RouteItem, decided: ReadonlyMap<string, string>): Routed | { refused: string } {
  const note = item.note ? { note: item.note } : {}
  // 较早条目已决定的触发器随该条目的决策一起处理，其作为该批次成员时也是如此。
  // 针对另一个工单将其停止，交由引擎判断。
  const earlier = decided.get(item.trigger_id)
  if (earlier && item.kind === 'ignore') return { refused: `Decided in this call with ${earlier}, whose Decision took its batch` }
  switch (item.kind) {
    case 'accept': {
      const before = host.store.triggers.disposition(item.trigger_id)?.decisionId
      const decision = host.engine.decide(item.trigger_id, { kind: 'accept', title: item.title!, scope: item.title!, reason: { code: 'explicitRouted' },
        acknowledgement: item.acknowledgement!, name: item.worktree_name!, ...note })
      // 未创建工单的决策即为该条目被拒绝；此前已存在的决策保留其被接受时的状态。
      if (decision.kind !== 'accept' || !decision.ticketId) return { refused: `Ticket was not created: ${reasonText(decision.reason)}` }
      if (decision.id === before) {
        return { decision: 'accept', reason: `Already accepted as ${decision.ticketId}; title and acknowledgement unchanged`, ticketId: decision.ticketId }
      }
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'attach': {
      const ticket = host.quietly(() => host.engine.attach(item.ticket_id!, item.trigger_id, item.note ?? undefined))
      return { reason: 'Attached: the ticket follows the trigger\'s thread and receives the trigger', ticketId: ticket.id }
    }
    // 经由 `engine.decide`，因此只有门禁以显式强度接纳的人员消息才能停止工单。
    case 'stop': {
      const decision = host.engine.decide(item.trigger_id, { kind: 'stop', ticketId: item.ticket_id!, reason: item.reason || { code: 'humanStop' } })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'ignore': {
      const decision = host.engine.decide(item.trigger_id, { kind: 'ignore', reason: item.reason! })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
  }
}
export function routeTool(host: MainToolsHost): Tool {
  return tool({
    name: 'orchestrator_route',
    description: 'Route candidates, one item each by the card\'s trigger_id, in one call: accept an explicit request as a new ticket, attach a trigger to an existing ticket, stop a ticket on a person\'s stop message, or ignore a candidate that needs no ticket or stop, as dispatch says. Items run in order and each is answered on its own; a refused item leaves the others. An inferred candidate may be ignored here; accepting one goes through orchestrator_eval_decide.',
    schema: z.object({ decisions: z.array(RouteItemSchema).min(1).max(20) }).strict(),
    execute: async ({ decisions }) => {
      const decided = new Map<string, string>()
      const results = decisions.map(item => {
        const head = { trigger_id: item.trigger_id, kind: item.kind }
        const problem = invalid(item)
        if (problem) return { ...head, refused: problem }
        try {
          const result = route(host, item, decided)
          if ('refused' in result) return { ...head, ...result }
          for (const id of result.triggerIds ?? []) if (!decided.has(id)) decided.set(id, item.trigger_id)
          const ticket = result.ticketId ? host.store.tickets.get(result.ticketId) : undefined
          return { ...head, ...(result.decision ? { decision: result.decision } : {}), reason: result.reason,
            ...(ticket ? { ticket: ticketCard(ticket) } : {}) }
        } catch (error) {
          if (error instanceof UserError) return { ...head, refused: error.message }
          host.context.logger.warn('dsh-superagent could not route trigger %s: %s', item.trigger_id, String(error))
          return { ...head, refused: `Not recorded: ${error instanceof Error ? error.message : String(error)}; retry this item` }
        }
      })
      host.requestPass()
      return { results }
    },
  })
}
