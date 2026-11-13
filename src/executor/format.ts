/** 面向模型的工单文本格式化：会话 ID、工作单元消息、触发器卡片与工作树命名规则。纯函数模块，
 * 供执行器、通知、卡片、资源与会话共享，只依赖领域内核与 zod。 */
import { z } from 'zod'
import { key, threadKey, type Mandate, type PolicyEffect, type Ticket, type TicketInput, type Trigger } from '../core/index.ts'

/** 返回工单的工作单元会话 ID（`worker-<ticketId>`）。 */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** 从工作单元会话 ID（`worker-<ticketId>`）返回工单 ID；非工作单元会话返回 undefined。 */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
/**
 * 返回工作单元在请求之外的额外系统提示词授权说明：对于按规则主动承接的工作（`strength === 'inferred'`），
 * 把授权限制为规则范围内的少量内部改动；显式请求返回 `''`。
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}
/** 简短的小写 kebab-case 英文工单工作树名称的模式（1–4 个单词，最多 32 个字符）。 */
export const WorktreeNameSchema = z.string().max(32).regex(/^[a-z]+(?:-[a-z0-9]+){0,3}$/, 'Use 1–4 short English words in lowercase kebab-case, at most 32 characters').describe('Meaningful short English ticket name, e.g. fix-plan-color. Translate Chinese titles into English; no Chinese, pinyin or generic ticket names. 1–4 lowercase words in kebab-case, at most 32 characters.')
/** 工作单元消息中内联触发器文本的字符上限；更长的文本通过其资源读取。 */
const TRIGGER_CHARS = 600
/** 返回最多 `limit` 个字符的 `text`，或返回带截断预览、总字符数和读取全文资源路径的对象。 */
export const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * 格式化用于投递给工作单元的触发器：作者、线程、时间戳、最多 `TRIGGER_CHARS` 个字符的文本、来源消息链接、
 * 可选的路由备注，以及工作单元尚未见过的被回复消息预览。
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** 格式化工单接受批次中的同批触发器：作者、时间戳、160 字符预览和读取资源路径。 */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** 返回工单来源批次中的其他触发器（排除主 `origin.triggerId`），按时间从旧到新排列。 */
export const batchOf = (host: { store: { triggers: { get(id: string): Trigger | undefined } } }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
  + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
export const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.'
/** 格式化策略变更输入供工作单元使用；在 `effect` 出现之前记录的输入回退为一条通用通知。 */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
      + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** 工作单元会话读取工单输入全文所使用的资源路径。 */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * 格式化用于投递给工作单元的工单输入：通过 `trigger` 渲染的 `trigger`（缺失时按其 ID 和读取路径）、
 * `policy-changed` 通知、`resumed` 通知、编排器的 `note`，或按原文的 `text` 输入。
 * 对遗留的 `reopen` 输入返回 `undefined`，它们只是历史数据，因为 schema 11 迁移已把待处理的 reopen 输入转换为文本输入。
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // 标记经由仅上下文订阅到达的触发器，让工作单元知道它们并非针对该工单。
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
