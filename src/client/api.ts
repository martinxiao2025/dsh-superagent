/** 同源客户端，以及编排器管理 API 的轮询 Hook。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Api, ApiRequest, ApiResponse } from '../app/api.ts'
import { USER_ERRORS, type UserErrorCode } from '../core/errors.ts'
import type { TicketStage } from '../core/stage.ts'
import type { SetupProblem } from '../setup.ts'

/** 由结构化用户错误码与插值值标识的主机拒绝。 */
export interface UserFailure { code: UserErrorCode; values: Record<string, string> }
/**
 * 表示一次带本地化消息与结构化诊断信息的管理 API 请求失败。
 * 由 API 调用方抛出，供 UI 视图与草稿状态检查，用于区分校验问题、记录不存在，
 * 以及主机不可达（当 `dsh-superagent` 完全未响应时，例如重启期间，会设置 `details.unreachable`，
 * 此时 404 并不表示记录缺失）。
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number,
    readonly details: { issues?: { path: string; message: string }[]; setup?: SetupProblem; user?: UserFailure; unreachable?: boolean
      /** 插件尚未就绪时的启动阶段与诊断位置（来自 503 `startupPending`）。 */
      phase?: string; detail?: string; stateDir?: string } = {}) {
    super(message)
  }
  get issues() { return this.details.issues ?? [] }
  /** 当主机确认记录不存在（而非不可达）时为 true。 */
  get missing() { return this.status === 404 && !this.details.unreachable }
}
export interface ApiMessages {
  offline: string; notRunning: string; serverError: (status: number) => string; requestFailed: (status: number) => string
  setup: (problem: SetupProblem) => string
  user: (failure: UserFailure) => string
  /** 管理路由已挂载但运行时未就绪时的本地化诊断（阶段、原因、状态目录）。 */
  startup?: (phase: string, detail: string, stateDir: string) => string
}
const isUserError = (code: unknown): code is UserErrorCode => typeof code === 'string' && Object.hasOwn(USER_ERRORS, code)

/** 调用一个管理端点；`x-orchestrator-request` 请求头标记该请求来自本页面。 */
async function api<T>(messages: ApiMessages, path: string, method: string, body?: unknown): Promise<T> {
  let response: Response
  const json = body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  try {
    response = await fetch(`/orchestrator/api/${path}`, { method, ...json, headers: { 'x-orchestrator-request': '1', ...json.headers } })
  } catch {
    throw new ApiError(messages.offline, 0, { unreachable: true })
  }
  const text = await response.text()
  let value: unknown
  try { value = text ? JSON.parse(text) : {} } catch { value = undefined }
  if (!response.ok) {
    const failure = (value ?? {}) as { error?: unknown; issues?: unknown; setup?: SetupProblem; code?: unknown
      values?: Record<string, string>; phase?: unknown; detail?: unknown; stateDir?: unknown }
    const issues = Array.isArray(failure.issues) ? failure.issues as { path: string; message: string }[] : []
    const user = isUserError(failure.code) ? { code: failure.code, values: failure.values ?? {} } : undefined
    const phase = typeof failure.phase === 'string' ? failure.phase : undefined
    const detail = typeof failure.detail === 'string' ? failure.detail : ''
    const stateDir = typeof failure.stateDir === 'string' ? failure.stateDir : ''
    // 插件入口在运行时未就绪时返回 503 `startupPending`：优先用本地化诊断，而不是英文原始消息。
    const startup = failure.code === 'startupPending' && messages.startup ? messages.startup(phase ?? '', detail, stateDir) : undefined
    // dsh-superagent 总会返回响应体；启动或重启期间 dsh-superagent 路由被卸载时，空的 404 来自 DSH Web 服务器。
    const { status } = response
    const message = failure.setup ? messages.setup(failure.setup) : user ? messages.user(user) : startup
      ?? (typeof failure.error === 'string' ? failure.error : !text && status === 404 ? messages.notRunning
        : status >= 500 ? messages.serverError(status) : messages.requestFailed(status))
    throw new ApiError(message, status, { issues, ...failure.setup ? { setup: failure.setup } : {}, ...user ? { user } : {},
      ...phase === undefined ? {} : { phase }, ...detail ? { detail } : {}, ...stateDir ? { stateDir } : {},
      ...text ? {} : { unreachable: true } })
  }
  return value as T
}

const HIDDEN_FACTOR = 6
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)
/**
 * 在挂载期间轮询某个端点，文档隐藏时降低轮询频率。
 * 在依赖变化与错误期间保留最后一次成功的值，响应未变化时跳过状态更新，
 * 并在 `deps` 或 `intervalMs` 变化触发新订阅时丢弃过期响应。
 */
export function usePoll<T>(load: () => Promise<T>, deps: readonly unknown[], intervalMs = 5000) {
  const [state, setState] = useState<{ data?: T; error?: Error }>({})
  const loader = useRef(load)
  loader.current = load
  const refresh = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // 串行化请求，确保变更后的手动重新加载在当前轮询结束后执行。
    let queue = Promise.resolve()
    const once = async () => {
      clearTimeout(timer)
      try {
        const value = await loader.current()
        if (active) setState(previous => same(previous.data, value) ? previous.error ? { data: previous.data as T } : previous : { data: value })
      } catch (failure) {
        if (active) setState(previous => ({ ...previous, error: failure instanceof Error ? failure : new Error(String(failure)) }))
      } finally {
        if (active) timer = setTimeout(run, document.hidden ? intervalMs * HIDDEN_FACTOR : intervalMs)
      }
    }
    const run = () => (queue = queue.then(once))
    const shown = () => { if (!document.hidden) void run() }
    refresh.current = run
    void run()
    document.addEventListener('visibilitychange', shown)
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs])
  const reload = useCallback(() => refresh.current(), [])
  return { data: state.data, error: state.error, reload }
}

export const DECISION_FILTERS = ['work', 'stop', 'ignore', 'unavailable', 'all'] as const
export type DecisionFilter = typeof DECISION_FILTERS[number]
export const DECISION_KINDS: Readonly<Record<DecisionFilter, string>> = { work: 'accept,reopen', stop: 'stop', ignore: 'ignore',
  unavailable: 'unavailable', all: '' }

export type Call = <K extends keyof Api>(route: K, ...request: {} extends ApiRequest<K> ? [request?: ApiRequest<K>] : [request: ApiRequest<K>])
  => Promise<ApiResponse<K>>
/** 构建类型化路由调用器，在每次请求时解析本地化错误消息。 */
export function caller(messages: () => ApiMessages): Call {
  return (route, ...[request]) => {
    const [method, pattern] = route.split(' ') as [string, string]
    const values = (request ?? {}) as Record<string, unknown> & { query?: Record<string, unknown>; body?: unknown }
    const path = pattern.replace(/:(\w+)/g, (_match, name: string) => encodeURIComponent(String(values[name])))
    const query = Object.entries(values.query ?? {}).filter(([, value]) => value !== undefined && value !== '')
      .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&')
    return api(messages(), query ? `${path}?${query}` : path, method, values.body)
  }
}

export type StateView = ApiResponse<'GET state'>
export type SetupView = StateView['setup']
export type SettingsView = ApiResponse<'GET settings'>
export type Settings = { [B in keyof SettingsView['blocks']]: SettingsView['blocks'][B]['value'] }
export type SourceView = SettingsView['sources'][number]
export type SourceStatusRow = ApiResponse<'GET sources'>[number]
export type TicketRow = ApiResponse<'GET tickets'>['items'][number]
export type TicketPageView = ApiResponse<'GET tickets/:id'>
export type ThreadRow = ApiResponse<'GET threads'>['items'][number]
export type ThreadPageView = ApiResponse<'GET threads/:key'>
export type TriggerRow = ThreadPageView['timeline'][number]
export type DecisionRow = ApiResponse<'GET decisions'>['items'][number]
export type Problem = ApiResponse<'GET overview'>['problems'][number]
export type DroppedReply = SourceStatusRow['dropped'][number]
export type SearchView = ApiResponse<'GET search'>
export type TicketSummary = SearchView['tickets'][number]
export type { TicketStage }
export type HistoryView = ApiResponse<'GET policy/history'>
export type PromptsView = ApiResponse<'GET prompts'>
export type PromptConfig = PromptsView['defaults']
export type ThreadFacts = TicketRow['threads'][number]
export type Actor = TriggerRow['actor']
