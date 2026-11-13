/** 触发器作用域的飞书上下文读取器；取回的消息返回给模型检查，不进入接入流程。 */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { validItems, type Commands } from '../infra/commands.ts'
import { admissionImageKeys, readAdmissionImage } from './feishu-image.ts'
import { feishuRef, feishuTime, HistoricalMessageSchema, HistoryPageSchema, historyText, withMentionNames, type HistoricalMessage }
  from './feishu-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** 锚定上下文读取的保留来源消息引用；`at` 是 `chatAround` 查询所围绕的时间戳。 */
export interface FeishuRef { triggerId: string; chatId: string; messageId: string; at?: string }
const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/)
const sourceSchema = z.object({
  message_id: messageId, chat_id: z.string(), root_id: messageId.optional(), parent_id: messageId.optional(),
  thread_id: z.string().regex(/^omt?_[a-zA-Z0-9_-]+$/).optional(), deleted: z.boolean().optional(),
})
const messageSchema = z.object({
  message_id: messageId, chat_id: z.string(), content: z.string().optional(), msg_type: z.string(),
  sender: z.object({ id: z.string(), name: z.string().optional(), open_bot_id: z.string().optional(), sender_type: z.string() }),
  create_time: z.string(), update_time: z.string().optional(), updated: z.boolean().optional(), deleted: z.boolean().optional(),
  mentions: z.array(z.object({ id: z.string(), name: z.string().optional(), key: z.string().optional() })).optional(),
  message_app_link: z.string().optional(), thread_id: z.string().optional(), root_id: z.string().optional(), parent_id: z.string().optional(),
})
export type FeishuMessage = z.infer<typeof messageSchema>
/** 话题分页；消息逐条校验，因此不可读的条目只会被单独跳过并计入数量。 */
const threadSchema = z.object({ messages: z.array(z.unknown()), has_more: z.boolean(), page_token: z.string().optional(),
  thread_id: z.string() })

/** 仅读取 CLI 提供的来源消息 AppLink，不保留展开的线程内容。 */
export async function readFeishuLink(commands: Commands, ref: FeishuRef): Promise<string> {
  const id = messageId.parse(ref.messageId)
  const result = z.object({ messages: z.array(z.object({ message_id: messageId, chat_id: z.string(), message_app_link: z.url().optional(), deleted: z.boolean().optional() })) })
    .parse(await commands.lark(['im', '+messages-mget', '--message-ids', id, '--no-reactions']))
  const message = result.messages.find(item => item.message_id === id)
  if (!message || message.deleted || message.chat_id !== ref.chatId || !message.message_app_link) throw new Error('Source message link unavailable')
  return message.message_app_link
}

/** 资源引用锚定到已接受的触发器，而不是任意群或消息 ID。 */
export function feishuReferences(ref: FeishuRef) {
  const read = (section: string) => `feishu/${ref.triggerId}/${section}`
  return { skill: 'dsh-superagent-feishu', message: read('message'), root: read('root'), parent: read('parent'), thread: read('thread'),
    around: read('around') }
}

/**
 * 在任何网络请求之前校验模型提供的资源字符串；只有 `thread` 和 `around` 接受分页游标。
 * 记录段可省略：触发器 id 本身由其来源记录生成，记录段只用于与 GitHub/GitLab 保持同一写法。
 */
export function feishuResource(resource: string) {
  const match = /^feishu\/(?:([^/]+)\/)?([^/]+)\/(message|root|parent|thread|around)(?:\/([^/]+))?$/.exec(resource)
  if (!match || (match[4] && match[3] !== 'thread' && match[3] !== 'around')) {
    throw new Error('Use feishu/[<record>/]<trigger-id>/message, /root, /parent, /thread or /around; follow returned next_resource for another page')
  }
  return { record: match[1] ? decodeURIComponent(match[1]) : undefined, triggerId: match[2]!,
    section: match[3]!, cursor: match[4] ? decodeURIComponent(match[4]) : undefined }
}
/** 一次读取突发（例如话题翻页）共享的来源消息缓存：按触发器 ID 短 TTL 复用，避免每页重复 mget。 */
export type SourceMemo = Map<string, { at: number; source: z.infer<typeof sourceSchema> }>
const SOURCE_TTL_MS = 10_000
async function sourceOf(commands: Commands, ref: FeishuRef, memo?: SourceMemo) {
  const id = messageId.parse(ref.messageId)
  const hit = memo?.get(ref.triggerId)
  if (hit && Date.now() - hit.at < SOURCE_TTL_MS && hit.source.message_id === id && hit.source.chat_id === ref.chatId) return hit.source
  // 使用原始 mget 端点读取父/根 ID，避免触发 CLI 的线程展开。
  const params = JSON.stringify({ message_ids: [id] })
  const listed = await commands.lark(['api', 'GET', '/open-apis/im/v1/messages/mget', '--params', params])
  const sourceResult = z.object({ items: z.array(sourceSchema) }).parse(listed)
  const source = sourceResult.items.find(message => message.message_id === id)
  if (!source || source.deleted) throw new Error('The source Feishu message is unavailable or deleted; retained trigger text is still readable')
  if (source.chat_id !== ref.chatId) throw new Error('Feishu source chat does not match the accepted trigger')
  memo?.set(ref.triggerId, { at: Date.now(), source })
  return source
}

export interface FeishuPage<M> { status: string; thread_id?: string; messages: M[]; next_resource: string | null; skipped?: number }
export interface FeishuOne<M> { status: string; message: M | null }
/** 读取触发器来源消息的一条消息或有界话题分页，并显式提供分页续读；`memo` 供调用方在翻页突发间复用来源消息。 */
export async function readFeishu(commands: Commands, ref: FeishuRef, resource: string, pageSize: number,
  order: 'asc' | 'desc' = 'asc', memo?: SourceMemo): Promise<FeishuPage<FeishuMessage> | FeishuOne<FeishuMessage>> {
  const request = feishuResource(resource)
  if (request.triggerId !== ref.triggerId) throw new Error('A Feishu source trigger is required')
  if (request.section === 'around') throw new Error('The chat around a message is read with feishuRead')
  const source = await sourceOf(commands, ref, memo)
  if (request.section === 'thread') {
    if (!source.thread_id) return { status: 'no_thread', messages: [], next_resource: null }
    const args = ['im', '+threads-messages-list', '--thread', source.thread_id, '--order', order, '--page-size', String(pageSize), '--no-reactions']
    if (request.cursor) args.push('--page-token', request.cursor)
    const result = threadSchema.parse(await commands.lark(args))
    const tally = { skipped: 0 }
    const messages = validItems(messageSchema, result.messages, tally)
    const outside = messages.some(message => message.chat_id !== source.chat_id
      || (message.thread_id && message.thread_id !== source.thread_id))
    if (result.thread_id !== source.thread_id || outside) throw new Error('Feishu returned messages outside the source thread')
    if (result.has_more && (!result.page_token || result.page_token === request.cursor)) throw new Error('Feishu thread pagination did not advance; history is incomplete')
    return { status: 'available', thread_id: result.thread_id, messages, ...tally.skipped ? { skipped: tally.skipped } : {},
      next_resource: result.has_more ? `feishu/${ref.triggerId}/thread/${encodeURIComponent(result.page_token!)}` : null }
  }
  const target = request.section === 'root' ? source.root_id : request.section === 'parent' ? source.parent_id : source.message_id
  if (!target) return { status: `no_${request.section}`, message: null }
  // CLI 会渲染富文本和合并转发；自动的线程回复被省略，改用显式分页。
  const result = z.object({ messages: z.array(messageSchema) }).parse(await commands.lark(['im', '+messages-mget', '--message-ids', target, '--no-reactions']))
  const message = result.messages.find(message => message.message_id === target)
  if (!message) throw new Error('The requested Feishu message is unavailable; do not infer its contents')
  if (message.chat_id !== source.chat_id) throw new Error('Feishu returned a message outside the source chat')
  return { status: message.deleted ? 'deleted' : 'available', message }
}
function isoTime(value: string): string {
  try { return feishuTime(value) } catch { return value }
}
export function feishuView(message: FeishuMessage): ContextMessage {
  return { id: message.message_id, from: message.sender.name || message.sender.id, at: isoTime(message.create_time),
    text: message.deleted ? '' : withMentionNames(message.content ?? '', message.mentions ?? []),
    ...message.sender.sender_type !== 'user' ? { bot: true } : {}, ...message.deleted ? { deleted: true } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {}, ...message.message_app_link ? { url: message.message_app_link } : {} }
}
/** 把聊天历史 API 的消息格式化为供模型检查的形式；历史 API 只用 `open_id` 标识发送者。 */
function historyView(message: HistoricalMessage): ContextMessage {
  return { id: message.message_id, from: message.sender.id, at: isoTime(message.create_time),
    text: message.deleted ? '' : withMentionNames(historyText(message), message.mentions ?? []),
    ...message.sender.sender_type !== 'user' ? { bot: true } : {}, ...message.deleted ? { deleted: true } : {},
    ...message.parent_id ? { reply_to: message.parent_id } : {}, ...message.message_app_link ? { url: message.message_app_link } : {} }
}
/** 读取 `ref.at` 周围的群消息（首次读取前后各五条，之后每次十页更早的消息）。 */
async function chatAround(commands: Commands, ref: FeishuRef, cursor: string | undefined, before = 5,
  after = 5): Promise<FeishuPage<ContextMessage>> {
  const time = Date.parse(ref.at ?? '')
  if (!Number.isFinite(time)) throw new Error('The source Feishu message has no time to read the chat around')
  const list = async (parameters: Record<string, unknown>) => {
    const params = JSON.stringify({ container_id_type: 'chat', container_id: ref.chatId, ...parameters })
    const page = HistoryPageSchema.parse(await commands.lark(['api', 'GET', '/open-apis/im/v1/messages', '--params', params]))
    return { ...page, items: validItems(HistoricalMessageSchema, page.items).filter(item => item.chat_id === ref.chatId) }
  }
  // 飞书以整秒为单位；来源消息本身计入较早的条目，因此 `before + 1` 会包含它及其之前的消息。
  const earlier = await list({ end_time: String(Math.ceil(time / 1000)), sort_type: 'ByCreateTimeDesc', page_size: cursor ? 10 : before + 1,
    ...cursor ? { page_token: cursor } : {} })
  const later = cursor || !after ? []
    : (await list({ start_time: String(Math.floor(time / 1000)), sort_type: 'ByCreateTimeAsc', page_size: after + 1 })).items
  const seen = new Set<string>()
  const messages = [...earlier.items.reverse(), ...later].filter(item => !seen.has(item.message_id) && seen.add(item.message_id))
    .map(historyView)
  const more = earlier.has_more && earlier.page_token && earlier.page_token !== cursor
  const next = more ? `feishu/${ref.triggerId}/around/${encodeURIComponent(earlier.page_token!)}` : null
  return { status: 'available', messages, next_resource: next }
}
export async function feishuRead(commands: Commands, ref: FeishuRef, resource: string,
  pageSize: number): Promise<FeishuPage<ContextMessage> | FeishuOne<ContextMessage>> {
  const request = feishuResource(resource)
  if (request.section === 'around') {
    if (request.triggerId !== ref.triggerId) throw new Error('A Feishu source trigger is required')
    await sourceOf(commands, ref)
    return chatAround(commands, ref, request.cursor)
  }
  const result = await readFeishu(commands, ref, resource, pageSize)
  if ('messages' in result) return { ...result, messages: result.messages.map(feishuView) }
  return { status: result.status, message: result.message ? feishuView(result.message) : null }
}
function sourceRef(trigger: Trigger): FeishuRef {
  const ref = feishuRef(trigger)
  if (!ref) throw new Error('A Feishu source trigger is required')
  return ref
}
export const feishuThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: async (commands, trigger, part, cursor, config) => {
    const ref = sourceRef(trigger)
    const resource = `feishu/${trigger.id}/${part}${cursor ? '/' + encodeURIComponent(cursor) : ''}`
    const body = await feishuRead(commands, ref, resource, config.readPageSize)
    if (part === 'thread' && body.status === 'no_thread') {
      // 触发器消息不属于任何话题线程时，回退到之前的群消息。
      const around = await chatAround(commands, ref, undefined, 5, 0)
      return { messages: around.messages, body: { status: 'chat_neighbours', messages: around.messages }, status: 'chat_neighbours' }
    }
    const messages = 'messages' in body ? body.messages : body.message ? [body.message] : []
    const next = 'next_resource' in body && body.next_resource ? decodeURIComponent(body.next_resource.split('/').at(-1)!) : undefined
    return { messages, next, body: { ...body }, status: body.status }
  },
  images: admissionImageKeys,
  image: (agent, commands, trigger, message, key, stateDir, signal) =>
    readAdmissionImage(agent, commands, { ...sourceRef(trigger), messageId: message.id }, message.text, key, stateDir, signal),
}
