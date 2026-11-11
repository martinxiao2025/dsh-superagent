/** 飞书凭据的默认探测：应用模式取 tenant token 并读知识库节点，CLI 模式检查可执行文件。 */
import type { Commands } from '../infra/commands.ts'
import type { FeishuProbe } from './service.ts'

const BASE = 'https://open.feishu.cn/open-apis'

/** 用应用身份换取 tenant access token；非零 code 带上飞书错误码。 */
async function tenantToken(appId: string, appSecret: string): Promise<string> {
  const response = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, { method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }) })
  const body = await response.json() as { code?: number; msg?: string; tenant_access_token?: string }
  if (!response.ok || (body.code ?? 0) !== 0 || !body.tenant_access_token) {
    throw new Error(`Feishu API ${body.code ?? response.status}: ${body.msg ?? response.statusText}`)
  }
  return body.tenant_access_token
}

export function feishuProbe(commands: Pick<Commands, 'run'>): FeishuProbe {
  return async ({ mode, appId, appSecret, cli, spaceId }) => {
    if (mode === 'cli') {
      // CLI 模式的登录态由 lark CLI 自己维护；这里只确认可执行文件可用。
      await commands.run(cli || 'lark', ['--version'])
      return { nodes: 0 }
    }
    const token = await tenantToken(appId ?? '', appSecret ?? '')
    if (!spaceId) return { nodes: 0 }
    const response = await fetch(`${BASE}/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?page_size=1`,
      { headers: { authorization: `Bearer ${token}` } })
    const body = await response.json() as { code?: number; msg?: string; data?: { items?: unknown[] } }
    if (!response.ok || (body.code ?? 0) !== 0) throw new Error(`Feishu API ${body.code ?? response.status}: ${body.msg ?? response.statusText}`)
    return { nodes: body.data?.items?.length ?? 0 }
  }
}
