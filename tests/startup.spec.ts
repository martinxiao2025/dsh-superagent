import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STARTUP_FILE, STARTUP_PREV_FILE, acquireStateLock, recordStartup, startupError,
  type StartupPhase } from '../src/app/startup.ts'

const dirs: string[] = []
/** 每个用例独立的临时目录；锁文件位于目录同级，需要在清理时一并删除。 */
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'dsh-startup-')); dirs.push(dir); return dir }
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
    rmSync(`${dir}.lock`, { recursive: true, force: true })
  }
})
/** 一份完整启动记录，只让用例关心阶段与时间。 */
const entry = (stateDir: string, phase: StartupPhase, at: string) => ({ phase, detail: '', stateDir, at, pid: 1234,
  listen: { host: '127.0.0.1', port: 3082 } })

it('summarizes any thrown value and truncates a long stack', () => {
  expect(startupError('boom')).toEqual({ name: 'Error', message: 'boom' })
  const error = new Error('disk full')
  error.stack = 'x'.repeat(5000)
  const summary = startupError(error)
  expect(summary).toMatchObject({ name: 'Error', message: 'disk full' })
  expect(summary.stack).toHaveLength(4000)
  // 没有栈时省略该字段，启动记录保持精简。
  expect(Object.hasOwn(startupError(Object.assign(new Error('no stack'), { stack: undefined })), 'stack')).toBe(false)
})

it('writes the startup record as UTF-8 without BOM, creating the directory and rotating the previous record', () => {
  const dir = tempDir()
  // 目录尚不存在：启动记录自行创建，避免首个失败启动无处落盘。
  const stateDir = join(dir, 'nested', 'state')
  recordStartup(stateDir, entry(stateDir, 'http-registered', '2026-11-10T00:00:00.000Z'))
  const raw = readFileSync(join(stateDir, STARTUP_FILE))
  expect(raw[0]).toBe(0x7b)
  expect(JSON.parse(raw.toString('utf8'))).toEqual(entry(stateDir, 'http-registered', '2026-11-10T00:00:00.000Z'))

  recordStartup(stateDir, entry(stateDir, 'ready', '2026-11-10T00:00:01.000Z'))
  expect(JSON.parse(readFileSync(join(stateDir, STARTUP_FILE), 'utf8'))).toMatchObject({ phase: 'ready' })
  expect(JSON.parse(readFileSync(join(stateDir, STARTUP_PREV_FILE), 'utf8'))).toMatchObject({ phase: 'http-registered' })

  // 第三次写入把上一份 ready 轮转为 prev，prev 始终只保留一份。
  recordStartup(stateDir, entry(stateDir, 'failed', '2026-11-10T00:00:02.000Z'))
  expect(JSON.parse(readFileSync(join(stateDir, STARTUP_FILE), 'utf8'))).toMatchObject({ phase: 'failed' })
  expect(JSON.parse(readFileSync(join(stateDir, STARTUP_PREV_FILE), 'utf8'))).toMatchObject({ phase: 'ready' })
})

it('retries a state lock held by another instance and can take it once released', async () => {
  const dir = tempDir()
  const first = await acquireStateLock(dir, { timeoutMs: 0 })
  const waits: number[] = []
  // 锁被占用时不立刻放弃：在超时窗口内按间隔重试，超时后抛出 ELOCKED 供入口记录阶段。
  await expect(acquireStateLock(dir, { timeoutMs: 200, intervalMs: 20, onWait: elapsed => { waits.push(elapsed) } }))
    .rejects.toMatchObject({ code: 'ELOCKED' })
  expect(waits.length).toBeGreaterThan(0)
  await first.release()
  const again = await acquireStateLock(dir, { timeoutMs: 0 })
  await again.release()
})
