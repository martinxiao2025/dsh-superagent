/**
 * Windows compatibility of the bundle: drive letters and backslashes are absolute paths, executables are
 * resolved with PATHEXT, worker shims run through cmd.exe, and the worker probe and the prepare command use
 * the platform's shell instead of POSIX-only `env` and `sh`. Skipped elsewhere, where those assumptions hold.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { Config, executable, workerProbe } from '../src/deployment.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { shellArgv, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

const exec = promisify(execFile)
const windows = process.platform === 'win32'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'windows-compat-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
/** Runs a batch file the way a worker shell would, through cmd's `call`, without treating it as a POSIX script. */
const batch = (file: string, args: string[] = []) => exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'call', file, ...args])

describe.skipIf(!windows)('Windows compatibility', () => {
  it('accepts a drive-letter state directory and still refuses a relative one', () => {
    const stateDir = join(dir, 'state')
    expect(stateDir).toMatch(/^[A-Za-z]:\\/)
    expect(Config({ stateDir }).stateDir).toBe(stateDir)
    expect(() => Config({ stateDir: 'relative\\dir' })).toThrow()
    expect(() => Config({ stateDir: '~\\dir' })).toThrow()
  })
  it('accepts a drive-letter ticket directory, or an empty one for <stateDir>/work', () => {
    expect(ExecutorConfigSchema.parse({ directory: join(dir, 'tickets') }).directory).toBe(join(dir, 'tickets'))
    expect(ExecutorConfigSchema.parse({ directory: '' }).directory).toBe('')
    expect(() => ExecutorConfigSchema.parse({ directory: 'tickets' })).toThrow()
  })
  it('resolves a command name on PATH through PATHEXT', async () => {
    writeFileSync(join(dir, 'gh.cmd'), '@echo off\r\n')
    const found = executable('gh', dir)
    expect(found.toLowerCase()).toBe(join(dir, 'gh.cmd').toLowerCase())
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const resolved = (await exec('where', ['gh'], { env: { ...process.env, PATH: `${dir};${system32}` } })).stdout.split(/\r?\n/)[0]!.trim()
    expect(found.toLowerCase()).toBe(resolved.toLowerCase())
    expect(() => executable('missing-cli', dir)).toThrow('missing-cli is not an executable file on PATH')
  })
  it('writes worker shims batch files that cmd.exe runs and that drop their own directory from PATH', async () => {
    const cli = join(dir, 'gh-agent.cmd')
    writeFileSync(cli, '@echo off\r\necho agent-bot\r\necho %PATH%\r\n')
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli }, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    expect(readdirSync(bin).sort()).toEqual(['gh.cmd', 'lark-cli.cmd', 'personal-gh.cmd'])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('[credential "https://github.com"]')
    const { stdout } = await batch(join(bin, 'gh.cmd'), ['api', 'user'])
    const [login, path] = stdout.trim().split(/\r?\n/)
    expect(login).toBe('agent-bot')
    expect(path!.split(';').map(entry => entry.toLowerCase())).not.toContain(bin.toLowerCase())
    await expect(batch(join(bin, 'personal-gh.cmd'))).rejects.toMatchObject({ code: 1 })
  })
  it('probes CLIs without the POSIX env command, passing PATH as a spawn environment', async () => {
    const specs: SubprocessSpawnSpec[] = []
    const reader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
    const runtime = { spawn: (spec: SubprocessSpawnSpec) => { specs.push(spec)
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader, stderr: reader } } } } as unknown as SubprocessRuntime
    await workerProbe(runtime, dir, dir, new AbortController().signal)(['git', 'config', '--list'])
    expect(specs).toHaveLength(1)
    expect(specs[0]!.argv).toEqual(['git', 'config', '--list'])
    expect(specs[0]!.env?.PATH?.toLowerCase().split(';')).not.toContain(workerBin(dir).toLowerCase())
  })
  it('runs a prepare command through the platform shell', async () => {
    const [program, ...args] = shellArgv('echo prepared')
    const { stdout } = await exec(program!, args)
    expect(stdout.trim()).toBe('prepared')
  })
})
