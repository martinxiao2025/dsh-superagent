/** 飞书凭据的默认探测：应用模式取 tenant token 并读知识库节点，CLI 模式检查可执行文件。 */
import type { Commands } from '../infra/commands.ts'
import { FEISHU_BASE, TokenManager } from '../feishu-transport.ts'
import type { FeishuProbe } from './service.ts'

export function feishuProbe(commands: Pick<Commands, 'run'>): FeishuProbe {
  return async ({ mode, appId, appSecret, cli, spaceId }) => {
    if (mode === 'cli') {
      // CLI 模式的登录态由 lark CLI 自己维护；这里只确认可执行文件可用。
      await commands.run(cli || 'lark', ['--version'])
      return { nodes: 0 }
    }
    // tenant token 的换取与缓存与知识库/群消息读取共用同一个 TokenManager。
    const token = await new TokenManager(appId ?? '', appSecret ?? '').token()
    if (!spaceId) return { nodes: 0 }
    const response = await fetch(`${FEISHU_BASE}/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?page_size=1`,
      { headers: { authorization: `Bearer ${token}` } })
    const body = await response.json() as { code?: number; msg?: string; data?: { items?: unknown[] } }
    if (!response.ok || (body.code ?? 0) !== 0) throw new Error(`Feishu API ${body.code ?? response.status}: ${body.msg ?? response.statusText}`)
    return { nodes: body.data?.items?.length ?? 0 }
  }
}
