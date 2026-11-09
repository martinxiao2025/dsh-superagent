/** 把飞书实时事件、聊天历史条目和话题回复归一化为领域触发器。 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import type { FeishuMessage, FeishuRef } from './feishu-read.ts'

export const SOURCE = 'feishu'
/** 构建飞书回复频道地址；因为群聊和单聊的 ID 都以 `oc_` 开头，所以显式记录 `direct`。 */
export const feishuChannel = (chatId: string, messageId: string, direct = false): ChannelRef =>
  ({ source: SOURCE, thread: `feishu:${chatId}`, address: { chatId, messageId, ...direct ? { direct: 'true' } : {} } })
/** 实时事件消费者输出的消息结构；历史记录和话题分页路径也会把读取内容归一化为该结构。 */
const EventSchema = z.object({ message_id: z.string(), chat_id: z.string(), chat_type: z.enum(['p2p', 'group']),
  sender_id: z.string(), sender_type: z.enum(['user', 'bot']), content: z.string(), create_time: z.string(),
  mentions: z.array(z.object({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).default([]),
  root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(), message_app_link: z.url().optional() })
export type FeishuEvent = z.infer<typeof EventSchema>
export const feishuThreadId = (chatId: string, rootId: string | undefined, messageId: string): string => `${chatId}:${rootId ?? messageId}`
/** 飞书消息的确定性触发器 ID；该消息的每条读取路径都会产生相同的 ID。 */
export const feishuTriggerId = (messageId: string): string => key('feishu', messageId)
export const withMentionNames = (text: string, mentions: { key?: string | undefined; name?: string | undefined }[]): string =>
  mentions.reduce((result, mention) => mention.key && mention.name ? result.replaceAll(mention.key, `@${mention.name}`) : result, text)
/**
 * 把飞书消息时间戳解析为 ISO-8601 字符串：实时事件和历史 API 以字符串形式返回 epoch 毫秒，
 * 而话题/线程分页返回本地时间戳字符串，例如 `2026-09-11 12:00`。
 */
export function feishuTime(value: string): string {
  const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`Unreadable Feishu message time: ${value}`)
  return new Date(time).toISOString()
}
/** 把归一化的飞书事件转为触发器；机器人自己发送的消息返回 undefined。 */
export function feishuTrigger(input: unknown, botId: string, botAppId: string): Trigger | undefined {
  const event = EventSchema.parse(input)
  if (event.sender_id === botId || event.sender_id === botAppId) return
  const direct = event.chat_type === 'p2p'
  const mentioned = event.mentions.some(mention => mention.id === botId || mention.id === botAppId)
  const thread = feishuThreadId(event.chat_id, event.root_id, event.message_id)
  return { id: feishuTriggerId(event.message_id), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: event.sender_id }, human: event.sender_type === 'user',
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: feishuTime(event.create_time), text: withMentionNames(event.content, event.mentions),
    channel: feishuChannel(event.chat_id, event.message_id, direct), ...(event.message_app_link ? { url: event.message_app_link } : {}),
    meta: { chatId: event.chat_id, messageId: event.message_id, direct, mentioned, ...(event.root_id ? { rootId: event.root_id } : {}),
      ...(event.parent_id ? { parentId: event.parent_id } : {}), ...(event.thread_id ? { threadId: event.thread_id } : {}) } }
}
export const feishuParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined
export function feishuRef(trigger: Trigger): FeishuRef | undefined {
  const meta = trigger.meta as { chatId?: string; messageId?: string }
  if (trigger.source !== SOURCE || !meta.chatId || !meta.messageId) return undefined
  return { triggerId: trigger.id, chatId: meta.chatId, messageId: meta.messageId, at: trigger.at }
}

/** 历史 API 的消息；已删除的消息可能没有正文/内容。 */
export const HistoricalMessageSchema = z.looseObject({
  message_id: z.string(), chat_id: z.string(), create_time: z.string(),
  root_id: z.string().optional(), parent_id: z.string().optional(), thread_id: z.string().optional(),
  deleted: z.boolean().optional(), message_app_link: z.string().optional(),
  sender: z.looseObject({ id: z.string().default(''), sender_type: z.string() }),
  body: z.looseObject({ content: z.string() }).optional(),
  mentions: z.array(z.looseObject({ id: z.string(), key: z.string().optional(), name: z.string().optional() })).optional(),
})
export type HistoricalMessage = z.infer<typeof HistoricalMessageSchema>
/** 历史 API 的一页；条目逐条校验，因此不可读的条目只会被单独跳过。 */
export const HistoryPageSchema = z.looseObject({
  items: z.array(z.unknown()).default([]), has_more: z.boolean().default(false), page_token: z.string().optional(),
})
export function historyText(message: HistoricalMessage): string {
  let content: unknown
  try { content = JSON.parse(message.body?.content ?? '') }
  catch { content = message.body?.content ?? '' /* 飞书也会返回纯文本的系统消息。 */ }
  const plain = content && typeof content === 'object' && 'text' in content && typeof content.text === 'string' ? content.text : undefined
  return typeof content === 'string' ? content : plain ?? JSON.stringify(content)
}
export function historyEvent(message: HistoricalMessage, chatId: string, direct: boolean): unknown {
  return { message_id: message.message_id, chat_id: chatId, chat_type: direct ? 'p2p' : 'group', create_time: message.create_time,
    sender_id: message.sender.id, sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot', content: historyText(message),
    mentions: message.mentions ?? [], root_id: message.root_id, parent_id: message.parent_id, thread_id: message.thread_id,
    message_app_link: message.message_app_link }
}
/**
 * 把话题分页消息适配为实时事件 schema；飞书在回复上省略 `root_id` 时回退到 `root`。
 * 应用消息携带其机器人的 `open_bot_id`，已删除的消息可能没有内容。
 */
export function topicEvent(message: FeishuMessage, chatId: string, direct: boolean, root: string): unknown {
  return { message_id: message.message_id, chat_id: chatId, chat_type: direct ? 'p2p' : 'group', create_time: message.create_time,
    sender_id: message.sender.open_bot_id ?? message.sender.id, sender_type: message.sender.sender_type === 'user' ? 'user' : 'bot',
    content: message.content ?? '', mentions: message.mentions ?? [], parent_id: message.parent_id, thread_id: message.thread_id,
    root_id: message.root_id ?? (message.message_id === root ? undefined : root), message_app_link: message.message_app_link }
}
