/** 工单执行工作区：从轮询工作副本创建独立 worktree、复用与清理。 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { materializeWorkspace, removeWorkspace } from '../src/code-repos/workspace.ts'
import { gitEnv } from './fixtures/git.ts'

const temporary = (): string => mkdtempSync(join(tmpdir(), 'dsh-workspace-'))

describe('ticket workspace', () => {
  const git = async (args: string[], cwd: string): Promise<string> =>
    execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' })
  /** 造一个已同步的轮询工作副本 `stateDir/repos/<repo>`，带一个提交。 */
  const checkout = (stateDir: string, repo: string): string => {
    const directory = join(stateDir, 'repos', repo)
    mkdirSync(directory, { recursive: true })
    git(['init', '-q'], directory)
    git(['config', 'user.email', 'test@example.com'], directory)
    git(['config', 'user.name', 'Test'], directory)
    writeFileSync(join(directory, 'README.md'), 'hello')
    git(['add', '.'], directory)
    git(['commit', '-qm', 'initial'], directory)
    return directory
  }

  it('checks the project repository out into the ticket directory', async () => {
    const stateDir = temporary()
    const source = checkout(stateDir, 'repo-1')
    const directory = join(stateDir, 'work', 'project', 'ticket-1')
    await expect(materializeWorkspace({ git, stateDir, repo: 'repo-1', directory })).resolves.toBe('created')
    expect(readFileSync(join(directory, 'README.md'), 'utf8')).toBe('hello')
    // 执行目录是独立的 worktree，而不是与轮询副本共用同一个工作树。
    expect(readFileSync(join(directory, '.git'), 'utf8')).toContain('gitdir:')
    expect((await git(['rev-parse', '--show-toplevel'], directory)).trim()).not.toBe(source)
    // 同一工单重试时复用已准备好的工作区。
    await expect(materializeWorkspace({ git, stateDir, repo: 'repo-1', directory })).resolves.toBe('reused')
    await removeWorkspace(git, stateDir, 'repo-1', directory)
    await expect(materializeWorkspace({ git, stateDir, repo: 'repo-1', directory })).resolves.toBe('created')
  })

  it('refuses to overwrite an unrelated non-empty directory', async () => {
    const stateDir = temporary()
    checkout(stateDir, 'repo-1')
    const directory = join(stateDir, 'work', 'project', 'ticket-2')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'notes.txt'), 'keep me')
    await expect(materializeWorkspace({ git, stateDir, repo: 'repo-1', directory })).rejects.toThrow('拒绝覆盖')
  })

  it('reports a repository that has not been synced instead of creating an empty directory', async () => {
    const stateDir = temporary()
    const directory = join(stateDir, 'work', 'project', 'ticket-3')
    await expect(materializeWorkspace({ git, stateDir, repo: 'missing', directory })).rejects.toThrow('尚未同步')
  })
})
