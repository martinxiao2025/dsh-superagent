/**
 * 飞书群消息读取接口：按群拉取最近消息并抽取纯文本，供飞书消息任务来源使用。
 * 端点映射、字段解析与分页只写一遍；CLI 与 HTTP 的传输差异由 FeishuTransport 承担。
 */
import { larkTransport, httpTransport, type FeishuTransport, type LarkCall } from '../feishu-transport.ts'

/** 一条群消息的最小视图：编号稳定，文本已抽取，发送者与时间用于展示与排障。 */
export interface ImMessage {
  messageId: string
  text: string
  senderId: string
  senderType: string
  createdAt: string
}

/** 读取群消息的能力；`limit` 为期望的最大条数，实现负责分页。 */
export interface FeishuImApi {
  messages(chatId: string, options: { limit: number; signal?: AbortSignal }): Promise<ImMessage[]>
  /** 机器人已加入的群列表；任务来源的群 ID 选择用它，最多返回 200 个。 */
  chats(): Promise<{ id: string; name: string }[]>
}

/** 凭据读取群消息的能力；未安装或材料不可用时返回 undefined，由驱动给出可读的预检结果。 */
export type FeishuImReader = (credential: string) => Promise<FeishuImApi | undefined>

const PAGE = 50
/** 分页上限：与知识库读取保持一致，避免异常分页拖住一轮轮询。 */
const MAX_PAGES = 200

/** 富文本消息的正文：兼容 `{ title, content }` 与按语言分组的 `{ zh_cn: { title, content } }`。 */
function postText(body: Record<string, unknown>): string {
  const localized = typeof body.zh_cn === 'object' && body.zh_cn !== null ? body.zh_cn as Record<string, unknown> : body
  const title = typeof localized.title === 'string' ? localized.title.trim() : ''
  const rows = Array.isArray(localized.content) ? localized.content : []
  const lines = rows.map(row => (Array.isArray(row) ? row : [])
    .map(part => typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').join('').trim())
  return [title, ...lines].filter(Boolean).join('\n').trim()
}

/** 把消息体 JSON 抽成纯文本：文本取 `text`，富文本按段落拼接，其他类型给出类型占位。 */
export function messageTextOf(type: string, content: string): string {
  let body: unknown
  try { body = JSON.parse(content) } catch { return content.trim() }
  if (typeof body !== 'object' || body === null) return content.trim()
  if (type === 'text') {
    const text = (body as { text?: unknown }).text
    return typeof text === 'string' ? text.trim() : ''
  }
  if (type === 'post') return postText(body as Record<string, unknown>)
  if (type === 'image') return '[图片]'
  if (type === 'file') return '[文件]'
  if (type === 'audio') return '[语音]'
  if (type === 'media') return '[视频]'
  return `[${type}]`
}

/** 逐页读取消息列表，直到取满上限或没有下一页；同一编号只保留首次出现。 */
async function pagedMessages(call: (pageToken: string) => Promise<{ items: ImMessage[]; hasMore: boolean; pageToken: string }>,
  limit: number): Promise<ImMessage[]> {
  const seen = new Set<string>()
  const out: ImMessage[] = []
  let token = ''
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await call(token)
    for (const item of result.items) {
      if (!item.messageId || seen.has(item.messageId)) continue
      seen.add(item.messageId)
      out.push(item)
      if (out.length >= limit) return out
    }
    if (!result.hasMore || !result.pageToken) return out
    token = result.pageToken
  }
  throw new Error('飞书消息分页超过 200 页，已停止读取')
}

/** 把一条原始消息规范化为最小视图；缺少编号的消息由调用方过滤。 */
function messageOf(value: Record<string, unknown>): ImMessage {
  const body = typeof value.body === 'object' && value.body !== null ? value.body as Record<string, unknown> : {}
  const sender = typeof value.sender === 'object' && value.sender !== null ? value.sender as Record<string, unknown> : {}
  const type = String(value.msg_type ?? '')
  return {
    messageId: String(value.message_id ?? ''),
    text: messageTextOf(type, String(body.content ?? '')),
    senderId: String(sender.id ?? ''),
    senderType: String(sender.sender_type ?? ''),
    createdAt: String(value.create_time ?? ''),
  }
}

const itemsOf = (data: Record<string, unknown>, key = 'items'): Record<string, unknown>[] =>
  Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : []

/** 群消息与群列表端点映射的唯一实现；`transport.get` 返回已解包的 `data`。 */
export function feishuImApi(transport: FeishuTransport): FeishuImApi {
  return {
    /** 按群读取最近消息；倒序读取，取够 `limit` 条即停止。 */
    async messages(chatId, { limit }) {
      return pagedMessages(async pageToken => {
        const data = await transport.get('/im/v1/messages', {
          container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeDesc',
          page_size: Math.min(limit, PAGE), ...pageToken ? { page_token: pageToken } : {} })
        return { items: itemsOf(data).map(messageOf), hasMore: data.has_more === true, pageToken: String(data.page_token ?? '') }
      }, limit)
    },
    /** 机器人已加入的群；分页读满 200 个为止。 */
    async chats() {
      const chats: { id: string; name: string }[] = []
      let pageToken = ''
      for (let page = 0; page < 4; page += 1) {
        const data = await transport.get('/im/v1/chats', { page_size: PAGE, ...pageToken ? { page_token: pageToken } : {} })
        chats.push(...itemsOf(data).map(item => ({ id: String(item.chat_id ?? ''), name: String(item.name ?? '') }))
          .filter(chat => chat.id))
        if (data.has_more !== true || !data.page_token) break
        pageToken = String(data.page_token)
      }
      return chats.slice(0, 200)
    },
  }
}

/** CLI 身份入口（保持既有签名）：`lark api GET <path> --params <json>`，返回 `data`。 */
export function larkImApi(lark: LarkCall): FeishuImApi {
  return feishuImApi(larkTransport(lark))
}

/** 应用身份入口（保持既有签名）：tenant_access_token 缓存到过期前 60 秒。 */
export function httpImApi(appId: string, appSecret: string, signal?: AbortSignal): FeishuImApi {
  return feishuImApi(httpTransport(appId, appSecret, signal))
}
