/** 管理 API 的传输层：同源校验、请求体读取、路由匹配、错误到状态码的映射，以及 `registerHttp` 挂载。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { SettingsConflict } from '../settings.ts'
import { PromptConflict } from '../prompts.ts'
import { SetupError } from '../../setup.ts'
import { UserError } from '../../core/index.ts'
import type { StartupStatus } from '../startup.ts'
import { routes, type HttpHost, type Input, type Routes } from './routes.ts'
import { RouteError } from './error.ts'
import type { Api } from '../api.ts'

async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  // 回环地址包含 IPv4、localhost 与 IPv6 回环；端口必须是管理接口实际监听的端口。
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** 将错误映射为 HTTP 状态码和结构化载荷，面板会按界面语言对其进行本地化。 */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [/InUse$/.test(error.code) ? 409 : error.missing ? 404 : 400,
    { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
/** 管理接口的实际监听地址；健康探针据此报告入口。 */
export interface Listen { host: string; port: number }
/**
 * 挂载管理 API。第一种形式供 `Runtime` 自挂载（测试与独立运行时）；第二种形式供插件入口
 * 在运行时创建之前先挂载，并在初始化失败时用启动状态回答健康探针与 503 诊断。
 */
export function registerHttp(ctx: Context, runtime: HttpHost): () => void
export function registerHttp(ctx: Context, resolve: () => HttpHost | undefined, status: () => StartupStatus): () => void
export function registerHttp(ctx: Context, source: HttpHost | (() => HttpHost | undefined), status?: () => StartupStatus): () => void {
  const resolve = typeof source === 'function' ? source : () => source
  const state = status ?? ((): StartupStatus => ({ phase: 'ready', detail: '', stateDir: resolve()?.machine.stateDir ?? '' }))
  // 端口在请求时读取：插件初始化阶段 Web 服务器可能尚未监听（0.2.2 起 `port` 在绑定前为 undefined）。
  const listen = (): Listen => ({ host: ctx.webServer.host, port: ctx.webServer.port ?? 0 })
  // 运行时只创建一次；缓存它的路由表，避免每个请求重建。
  let cached: { runtime: HttpHost; table: Routes } | undefined
  const tableFor = (runtime: HttpHost): Routes => {
    if (cached?.runtime !== runtime) cached = { runtime, table: routes(runtime, listen, state) }
    return cached.table
  }
  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/orchestrator/api', handler: async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    // 前缀按路径边界匹配 `/orchestrator/api`，其余 `/orchestrator/*` 交给宿主的页面路由。
    const path = url.pathname.slice('/orchestrator/api'.length).replace(/^\//, '')
    const runtime = resolve()
    // 就绪后按路由表派发并回包；健康探针（无查询参数）与其余接口共用这一段。
    const dispatch = async (ready: HttpHost, query: Record<string, string>): Promise<void> => {
      try {
        await ready.ready
        const route = match(tableFor(ready), method, path.split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    }
    // 健康探针先于同源校验：监控工具的 GET health 不带同源头也应可用（它只暴露运行状态，不含任何管理能力）。
    if (method === 'GET' && path === 'health') {
      if (!runtime) {
        const { phase, detail, error, stateDir } = state()
        json(res, 200, { ok: false, stage: phase, phase, detail, error: error ?? null, configured: false, paused: false,
          problem: null, listen: listen(), machine: { stateDir }, sources: [] })
        return
      }
      await dispatch(runtime, {})
      return
    }
    if (!sameOrigin(req, ctx.webServer.port ?? 0)) { json(res, 403, { error: 'Same-origin management request required' }); return }
    if (!runtime) {
      const { phase, detail, error, stateDir } = state()
      // 其余接口以 503 说明启动阶段，而不是空体 404。
      json(res, 503, { error: detail || 'dsh-superagent is not ready', code: 'startupPending', phase, detail, stateDir })
      return
    }
    await dispatch(runtime, Object.fromEntries(url.searchParams))
  } })
  return () => { dispose() }
}
