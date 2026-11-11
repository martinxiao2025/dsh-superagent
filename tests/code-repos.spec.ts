/** 代码仓库同步：远端推导、SSH 命令、远端探测与空仓库结果。 */
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasEmbeddedCredentials, probeRemote, redactCredentials, remoteOf, sshCommandOf, sshKeyFile, syncCode } from '../src/code-repos/sync.ts'
import type { Commands } from '../src/infra/commands.ts'

const github = { kind: 'github' as const, instanceUrl: '', repository: 'acme/widgets', auth: 'https' as const, remote: '', sshKey: '' }
const gitlab = { kind: 'gitlab' as const, instanceUrl: '', project: 'group/sub/widgets', auth: 'https' as const, remote: '', sshKey: '' }
const temporary = (): string => mkdtempSync(join(tmpdir(), 'dsh-code-repos-'))
/** git 参数可能以 SSH 的 `-c core.sshCommand=...` 开头；取实际子命令。 */
const command = (args: string[]): string => { const index = args.indexOf('-c'); return (index >= 0 ? args[index + 2] : args[0])! }

/** 只实现 `syncCode` 用到的 `scope`/`source`/`git`，并记录每次 git 调用。 */
const fake = (source: unknown, run: (args: string[]) => string | Promise<string>) => {
  const calls: string[][] = []
  const commands = { scope: () => ({ source, git: async (args: string[]) => { calls.push(args); return run(args) } }) } as unknown as Commands
  return { commands, calls }
}

describe('remote address', () => {
  it('derives HTTPS or SSH from the record without hard-coding HTTPS', () => {
    expect(remoteOf(github)).toBe('https://github.com/acme/widgets.git')
    expect(remoteOf({ ...github, auth: 'ssh' })).toBe('git@github.com:acme/widgets.git')
    // 自建实例使用记录里的主机名，而不是 github.com。
    expect(remoteOf({ ...github, instanceUrl: 'https://git.example.com', auth: 'ssh' })).toBe('git@git.example.com:acme/widgets.git')
    expect(remoteOf({ ...gitlab, auth: 'ssh' })).toBe('git@gitlab.com:group/sub/widgets.git')
    // 官方站点的主机来自配置默认值，调用方可以替换。
    expect(remoteOf(github, '', { github: 'ghe.example.com' })).toBe('https://ghe.example.com/acme/widgets.git')
    expect(remoteOf(gitlab, '', { gitlab: 'lab.example.com' })).toBe('https://lab.example.com/group/sub/widgets.git')
  })

  it('prefers a custom remote, then the record remote, and refuses embedded credentials', () => {
    expect(remoteOf({ ...github, auth: 'ssh', remote: 'git@example.com:x/y.git' })).toBe('git@example.com:x/y.git')
    expect(remoteOf({ ...github, auth: 'ssh', remote: 'git@example.com:x/y.git' }, 'ssh://git@example.com/x/y.git'))
      .toBe('ssh://git@example.com/x/y.git')
    expect(() => remoteOf({ ...github, remote: 'https://user:pass@example.com/x/y.git' })).toThrow('不能包含用户名或密码')
    expect(hasEmbeddedCredentials('https://user:pass@example.com/x')).toBe(true)
    expect(hasEmbeddedCredentials('git@github.com:acme/widgets.git')).toBe(false)
    expect(() => remoteOf({ ...github, repository: '' })).toThrow('尚未配置仓库')
  })
})

describe('ssh command', () => {
  it('runs git without interactive prompts and uses the record key when given', () => {
    expect(sshCommandOf()).toBe('ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new')
    expect(sshCommandOf('/home/me/.ssh/id_ed25519')).toBe('ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "/home/me/.ssh/id_ed25519"')
    expect(() => sshCommandOf('relative/key')).toThrow('绝对路径')
    expect(sshKeyFile('~/.ssh/id_ed25519')).toBe(join(homedir(), '.ssh/id_ed25519'))
  })
})

describe('remote probe', () => {
  it('reports branches and the default branch, and an empty repository as no branches', async () => {
    const sha = 'a'.repeat(40)
    const text = `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/main\n`
    expect(await probeRemote(async () => text, 'git@github.com:acme/widgets.git')).toEqual({ branches: ['main'], defaultBranch: 'main' })
    expect(await probeRemote(async () => '', 'git@github.com:acme/empty.git')).toEqual({ branches: [], defaultBranch: '' })
  })

  it('passes the key to git and redacts credentials from failures', async () => {
    const seen: Record<string, string>[] = []
    await probeRemote(async (_argv, env = {}) => { seen.push(env); return '' }, 'git@github.com:acme/widgets.git', '/home/me/.ssh/id_ed25519')
    expect(seen[0]).toMatchObject({ GIT_TERMINAL_PROMPT: '0' })
    expect(seen[0]!.GIT_SSH_COMMAND).toContain('-i "/home/me/.ssh/id_ed25519"')
    await expect(probeRemote(async () => { throw new Error('fatal: unable to access https://user:pass@example.com/x') }, 'https://example.com/x'))
      .rejects.toThrow('https://***@example.com/x')
    await expect(probeRemote(async () => '', 'https://user:pass@example.com/x')).rejects.toThrow('不能包含用户名或密码')
    expect(redactCredentials('https://user:pass@example.com/x')).toBe('https://***@example.com/x')
  })
})

describe('syncCode', () => {
  it('treats an empty remote as an explicit empty result instead of a failure', async () => {
    const directory = temporary()
    const { commands, calls } = fake({ ...github, auth: 'ssh' }, (args) => {
      if (command(args) === 'rev-parse') throw new Error('not a repository')
      return ''
    })
    const result = await syncCode({ commands, stateDir: temporary(), codeSource: 'demo-tree', branch: 'main', directory,
      signal: new AbortController().signal })
    expect(result).toEqual({ directory, commit: '', changed: false, empty: true })
    // 空仓库不尝试检出，也没有把远端当成本地分支。
    expect(calls.some(args => args.includes('checkout'))).toBe(false)
    // SSH 记录把私钥命令带到每条 git 调用上，远端是 SSH 地址而不是 HTTPS。
    expect(calls.every(args => args[0] === '-c' && args[1]!.startsWith('core.sshCommand='))).toBe(true)
    expect(calls).toContainEqual(['-c', expect.stringMatching(/^core\.sshCommand=/) as unknown as string, 'remote', 'add', 'origin',
      'git@github.com:acme/widgets.git'])
  })

  it('checks out a branch that exists and reports the commit and change', async () => {
    const directory = temporary()
    let heads = 0
    const { commands, calls } = fake(github, (args) => {
      const name = command(args)
      if (name === 'rev-parse') {
        if (args.includes('--show-toplevel')) return `${directory}\n`
        if (args.includes('--verify') && args.some(arg => arg.startsWith('refs/heads/'))) throw new Error('missing ref')
        if (args.includes('--verify')) return 'refs/remotes/origin/main'
        return ++heads === 1 ? '' : 'abc123'
      }
      if (name === 'for-each-ref') return 'origin/main'
      return ''
    })
    const result = await syncCode({ commands, stateDir: temporary(), codeSource: 'demo-tree', branch: 'main', directory,
      signal: new AbortController().signal })
    expect(result).toEqual({ directory, commit: 'abc123', changed: true, empty: false })
    expect(calls).toContainEqual(['checkout', '--quiet', '-B', 'main', 'origin/main'])
  })

  it('initializes a nested directory instead of adopting the outer repository', async () => {
    const outer = temporary()
    const directory = join(outer, 'repos', 'demo-tree')
    const { commands, calls } = fake(github, (args) => {
      // 目录本身不是仓库时，父仓库的 toplevel 会返回外层目录；不能据此改写父仓库远端。
      if (command(args) === 'rev-parse' && args.includes('--show-toplevel')) return `${outer}\n`
      return ''
    })
    await syncCode({ commands, stateDir: temporary(), codeSource: 'demo-tree', branch: 'main', directory,
      signal: new AbortController().signal })
    expect(calls).toContainEqual(['init', '--quiet'])
    expect(calls).toContainEqual(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
    expect(calls.some(args => args.includes('set-url'))).toBe(false)
  })

  it('refuses a record that is not a GitHub or GitLab repository', async () => {
    const { commands } = fake(undefined, () => '')
    await expect(syncCode({ commands, stateDir: temporary(), codeSource: 'feishu', branch: 'main', directory: temporary(),
      signal: new AbortController().signal })).rejects.toThrow('代码仓库记录必须是 GitHub 或 GitLab')
  })
})
