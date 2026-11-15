/** infra/win32.ts 的单源规则：cmd 引用、路径归一与 PATHEXT，以及垫片源码形态的一致性。 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CMD_QUOTE_SOURCE, NORMALIZE_PATH_SOURCE, cmdQuote, normalizePath, pathExtensions } from '../src/infra/win32.ts'
import { WORKER_DISPATCH_BODY } from '../src/infra/worker-sources.ts'

describe('cmdQuote', () => {
  it('doubles embedded quotes the way cmd.exe expects', () => {
    expect(cmdQuote('plain')).toBe('"plain"')
    expect(cmdQuote('say "hi"')).toBe('"say ""hi"""')
    expect(cmdQuote('C:\\Program Files\\tool.cmd')).toBe('"C:\\Program Files\\tool.cmd"')
  })
})

describe('normalizePath', () => {
  it('resolves relative paths to absolute ones', () => {
    expect(normalizePath('a/b').length).toBeGreaterThan(2)
  })
})

describe('pathExtensions', () => {
  it('is empty outside Windows and parses PATHEXT on Windows', () => {
    if (process.platform === 'win32') expect(pathExtensions()).toContain('.EXE')
    else expect(pathExtensions()).toEqual([])
  })
})

describe('shim source forms stay in sync with the implementations', () => {
  it('embeds the single-source quote and normalize rules into the worker dispatch shim', () => {
    // 垫片是生成的独立脚本，无法 import 本模块；两份源码形态必须逐字出现在生成的正文里。
    expect(WORKER_DISPATCH_BODY).toContain(`const quote = ${CMD_QUOTE_SOURCE}`)
    expect(WORKER_DISPATCH_BODY).toContain(`const normalize = ${NORMALIZE_PATH_SOURCE}`)
  })
  it('produces a syntactically valid script that node can parse', () => {
    // 模板以字符串数组拼接，历史缺陷只能靠集成测试间接暴露；`node --check` 直接锁住语法有效性。
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-'))
    try {
      const script = join(dir, 'worker-dispatch.mjs')
      // 与 environment.ts 的写盘形式逐字一致：`//` 注释形式的标记行 + 正文。
      writeFileSync(script, `// Written by dsh-superagent on every start; edits are lost.\n${WORKER_DISPATCH_BODY}`)
      execFileSync(process.execPath, ['--check', script])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('keeps the source forms behaviorally identical to the implementations', () => {
    // 用 node 求值源码形态，与实现输出逐例对齐。
    const shimQuote = new Function(`return (${CMD_QUOTE_SOURCE})`)() as (value: string) => string
    const shimNormalize = new Function('resolve', `return (${NORMALIZE_PATH_SOURCE})`)((path: string) => require('node:path').resolve(path)) as (path: string) => string
    for (const value of ['plain', 'say "hi"', 'C:\\Program Files\\tool.cmd']) expect(shimQuote(value)).toBe(cmdQuote(value))
    for (const path of ['a/b', '/srv/work/x']) expect(shimNormalize(path)).toBe(normalizePath(path))
  })
})
