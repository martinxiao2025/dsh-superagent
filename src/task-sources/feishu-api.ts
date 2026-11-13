/**
 * 飞书知识库读取接口：把 wiki 节点、docx 正文与多维表格记录收敛成一套最小调用。
 * 端点映射、字段解析与分页只写一遍；CLI 与 HTTP 的传输差异由 FeishuTransport 承担。
 */
import { larkTransport, httpTransport, type FeishuTransport, type LarkCall } from '../feishu-transport.ts'

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

const itemsOf = (data: Record<string, unknown>, key = 'items'): Record<string, unknown>[] =>
  Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : []

/** 五个读取方法的唯一实现；`transport.get` 返回已解包的 `data`。 */
export function feishuWikiApi(transport: FeishuTransport): FeishuWikiApi {
  const spacePath = (spaceId: string, suffix: string): string =>
    `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/${suffix}`
  return {
    async node(token) {
      const data = await transport.get('/wiki/v2/spaces/get_node', { token })
      const node = data.node
      if (!node || typeof node !== 'object') throw new Error(`飞书没有返回节点 ${token}`)
      return nodeOf(node as Record<string, unknown>)
    },
    async children(spaceId, parentToken) {
      return paged(async pageToken => {
        const data = await transport.get(spacePath(spaceId, 'nodes'), { parent_node_token: parentToken, page_size: PAGE, page_token: pageToken })
        return { items: itemsOf(data).map(nodeOf), hasMore: data.has_more === true,
          pageToken: String(data.page_token ?? data.next_page_token ?? '') }
      })
    },
    async document(documentId) {
      const data = await transport.get(`/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`)
      return String(data.content ?? '')
    },
    async tables(appToken) {
      return paged(async pageToken => {
        const data = await transport.get(`/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, { page_size: 100, page_token: pageToken })
        return { items: itemsOf(data).map(item => ({ tableId: String(item.table_id ?? ''), name: String(item.name ?? '') }))
          .filter(item => item.tableId), hasMore: data.has_more === true, pageToken: String(data.page_token ?? '') }
      })
    },
    async records(appToken, tableId) {
      return paged(async pageToken => {
        const data = await transport.get(`/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`,
          { page_size: 100, page_token: pageToken })
        return { items: itemsOf(data).map(item => ({ recordId: String(item.record_id ?? ''),
          fields: (item.fields ?? {}) as Record<string, unknown> })).filter(item => item.recordId),
        hasMore: data.has_more === true, pageToken: String(data.page_token ?? '') }
      })
    },
  }
}

/** CLI 身份入口（保持既有签名）：`lark api GET <path> --params <json>`，返回 `data`。 */
export function larkWikiApi(lark: LarkCall): FeishuWikiApi {
  return feishuWikiApi(larkTransport(lark))
}

/** 应用身份入口（保持既有签名）：tenant_access_token 缓存到过期前 60 秒。 */
export function httpWikiApi(appId: string, appSecret: string, signal?: AbortSignal): FeishuWikiApi {
  return feishuWikiApi(httpTransport(appId, appSecret, signal))
}
