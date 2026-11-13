/** 统一直连 SDK：直连桌面版 DeepSeek Harness 上已加载的本插件（管理 HTTP API）。 */
/**
 * 把此前散落在每个 verification 脚本里的「端口发现 + x-orchestrator-request 客户端 + 等待就绪 + 证据落盘」
 * 收敛成一个被复用的模块。直连前提（与 docs/006-deployment.md 一致）：
 * - 管理接口只监听回环地址，请求必须带 `x-orchestrator-request: 1`；
 * - 监听端口来自 `stateDir/startup.json` 的 `listen.port`，插件重挂载会换端口，因此每次请求前都重新读取。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
export const stamp = (): string => new Date().toISOString()
/** 断言；失败立即抛出。 */
export function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}
/** 把一次执行的材料落盘为 JSON（覆盖写上一条证据）。 */
export function save(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 启动记录里本模块关心的字段。 */
export interface StartupEntry {
  port: number
  phase: string
  detail: string
  pid: number
  at: string
}

export interface DirectConnectOptions {
  /** 插件状态目录；缺省用 DSH_STATE_DIR 或 ~/.dsh/state/superagent。 */
  stateDir?: string
  /** 覆盖 startup.json 的完整路径（测试用）。 */
  startupFile?: string
  /** 覆盖全局 fetch（测试注入桩）。 */
  fetchImpl?: typeof fetch
  /** 覆盖 API 基址（测试用）；缺省为 http://127.0.0.1:<port>。 */
  apiBase?: (port: number) => string
}

/**
 * 直连桌面版插件的管理接口。
 * 每次 `api()` 前若端口未知或启动记录变化则重新读取 startup.json，从而正确跟随
 * 插件重挂载导致的端口漂移；`waitReady()` 轮询健康探针直到 ok。
 */
export class DirectConnect {
  private readonly stateDir: string
  private readonly startupFile: string
  private readonly fetchImpl: typeof fetch
  private readonly apiBase: (port: number) => string
  private port = 0

  constructor(options: DirectConnectOptions = {}) {
    this.stateDir = options.stateDir ?? process.env.DSH_STATE_DIR ?? join(homedir(), '.dsh', 'state', 'superagent')
    this.startupFile = options.startupFile ?? join(this.stateDir, 'startup.json')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.apiBase = options.apiBase ?? (port => `http://127.0.0.1:${port}`)
  }

  /** 读取启动记录；缺少监听端口时抛错。 */
  started(): StartupEntry {
    const text = readFileSync(this.startupFile, 'utf8')
    const parsed = JSON.parse(text) as { listen?: { port?: number }; phase?: string; detail?: string; pid?: number; at?: string }
    check(parsed.listen?.port, `startup.json 没有监听端口：${text}`)
    this.port = parsed.listen!.port!
    return { port: this.port, phase: parsed.phase ?? '', detail: parsed.detail ?? '', pid: parsed.pid ?? 0, at: parsed.at ?? '' }
  }

  /** 调用管理端点；端口未知时先读 startup.json。非 2xx 立即抛错。速率不受本模块限制。 */
  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.port) this.started()
    const response = await this.fetchImpl(`${this.apiBase(this.port)}/orchestrator/api/${path}`, {
      method,
      headers: { 'x-orchestrator-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const value = text ? JSON.parse(text) as unknown : undefined
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`)
    return value as T
  }

  /** 健康探针：返回健康响应全文；连接失败返回 undefined，供轮询与失败兜底。 */
  async health<T = { ok: boolean; stage: string } & Record<string, unknown>>(): Promise<T | undefined> {
    try { return await this.api<T>('GET', 'health') } catch { return undefined }
  }

  /** 轮询健康探针直到 ready；重启换端口时从 startup.json 重新读取。 */
  async waitReady(label: string, timeoutMs = 90_000): Promise<StartupEntry> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      let entry: StartupEntry
      try { entry = this.started() } catch { await sleep(1_000); continue }
      if ((await this.health())?.ok) return entry
      await sleep(1_000)
    }
    throw new Error(`${label}：${timeoutMs / 1000}s 内管理接口未恢复 ready`)
  }
}
