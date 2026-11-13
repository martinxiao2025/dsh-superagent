/**
 * 飞书 OpenAPI 传输层：Wiki/Im API 只面向 `FeishuTransport.get(path, params)` 编程，
 * 双实现（本机 CLI 身份 / 应用身份 HTTP）各自负责鉴权、信封解包与错误语义。
 * `FEISHU_BASE` 常量、tenant_access_token 的换取与内存缓存、以及业务码 → 语义族的
 * 分类表（`feishuFailureCode`）都在此单点维护。
 */

/** 飞书 OpenAPI 失败：保留状态码与业务码，供预检区分「无权」与「不存在」。 */
export class FeishuApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: number) { super(message) }
}

/** 一次飞书 OpenAPI 调用；由已解析记录的 CLI 或测试替身提供。 */
export type LarkCall = (args: string[]) => Promise<unknown>

/** 飞书 OpenAPI 的固定前缀；HTTP 直连与凭据探测共用。 */
export const FEISHU_BASE = 'https://open.feishu.cn/open-apis'

/** 传输面：`path` 以 `/` 开头且不含 `/open-apis` 前缀；返回已解包的 `data` 对象。 */
export interface FeishuTransport {
  get(path: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
}

/** 应用身份的 tenant_access_token：内存缓存到过期前 60 秒，不落盘、不进配置。 */
export class TokenManager {
  private cached: { token: string; expiresAt: number } | undefined
  constructor(private readonly appId: string, private readonly appSecret: string, private readonly signal?: AbortSignal) {}

  /** 返回缓存的 token；过期后重新换取。业务码并进消息，供按文本分类的预检保持对错误码的可见性。 */
  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.token
    const response = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST', signal: this.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    const payload = await response.json() as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw new FeishuApiError(`${payload.msg ?? `tenant token 换取失败（HTTP ${response.status}）`}${payload.code ? ` (${payload.code})` : ''}`,
        response.status, payload.code)
    }
    this.cached = { token: payload.tenant_access_token, expiresAt: Date.now() + Math.max(60, (payload.expire ?? 7200) - 60) * 1000 }
    return this.cached.token
  }
}

/** CLI 身份：`lark api GET /open-apis<path> --params <json>`；`ok/data` 解包由调用方提供的 `LarkCall` 负责。 */
const CLI_ERROR_CODE = /\s\((\d+)\)$/
export function larkTransport(lark: LarkCall): FeishuTransport {
  return {
    async get(path, params = {}) {
      let data: unknown
      try {
        data = await lark(['api', 'GET', `/open-apis${path}`, '--params', JSON.stringify(params)])
      } catch (error) {
        // CLI 的失败由调用方渲染为 `message (code)`；解析尾部业务码，让 CLI 错误与 HTTP 错误一样携带结构化 code。
        const text = error instanceof Error ? error.message : String(error)
        const code = CLI_ERROR_CODE.exec(text)?.[1]
        throw code ? new FeishuApiError(text, undefined, Number(code)) : error
      }
      return (data ?? {}) as Record<string, unknown>
    },
  }
}

/** 应用身份：先经 TokenManager 换取 tenant token，再携带 Bearer 读取；错误信封转为带状态码与业务码的 FeishuApiError。 */
export function httpTransport(appId: string, appSecret: string, signal?: AbortSignal): FeishuTransport {
  const tenant = new TokenManager(appId, appSecret, signal)
  return {
    async get(path, params = {}) {
      const url = new URL(`${FEISHU_BASE}${path}`)
      for (const [key, value] of Object.entries(params)) if (value !== '') url.searchParams.set(key, String(value))
      const response = await fetch(url, { signal, headers: { authorization: `Bearer ${await tenant.token()}` } })
      const payload = await response.json() as { code?: number; msg?: string; message?: string; data?: unknown }
      if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
        throw new FeishuApiError(`${payload.msg ?? payload.message ?? `飞书返回 HTTP ${response.status}`}${payload.code ? ` (${payload.code})` : ''}`,
          response.status, payload.code)
      }
      return (payload.data ?? {}) as Record<string, unknown>
    },
  }
}

/** 飞书失败的语义族；文本模式是历史 CLI 输出与网络层错误文案的最后兜底。 */
export type FeishuFailure = 'forbidden' | 'rateLimited' | 'unreachable' | 'missing'
/** 语义族的判定顺序；调用方按需传入子集，顺序不变。 */
const FAILURE_ORDER = ['forbidden', 'rateLimited', 'unreachable', 'missing'] as const
/** HTTP 状态码 → 语义族：code/status 优先，文本兜底只在其后。 */
const FAILURE_STATUS: Readonly<Record<FeishuFailure, readonly number[]>> = {
  forbidden: [401, 403], rateLimited: [], unreachable: [], missing: [404],
}
/** 飞书业务码 → 语义族的单点分类表（知识库、群消息与凭据探测共享）。 */
const FAILURE_CODES: Readonly<Record<number, FeishuFailure>> = {
  99991663: 'forbidden', 99991672: 'forbidden', 131006: 'forbidden', 230003: 'forbidden',
  131002: 'missing', 131003: 'missing', 230001: 'missing', 230002: 'missing',
  99991400: 'rateLimited',
}
/** 每个语义族的文本兜底模式；数字码同时保留在文本里，覆盖不携带结构化 code 的纯文本错误。 */
const FAILURE_TEXT: Readonly<Record<FeishuFailure, RegExp>> = {
  forbidden: /99991663|99991672|permission|forbidden|无权限|unauthorized|\b40[13]\b/i,
  rateLimited: /99991400|rate limit/i,
  unreachable: /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|timed out|network|EAI_AGAIN/i,
  missing: /131002|not found|not in chat|does not exist|\b404\b/i,
}

/** 按语义族把飞书错误映射为面板可本地化的代码：族内 status → 业务码 → 文本依次判定，族按声明顺序先命中先归因。 */
export function feishuFailureCode(error: unknown, codes: { fallback: string } & Partial<Record<FeishuFailure, string>>): string {
  const status = error instanceof FeishuApiError ? error.status : undefined
  const code = error instanceof FeishuApiError ? error.code : undefined
  const text = error instanceof Error ? error.message : String(error)
  for (const failure of FAILURE_ORDER) {
    const name = codes[failure]
    if (!name) continue
    if (status !== undefined && FAILURE_STATUS[failure].includes(status)) return name
    if (code !== undefined && FAILURE_CODES[code] === failure) return name
    if (FAILURE_TEXT[failure].test(text)) return name
  }
  return codes.fallback
}
