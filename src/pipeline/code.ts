/** 代码源同步：把 GitHub / GitLab 仓库同步到流水线专用目录，不覆盖本地改动。 */
import { mkdir } from 'node:fs/promises'
import type { Commands } from '../infra/commands.ts'
import { hostOf } from '../deployment.ts'
import { recordTicketSource } from '../infra/worker-sources.ts'
import { hasEmbeddedCredentials } from './config.ts'

/** 一次同步的结果：目录、检出的提交，以及提交是否发生变化。 */
export interface CodeSyncResult { directory: string; commit: string; changed: boolean }

/** 同步输入；代码来源记录必须已解析为 GitHub 或 GitLab。 */
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
 */
export async function syncCode(input: CodeSyncInput): Promise<CodeSyncResult> {
  const { signal } = input
  const scoped = input.commands.scope(input.codeSource)
  const source = scoped.source
  if (source?.kind !== 'github' && source?.kind !== 'gitlab') throw new Error('代码来源记录必须是 GitHub 或 GitLab')
  const remote = remoteOf(source, input.remoteUrl)
  await mkdir(input.directory, { recursive: true })
  // 登记目录后，git 的凭据助手才会按目录选择该代码来源记录的凭据。
  await recordTicketSource(input.stateDir, input.directory, input.codeSource)
  const git = (args: string[]): Promise<string> => scoped.git(args, input.directory)
  signal.throwIfAborted()
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
  const remoteRef = `refs/remotes/origin/${branch}`
  if (!(await hasRef(git, remoteRef))) throw new Error(`代码来源没有分支：${branch}`)
  const local = await hasRef(git, `refs/heads/${branch}`)
  if (local) {
    await git(['checkout', '--quiet', branch])
    await git(['merge', '--ff-only', '--quiet', `origin/${branch}`])
  } else {
    await git(['checkout', '--quiet', '-B', branch, `origin/${branch}`])
  }
  const commit = await head(git)
  if (!commit) throw new Error('代码同步后没有可检出的提交')
  return { directory: input.directory, commit, changed: commit !== before }
}

/**
 * 代码来源的远端地址。
 * `remote` 非空时直接使用（例如 `git@github.com:owner/repo.git`），否则按来源记录生成 HTTPS 地址；
 * 自建实例使用记录里的站点主机。内嵌凭据的地址会被拒绝，凭据只能来自按目录绑定的 git 助手。
 */
export function remoteOf(source: { kind: 'github'; instanceUrl: string; repository: string } | { kind: 'gitlab'; instanceUrl: string; project: string }, remote = ''): string {
  const override = remote.trim()
  if (override) {
    if (hasEmbeddedCredentials(override)) throw new Error('代码来源远端地址不能包含用户名或密码')
    return override
  }
  if (source.kind === 'github') {
    if (!source.repository) throw new Error('代码来源记录尚未配置仓库')
    return `https://${hostOf(source.instanceUrl, 'github.com')}/${source.repository}.git`
  }
  if (!source.project) throw new Error('代码来源记录尚未配置项目')
  return `https://${hostOf(source.instanceUrl, 'gitlab.com')}/${source.project}.git`
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

/** 远端默认分支：读取 `origin/HEAD` 的符号引用，失败时退回 `main`。 */
async function defaultBranch(git: (args: string[]) => Promise<string>): Promise<string> {
  const parsed = await git(['ls-remote', '--symref', 'origin', 'HEAD']).catch(() => '')
  const branch = /ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(parsed)?.[1] ?? ''
  return branch || 'main'
}
