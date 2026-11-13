import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectConnect, check, save } from '../verification/direct-connect.ts'

/** 伪造一个返回指定状态的 fetch，并记录发出的请求。 */
function fakeFetch(plan: { status: number; body?: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = []
  const impl = async (url: string, init?: any) => {
    const next = plan.shift() ?? { status: 500, body: { error: 'out of plan' } }
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body })
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => JSON.stringify(next.body),
    } as any
  }
  return { impl, calls } as { impl: typeof fetch; calls: typeof calls }
}

describe('统一直连 SDK DirectConnect', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'direct-connect-'))
    file = join(dir, 'startup.json')
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('started() 解析 startup.json 并返回监听端口', () => {
    writeFileSync(file, JSON.stringify({ phase: 'ready', listen: { port: 9901 }, pid: 31, at: '2026-01-01T00:00:00Z' }))
    const dc = new DirectConnect({ startupFile: file })
    const entry = dc.started()
    expect(entry.port).toBe(9901)
    expect(entry.phase).toBe('ready')
    expect(entry.pid).toBe(31)
  })

  it('started() 在缺少监听端口时抛错', () => {
    writeFileSync(file, JSON.stringify({ phase: 'starting' }))
    const dc = new DirectConnect({ startupFile: file })
    expect(() => dc.started()).toThrow(/没有监听端口/)
  })

  it('api() 携带 x-orchestrator-request 请求头并解析 JSON 响应', async () => {
    writeFileSync(file, JSON.stringify({ phase: 'ready', listen: { port: 9911 } }))
    const { impl, calls } = fakeFetch([{ status: 200, body: { ok: true } }])
    const dc = new DirectConnect({ startupFile: file, fetchImpl: impl })
    const out = await dc.api('GET', 'health')
    expect(out).toMatchObject({ ok: true })
    expect(calls[0]!.url).toBe('http://127.0.0.1:9911/orchestrator/api/health')
    expect(calls[0]!.headers['x-orchestrator-request']).toBe('1')
    expect(calls[0]!.method).toBe('GET')
  })

  it('api() 对 POST 请求附 JSON 体与 content-type', async () => {
    writeFileSync(file, JSON.stringify({ phase: 'ready', listen: { port: 9912 } }))
    const { impl, calls } = fakeFetch([{ status: 201, body: { id: 'x' } }])
    const dc = new DirectConnect({ startupFile: file, fetchImpl: impl })
    await dc.api('POST', 'projects', { id: 'p1' })
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ id: 'p1' })
    expect(calls[0]!.headers['content-type']).toContain('application/json')
  })

  it('api() 非 2xx 抛错并带上状态与响应文本', async () => {
    writeFileSync(file, JSON.stringify({ phase: 'ready', listen: { port: 9913 } }))
    const { impl } = fakeFetch([
      { status: 503, body: { error: 'not ready', code: 'startupPending' } },
      { status: 503, body: { error: 'not ready', code: 'startupPending' } },
    ])
    const dc = new DirectConnect({ startupFile: file, fetchImpl: impl })
    await expect(dc.api('GET', 'state')).rejects.toThrow(/503/)
    await expect(dc.api('GET', 'state')).rejects.toThrow(/startupPending/)
  })

  it('health() 连接失败返回 undefined', async () => {
    writeFileSync(file, JSON.stringify({ phase: 'ready', listen: { port: 9914 } }))
    const { impl } = fakeFetch([])
    const dc = new DirectConnect({ startupFile: file, fetchImpl: impl })
    // 第一次 api 会用掉一个 {status:500} 兜底；health() 应返回该 500 抛错后的 undefined。
    const h = await dc.health()
    expect(h).toBeUndefined()
  })

  it('waitReady() 轮询直到健康 ok，并在端口漂移时跟随新读取', async () => {
    // 第一次 started() 读旧端口 9915，健康返回 ok:false；更新 startup.json 到 9916 后 ok:true。
    writeFileSync(file, JSON.stringify({ phase: 'ready', listen: { port: 9915 } }))
    const calls: string[] = []
    const impl = async (url: string, init?: any) => {
      calls.push(url)
      const ok = url.includes('9916')
      return { ok, status: ok ? 200 : 503, text: async () => JSON.stringify({ ok }) } as any
    }
    const dc = new DirectConnect({ startupFile: file, fetchImpl: impl as typeof fetch, apiBase: p => `http://127.0.0.1:${p}` })
    const promise = dc.waitReady('等待就绪', 5000)
    writeFileSync(file, JSON.stringify({ phase: 'ready', listen: { port: 9916 } }))
    const entry = await promise
    expect(entry.port).toBe(9916)
  })

  it('check() 与 save() 辅助函数行为正确', () => {
    expect(() => check(true, 'x')).not.toThrow()
    expect(() => check(false, 'boom')).toThrow('boom')
    const target = join(dir, 'out.json')
    save(target, { a: 1 })
    expect(JSON.parse(require('node:fs').readFileSync(target, 'utf8'))).toEqual({ a: 1 })
  })
})
