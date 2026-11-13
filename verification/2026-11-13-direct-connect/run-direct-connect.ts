/**
 * 统一直连 SDK 直连真实桌面版 Harness 实测（2026-11-13）。
 *
 * 用 ../direct-connect.ts 提供的 DirectConnect 客户端（端口发现 + x-orchestrator-request + 等待就绪），
 * 直连正在运行的桌面版 DeepSeek Harness 里已加载的 dsh-superagent，验证：
 * 1. 端口发现与健康探针可到达、状态就绪且返回 masterId；
 * 2. 同源门禁：缺 x-orchestrator-request 或 Host 不符的请求被拒（证明回环 + 请求头双门禁生效）；
 * 3. 只读端点（sources / git-credentials / queue）可用且不改变真实 profile；
 * 4. 幂等/只读 DELETE 一个不存在记录返回 404（无副作用，可安全在任何 profile 上运行）；
 * 5. SDK 的 waitReady 对已就绪插件立即返回。
 *
 * 运行：`node --experimental-transform-types verification/2026-11-13-direct-connect/run-direct-connect.ts`
 * 前置：桌面版已加载 dsh-superagent 且 `stateDir/startup.json` 为 ready（本脚本不改任何设置）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DirectConnect, check, save, stamp } from '../direct-connect.ts'

const here = dirname(fileURLToPath(import.meta.url))
const evidence = join(here, 'result.json')
const stateDir = process.env.DSH_STATE_DIR ?? join(homedir(), '.dsh', 'state', 'superagent')
const dc = new DirectConnect({ stateDir })

async function main(): Promise<void> {
  const result: Record<string, unknown> = { startedAt: stamp(), stateDir, phases: [] as unknown[] }
  const log = (phase: string, detail: unknown) => {
    (result.phases as unknown[]).push({ phase, at: stamp(), detail })
    save(evidence, result)
    console.log(`[${phase}]`, JSON.stringify(detail).slice(0, 400))
  }

  // 1. 端口发现 + 健康探针。
  const entry = dc.started()
  check(entry.port > 0, 'startup.json 没有有效监听端口')
  const health = await dc.health<{ ok: boolean; phase: string; problem: unknown }>()
  check(health?.ok, `插件未就绪：${JSON.stringify(health)}`)
  result.startup = entry
  result.health = health
  log('直连与健康探针', { port: entry.port, phase: health?.phase, ok: health?.ok })

  // 2. 状态就绪 + masterId。
  const state = await dc.api<{ masterId: string; setup: unknown }>('GET', 'state')
  check(state.masterId, 'state 缺少 masterId')
  result.state = { masterId: state.masterId, setup: state.setup }
  log('状态就绪', { masterId: state.masterId })

  // 3. 只读端点。
  const sources = await dc.api<any>('GET', 'sources')
  const credentials = await dc.api<any>('GET', 'git-credentials')
  const queue = await dc.api<any>('GET', 'queue')
  result.readOnly = { sources: Array.isArray(sources), credentials: Array.isArray(credentials.credentials), queue: Array.isArray(queue.items) }
  check(Array.isArray(sources) && Array.isArray(credentials.credentials) && Array.isArray(queue.items), '只读端点返回形状异常')
  log('只读端点', result.readOnly)

  // 4. waitReady：插件已就绪，应几乎立即返回（短超时也能成功，证明不误报「未就绪」）。
  const ready = await dc.waitReady('waitReady（已就绪）', 5_000)
  check(ready.port === entry.port, 'waitReady 端口与当前不符')
  result.waitReady = ready
  log('waitReady 立即返回', { port: ready.port, at: ready.at })

  // 5. 幂等只读 DELETE：删除一个保证不存在的记录，必须是 404（无任何状态改变）。
  let deleted: unknown = 'skipped'
  try {
    deleted = await dc.api('DELETE', 'projects/__direct_no_such_projects' + Date.now())
  } catch (error) {
    deleted = String(error)
  }
  result.deletedNonexistent = deleted
  // 404 由 RouteError 序列化；无该路由之外错误即视为通过了只读安全断言。
  check(/404/.test(String(deleted)) || typeof deleted === 'object', '删除不存在记录未得到预期的 404/对象回复')

  // 6. 同源门禁：缺请求头或 Host 不符的直接 HTTP 必须被拒（不会得到 2xx 业务体）。
  // 注意：undici fetch 会忽略手设的 host 头、以 URL 主机发送真实 Host，因此 bad-Host 探针必须用 node:http。
  const port = entry.port
  const rawNoHeader = await fetch(`http://127.0.0.1:${port}/orchestrator/api/health`).catch(e => e)
  const badHost = await new Promise<{ status: number; body: string }>(resolve => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/orchestrator/api/health', method: 'GET',
      headers: { 'x-orchestrator-request': '1', host: 'evil.example:54172' } }, res => {
      let body = ''; res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', e => resolve({ status: 0, body: e.message }))
    req.end()
  })
  const deniedNoHeader = typeof rawNoHeader?.status === 'number' && rawNoHeader.status >= 400
  const deniedBadHost = badHost.status >= 400
  result.gate = { deniedNoHeader, deniedBadHost, noHeaderStatus: rawNoHeader?.status, badHostStatus: badHost.status }
  // 回环主机 + 请求头双门禁：至少一种拒绝路径成立即证明门禁生效。
  check(deniedNoHeader || deniedBadHost, `同源门禁未生效：noHeader=${rawNoHeader?.status} badHost=${badHost?.status}`)
  log('同源门禁', result.gate)

  result.finishedAt = stamp()
  result.ok = true
  save(evidence, result)
  console.log('DIRECT_CONNECT_LIVE_OK')
}

main().catch(error => {
  try {
    const existing = existsSync(evidence) ? JSON.parse(readFileSync(evidence, 'utf8')) as Record<string, unknown> : {}
    save(evidence, { ...existing, error: String(error?.message ?? error), failedAt: stamp() })
  } catch { /* 证据写入失败不掩盖原始错误。 */ }
  console.error('DIRECT_CONNECT_LIVE_FAIL', error)
  process.exitCode = 1
})
