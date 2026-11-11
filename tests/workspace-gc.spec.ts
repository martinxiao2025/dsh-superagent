/** 执行工作区回收：按工单结束时间保留，运行中与未知目录一律不动。 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { collectWorkspaces } from '../src/app/workspace-gc.ts'

const DAY = 24 * 60 * 60_000
const now = Date.parse('2026-11-11T00:00:00.000Z')
const ended = (id: string, directory: string, at: string): Ticket => ({ id, updatedAt: at,
  execution: { directory, name: id },
  ended: { at, outcome: 'completed', by: 'executor' } } as unknown as Ticket)
const open = (id: string, directory: string, at: string): Ticket => ({ id, updatedAt: at,
  execution: { directory, name: id } } as unknown as Ticket)

let root: string
beforeEach(() => { root = join(mkdtempSync(join(tmpdir(), 'gc-')), 'work') })
afterEach(() => { rmSync(join(root, '..'), { recursive: true, force: true }) })

const make = (project: string, ticket: string): string => {
  const directory = join(root, project, ticket)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'file.txt'), 'work')
  return directory
}

it('reclaims only ended tickets past the retention window and keeps running or unknown directories', async () => {
  const old = make('acme', 'old')
  const recent = make('acme', 'recent')
  const running = make('acme', 'running')
  const stranger = make('acme', 'stranger')
  const onlyOld = make('other', 'only-old')
  const retentionMs = 14 * DAY
  const report = await collectWorkspaces({ workRoot: root, retentionMs, now: () => now, tickets: { list: () => [
    ended('old', old, new Date(now - 20 * DAY).toISOString()),
    ended('recent', recent, new Date(now - 2 * DAY).toISOString()),
    open('running', running, new Date(now - 40 * DAY).toISOString()),
    ended('only-old', onlyOld, new Date(now - 30 * DAY).toISOString()),
  ] } })
  expect(report.removed.sort()).toEqual([old, onlyOld].sort())
  expect(report).toMatchObject({ disabled: false, scanned: 5, kept: 2, unknown: 1, errors: [] })
  expect(existsSync(old)).toBe(false)
  expect(existsSync(onlyOld)).toBe(false)
  // 项目目录只在清空后删除：`acme` 仍有保留项。
  expect(existsSync(join(root, 'acme'))).toBe(true)
  expect(existsSync(join(root, 'other'))).toBe(false)
  expect(existsSync(running)).toBe(true)
  expect(existsSync(recent)).toBe(true)
  expect(existsSync(stranger)).toBe(true)
})

it('does nothing when the retention window is zero or the root is missing', async () => {
  const old = make('acme', 'old')
  const ticket = ended('old', old, new Date(now - 400 * DAY).toISOString())
  const disabled = await collectWorkspaces({ workRoot: root, retentionMs: 0, now: () => now, tickets: { list: () => [ticket] } })
  expect(disabled).toMatchObject({ disabled: true, removed: [] })
  expect(existsSync(old)).toBe(true)
  const absent = await collectWorkspaces({ workRoot: join(root, 'absent'), retentionMs: DAY, now: () => now, tickets: { list: () => [ticket] } })
  expect(absent).toMatchObject({ scanned: 0, removed: [] })
})

it('records a failing removal and keeps the directory for the next pass', async () => {
  const old = make('acme', 'old')
  const report = await collectWorkspaces({ workRoot: root, retentionMs: DAY, now: () => now,
    tickets: { list: () => [ended('old', old, new Date(now - 5 * DAY).toISOString())] },
    remove: async () => { throw new Error('in use') } })
  expect(report.errors).toEqual([`${old}: in use`])
  expect(report.removed).toEqual([])
  expect(existsSync(old)).toBe(true)
})
