/**
 * 飞书知识库读取接口：把 wiki 节点、docx 正文与多维表格记录收敛成一套最小调用，
 * 应用身份走 HTTP，本机 CLI 身份走 `lark api`；两种实现共用同一遍历逻辑。
 */
import type { LarkCall } from './feishu-doc.ts'

/** 知识库节点：`nodeToken` 是稳定身份，真正的数据对象在 `objToken`。 */
export interface WikiNodeRef {
  nodeToken: string
  objToken: string
  objType: string
  title: string
  hasChild: boolean
  /** 节点所属知识空间；用于校验根节点确实归属绑定的 spaceId。 */
  spaceId: string
}
export interface WikiTableRef { tableId: string; name: string }
export interface WikiRecord { recordId: string; fields: Record<string, unknown> }

/** 一次读取所需的全部飞书调用；实现方负责鉴权与分页。 */
export interface FeishuWikiApi {
  node(token: string): Promise<WikiNodeRef>
  children(spaceId: string, parentToken: string): Promise<WikiNodeRef[]>
  /** docx 纯文本；表格以 Markdown 形式出现。 */
  document(documentId: string): Promise<string>
  tables(appToken: string): Promise<WikiTableRef[]>
  records(appToken: string, tableId: string): Promise<WikiRecord[]>
}

/** 凭据读取知识库的能力；未安装或材料不可用时返回 undefined，由驱动给出可读的预检结果。 */
export type FeishuWikiReader = (credential: string) => Promise<FeishuWikiApi | undefined>

/** 飞书 OpenAPI 失败：保留状态码与业务码，供预检区分「无权」与「不存在」。 */
export class FeishuApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: number) { super(message) }
}

const PAGE = 50

/** 逐页读取列表接口，直到 `has_more` 为 false。 */
async function paged<T>(call: (pageToken: string) => Promise<{ items: T[]; hasMore: boolean; pageToken: string }>): Promise<T[]> {
  const out: T[] = []
  let token = ''
  for (let page = 0; page < 200; page += 1) {
    const result = await call(token)
    out.push(...result.items)
    if (!result.hasMore || !result.pageToken) return out
    token = result.pageToken
  }
  throw new Error('飞书列表分页超过 200 页，已停止读取')
}

const nodeOf = (value: Record<string, unknown>): WikiNodeRef => ({
  nodeToken: String(value.node_token ?? value.nodeToken ?? ''),
  objToken: String(value.obj_token ?? value.objToken ?? ''),
  objType: String(value.obj_type ?? value.objType ?? ''),
  title: String(value.title ?? ''),
  hasChild: value.has_child === true || value.hasChild === true,
  spaceId: String(value.space_id ?? value.spaceId ?? ''),
})

interface Envelope { code?: number; msg?: string; message?: string; data?: unknown }

/** CLI 身份：`lark api GET <path> --params <json>`，返回 `data`。 */
export function larkWikiApi(lark: LarkCall): FeishuWikiApi {
  const get = async (path: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const data = await lark(['api', 'GET', path, '--params', JSON.stringify(params)])
    return (data ?? {}) as Record<string, unknown>
  }
  const spacePath = (spaceId: string, suffix: string): string =>
    `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/${suffix}`
  const items = (data: Record<string, unknown>, key: string): Record<string, unknown>[] =>
    Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : []
  return {
    async node(token) {
      const data = await get('/open-apis/wiki/v2/spaces/get_node', { token })
      const node = data.node
      if (!node || typeof node !== 'object') throw new Error(`飞书没有返回节点 ${token}`)
      return nodeOf(node as Record<string, unknown>)
    },
    async children(spaceId, parentToken) {
      return paged(async pageToken => {
        const data = await get(spacePath(spaceId, 'nodes'), { parent_node_token: parentToken, page_size: PAGE, page_token: pageToken })
        return { items: items(data, 'items').map(nodeOf), hasMore: data.has_more === true,
          pageToken: String(data.page_token ?? data.next_page_token ?? '') }
      })
    },
    async document(documentId) {
      const data = await get(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`)
      return String(data.content ?? '')
    },
    async tables(appToken) {
      return paged(async pageToken => {
        const data = await get(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, { page_size: 100, page_token: pageToken })
        return { items: items(data, 'items').map(item => ({ tableId: String(item.table_id ?? ''), name: String(item.name ?? '') }))
          .filter(item => item.tableId), hasMore: data.has_more === true, pageToken: String(data.page_token ?? '') }
      })
    },
    async records(appToken, tableId) {
      return paged(async pageToken => {
        const data = await get(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
          { page_size: 100, page_token: pageToken })
        return { items: items(data, 'items').map(item => ({ recordId: String(item.record_id ?? ''),
          fields: (item.fields ?? {}) as Record<string, unknown> })).filter(item => item.recordId),
        hasMore: data.has_more === true, pageToken: String(data.page_token ?? '') }
      })
    },
  }
}

const BASE = 'https://open.feishu.cn/open-apis'

/** 应用身份：先换 tenant_access_token，再按同样的接口读取；token 缓存到过期前 60 秒。 */
export function httpWikiApi(appId: string, appSecret: string, signal?: AbortSignal): FeishuWikiApi {
  let cached: { token: string; expiresAt: number } | undefined
  const tenant = async (): Promise<string> => {
    if (cached && cached.expiresAt > Date.now()) return cached.token
    const response = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const payload = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new FeishuApiError(payload.msg ?? `tenant token 换取失败（HTTP ${response.status}）`, response.status, payload.code)
    }
    cached = { token: payload.tenant_access_token, expiresAt: Date.now() + Math.max(60, (payload.expire ?? 7200) - 60) * 1000 }
    return cached.token
  }
  const get = async (path: string, query: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const url = new URL(`${BASE}${path}`)
    for (const [key, value] of Object.entries(query)) if (value !== '') url.searchParams.set(key, String(value))
    const response = await fetch(url, { signal, headers: { authorization: `Bearer ${await tenant()}` } })
    const payload = await response.json() as Envelope
    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
      throw new FeishuApiError(`${payload.msg ?? payload.message ?? `飞书返回 HTTP ${response.status}`}${payload.code ? ` (${payload.code})` : ''}`,
        response.status, payload.code)
    }
    return (payload.data ?? {}) as Record<string, unknown>
  }
  const items = (data: Record<string, unknown>, key = 'items'): Record<string, unknown>[] =>
    Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : []
  const spacePath = (spaceId: string, suffix: string): string =>
    `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/${suffix}`
  return {
    async node(token) {
      const data = await get('/wiki/v2/spaces/get_node', { token })
      const node = data.node
      if (!node || typeof node !== 'object') throw new Error(`飞书没有返回节点 ${token}`)
      return nodeOf(node as Record<string, unknown>)
    },
    async children(spaceId, parentToken) {
      return paged(async pageToken => {
        const data = await get(spacePath(spaceId, 'nodes'), { parent_node_token: parentToken, page_size: PAGE, page_token: pageToken })
        return { items: items(data).map(nodeOf), hasMore: data.has_more === true, pageToken: String(data.page_token ?? '') }
      })
    },
    async document(documentId) {
      const data = await get(`/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`)
      return String(data.content ?? '')
    },
    async tables(appToken) {
      return paged(async pageToken => {
        const data = await get(`/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, { page_size: 100, page_token: pageToken })
        return { items: items(data).map(item => ({ tableId: String(item.table_id ?? ''), name: String(item.name ?? '') }))
          .filter(item => item.tableId), hasMore: data.has_more === true, pageToken: String(data.page_token ?? '') }
      })
    },
    async records(appToken, tableId) {
      return paged(async pageToken => {
        const data = await get(`/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
          { page_size: 100, page_token: pageToken })
        return { items: items(data).map(item => ({ recordId: String(item.record_id ?? ''),
          fields: (item.fields ?? {}) as Record<string, unknown> })).filter(item => item.recordId),
        hasMore: data.has_more === true, pageToken: String(data.page_token ?? '') }
      })
    },
  }
}
