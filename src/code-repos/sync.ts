/** 代码仓库同步：把 GitHub / GitLab 仓库同步到工作副本目录，不覆盖本地改动。 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Commands } from '../infra/commands.ts'
import { hostOf, type Probe, type RepoAuth } from '../deployment.ts'
import { recordTicketSource } from '../infra/worker-sources.ts'

/** 判断远端地址是否内嵌了用户名与密码；内嵌凭据的地址会被拒绝，凭据只能来自按目录绑定的 git 助手。 */
export function hasEmbeddedCredentials(remote: string): boolean {
  return /[^/@\s]+:[^/@\s]+@/.test(remote)
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** 错误与日志只展示脱敏后的地址，避免自定义远端里的凭据被写进界面或日志。 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-zA-Z][\w+.-]*:\/\/)([^/@\s]+)@/g, '$1***@')
}

/** 展开私钥路径里的 `~`，其余原样返回。 */
export function sshKeyFile(key: string): string {
  const trimmed = key.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/**
 * 组装 git 的 `core.sshCommand`。
 * `BatchMode` 让缺少密钥时立即失败而不是等待交互输入；`accept-new` 只在首次接触时信任主机。
 */
export function sshCommandOf(key = ''): string {
  const base = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'
  const file = sshKeyFile(key)
  if (!file) return base
  if (!isAbsolute(file)) throw new Error(`SSH 私钥路径必须是绝对路径：${file}`)
  return `${base} -i "${file.replace(/"/g, '\\"')}"`
}

/** 一次同步的结果：目录、检出的提交、提交是否变化，以及远端是否为空仓库。 */
export interface CodeSyncResult { directory: string; commit: string; changed: boolean; empty: boolean }

/** 一次远端探测的结果：分支列表与默认分支；`branches` 为空表示空仓库。 */
export interface RemoteRefs { branches: string[]; defaultBranch: string }

/**
 * 用 `git ls-remote` 探测远端是否可访问。
 * 退出码非零表示不可访问（含权限、站点、主机指纹问题）；退出码为零但没有分支表示仓库为空。
 */
export async function probeRemote(probe: Probe, remote: string, sshKey = ''): Promise<RemoteRefs> {
  if (hasEmbeddedCredentials(remote)) throw new Error('代码仓库远端地址不能包含用户名或密码')
  let text: string
  try {
    text = await probe(['git', 'ls-remote', '--symref', remote], { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: sshCommandOf(sshKey) })
  } catch (error) { throw new Error(redactCredentials(errorText(error))) }
  const branches = [...text.matchAll(/^[0-9a-f]{40}\trefs\/heads\/(\S+)$/gm)].map(match => match[1]!)
  const defaultBranch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(text)?.[1] ?? (branches.includes('main') ? 'main' : branches[0] ?? '')
  return { branches, defaultBranch }
}

/** 同步输入；代码仓库记录必须已解析为 GitHub 或 GitLab。 */
export interface CodeSyncInput {
  commands: Commands
  stateDir: string
  codeSource: string
  /** 可选远端地址；非空时用它作为 origin，支持 `git@host:path` 形式的 SSH 地址。 */
  remoteUrl?: string
  branch: string
  directory: string
  signal: AbortSignal
}

/**
 * 同步代码源到 `directory`。
 * 首次同步初始化仓库并检出分支；之后只做快进合并，遇到本地改动或分叉时明确失败，不执行重置。
 * 远端是空仓库时返回 `empty: true`，而不是把它当成同步失败。
 */
export async function syncCode(input: CodeSyncInput): Promise<CodeSyncResult> {
  const { signal } = input
  const scoped = input.commands.scope(input.codeSource)
  const source = scoped.source
  if (source?.kind !== 'github' && source?.kind !== 'gitlab') throw new Error('代码仓库记录必须是 GitHub 或 GitLab')
  // 测试与预检可能没有解析出部署；此时 `remoteOf` 使用内置默认主机。
  const remote = remoteOf(source, input.remoteUrl, scoped.deployment
    ? { github: scoped.deployment.githubHost.get(), gitlab: scoped.deployment.gitlabHost.get() } : undefined)
  // SSH 认证把私钥交给 git，而不是依赖按目录绑定的 HTTPS 凭据助手。
  const ssh = source.auth === 'ssh' ? ['-c', `core.sshCommand=${sshCommandOf(source.sshKey)}`] : []
  const git = (args: string[]): Promise<string> => scoped.git(ssh.length ? [...ssh, ...args] : args, input.directory)
  await mkdir(input.directory, { recursive: true })
  // 登记目录后，git 的凭据助手才会按目录选择该代码仓库记录的凭据。
  await recordTicketSource(input.stateDir, input.directory, input.codeSource)
  signal.throwIfAborted()
  try {
    if (!(await isRepository(git))) {
      await git(['init', '--quiet'])
      await git(['remote', 'add', 'origin', remote])
    } else {
      await git(['remote', 'set-url', 'origin', remote])
    }
    const before = await head(git)
    const branch = input.branch.trim() || await defaultBranch(git)
    await git(['fetch', '--prune', '--quiet', 'origin'])
    signal.throwIfAborted()
    if (!(await remoteBranches(git)).length) {
      // 空仓库：clone 成功，但没有分支或提交；调用方据此给出「仓库为空」的明确结果。
      return { directory: input.directory, commit: '', changed: before !== '', empty: true }
    }
    const remoteRef = `refs/remotes/origin/${branch}`
    if (!(await hasRef(git, remoteRef))) throw new Error(`代码仓库没有分支：${branch}`)
    const local = await hasRef(git, `refs/heads/${branch}`)
    if (local) {
      await git(['checkout', '--quiet', branch])
      await git(['merge', '--ff-only', '--quiet', `origin/${branch}`])
    } else {
      await git(['checkout', '--quiet', '-B', branch, `origin/${branch}`])
    }
    const commit = await head(git)
    if (!commit) throw new Error('代码同步后没有可检出的提交')
    return { directory: input.directory, commit, changed: commit !== before, empty: false }
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(redactCredentials(errorText(error)))
  }
}

/**
 * 代码仓库的远端地址。
 * 优先使用调用方覆盖值，其次记录里的自定义 `remote`；都没有时按认证方式推导：
 * `ssh` 生成 `git@host:owner/repo.git`，`https` 生成 `https://host/owner/repo.git`。
 * 内嵌凭据的地址会被拒绝，凭据只能来自本机 SSH key 或按目录绑定的 git 助手。
 * `hosts` 给出官方站点的默认主机，使自托管实例与官方实例共用同一套推导。
 */
export function remoteOf(source: {
  kind: 'github'; instanceUrl: string; repository: string; auth?: RepoAuth; remote?: string
} | {
  kind: 'gitlab'; instanceUrl: string; project: string; auth?: RepoAuth; remote?: string
}, remote = '', hosts: { github?: string; gitlab?: string } | undefined = undefined): string {
  const override = remote.trim() || source.remote?.trim() || ''
  if (override) {
    if (hasEmbeddedCredentials(override)) throw new Error('代码仓库远端地址不能包含用户名或密码')
    return override
  }
  const ssh = source.auth === 'ssh'
  if (source.kind === 'github') {
    if (!source.repository) throw new Error('代码仓库记录尚未配置仓库')
    const host = hostOf(source.instanceUrl, hosts?.github ?? 'github.com')
    return ssh ? `git@${host}:${source.repository}.git` : `https://${host}/${source.repository}.git`
  }
  if (!source.project) throw new Error('代码仓库记录尚未配置项目')
  const host = hostOf(source.instanceUrl, hosts?.gitlab ?? 'gitlab.com')
  return ssh ? `git@${host}:${source.project}.git` : `https://${host}/${source.project}.git`
}

/** 判断目录是否已经是 git 仓库。 */
async function isRepository(git: (args: string[]) => Promise<string>): Promise<boolean> {
  return git(['rev-parse', '--git-dir']).then(() => true, () => false)
}

/** 当前提交；空仓库返回空字符串。 */
async function head(git: (args: string[]) => Promise<string>): Promise<string> {
  return git(['rev-parse', 'HEAD']).then(value => value.trim(), () => '')
}

/** 引用是否存在。 */
async function hasRef(git: (args: string[]) => Promise<string>, ref: string): Promise<boolean> {
  return git(['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false)
}

/** 同步后本地已有哪些远端分支；为空表示远端是空仓库。 */
async function remoteBranches(git: (args: string[]) => Promise<string>): Promise<string[]> {
  const text = await git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
  return text.split(/\r?\n/).map(line => line.trim()).filter(ref => ref && ref !== 'origin' && ref !== 'origin/HEAD')
}

/** 远端默认分支：读取 `origin/HEAD` 的符号引用，失败时退回 `main`。 */
async function defaultBranch(git: (args: string[]) => Promise<string>): Promise<string> {
  const parsed = await git(['ls-remote', '--symref', 'origin', 'HEAD']).catch(() => '')
  const branch = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(parsed)?.[1] ?? ''
  return branch || 'main'
}
