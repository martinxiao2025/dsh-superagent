/** 状态目录重置：先备份再清理插件拥有的条目，保留其他文件，失败时不删除原始数据。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ResetError, resetState } from '../src/app/reset.ts'

let directory: string
let state: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'reset-'))
  state = join(directory, 'state')
  mkdirSync(state)
  writeFileSync(join(state, 'orchestrator.sqlite'), 'database')
  writeFileSync(join(state, 'orchestrator.sqlite-wal'), 'wal')
  writeFileSync(join(state, 'startup.json'), '{}')
  writeFileSync(join(state, 'admission-image-1.png'), 'image')
  mkdirSync(join(state, 'repos', 'acme'), { recursive: true })
  writeFileSync(join(state, 'repos', 'acme', 'config'), 'git config')
  mkdirSync(join(state, 'secrets'))
  writeFileSync(join(state, 'secrets', 'token'), 'secret')
  writeFileSync(join(state, 'notes.txt'), 'keep me')
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const at = new Date('2026-11-11T00:00:00.000Z')

it('backs up every entry before clearing only the ones the plugin owns', async () => {
  const backupRoot = join(directory, 'backup')
  const report = await resetState({ stateDir: state, backupRoot, now: () => at })
  expect(report.backup).toBe(join(backupRoot, '2026-11-11T00-00-00-000Z'))
  expect(report.removed.sort()).toEqual(['admission-image-1.png', 'orchestrator.sqlite', 'orchestrator.sqlite-wal', 'repos', 'secrets', 'startup.json'])
  expect(report.kept).toEqual(['notes.txt'])
  // 备份完整，原始文件可从中恢复；状态目录只剩非插件条目，即空基线。
  expect(readFileSync(join(report.backup!, 'orchestrator.sqlite'), 'utf8')).toBe('database')
  expect(readFileSync(join(report.backup!, 'repos', 'acme', 'config'), 'utf8')).toBe('git config')
  expect(readFileSync(join(report.backup!, 'secrets', 'token'), 'utf8')).toBe('secret')
  expect(readdirSync(state)).toEqual(['notes.txt'])
})

it('treats a missing state directory as an empty baseline', async () => {
  const report = await resetState({ stateDir: join(directory, 'absent'), backupRoot: join(directory, 'backup'), now: () => at })
  expect(report).toMatchObject({ removed: [], kept: [] })
  expect(report.backup).toBeUndefined()
})

it('aborts before deleting anything when the backup cannot be written', async () => {
  const blocked = join(directory, 'file')
  writeFileSync(blocked, 'not a directory')
  await expect(resetState({ stateDir: state, backupRoot: join(blocked, 'backup'), now: () => at })).rejects.toBeInstanceOf(ResetError)
  expect(readdirSync(state).sort()).toEqual(['admission-image-1.png', 'notes.txt', 'orchestrator.sqlite', 'orchestrator.sqlite-wal', 'repos', 'secrets', 'startup.json'])
})

it('can skip the backup when the caller already has one', async () => {
  const report = await resetState({ stateDir: state, backup: false, now: () => at })
  expect(report.backup).toBeUndefined()
  expect(existsSync(join(state, 'orchestrator.sqlite'))).toBe(false)
  expect(readdirSync(state)).toEqual(['notes.txt'])
})
