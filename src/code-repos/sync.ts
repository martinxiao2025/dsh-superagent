/** 代码仓库同步：把 GitHub / GitLab 仓库同步到工作副本目录，不覆盖本地改动。 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Commands } from '../infra/commands.ts'
import { hostOf, type Probe, type RepoAuth } from '../deployment.ts'
import { recordTicketSource } from '../infra/worker-sources.ts'
import type { SecretMaterial } from '../secrets/vault.ts'

/** 一次 git 调用的认证材料；只来自 Git 凭据，不进入设置或日志。 */
export interface GitAuth {
  kind: 'ssh' | 'https'
  material: Pick<SecretMaterial, 'username' | 'token' | 'privateKey'>
}

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

/**
 * 把 Git 凭据材料转成一次 git 调用使用的参数。
 * SSH 私钥写入临时目录并在调用后删除；HTTPS 令牌放进只对本次调用生效的请求头。
 */
export async function gitAuthArgs(auth: GitAuth): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  if (auth.kind === 'ssh') {
    const key = auth.material.privateKey ?? ''
    if (!key) return { args: [], cleanup: async () => {} }
    const directory = await mkdtemp(join(tmpdir(), 'dsh-git-'))
    const file = join(directory, 'key')
    await writeFile(file, key, { mode: 0o600 })
    return { args: ['-c', `core.sshCommand=${sshCommandOf(file)}`], cleanup: () => rm(directory, { recursive: true, force: true }) }
  }
  const token = auth.material.token ?? ''
  if (!token) return { args: [], cleanup: async () => {} }
  const user = auth.material.username || 'x-access-token'
  const header = Buffer.from(`${user}:${token}`).toString('base64')
  return { args: ['-c', `http.extraheader=AUTHORIZATION: basic ${header}`], cleanup: async () => {} }
}

/** 一次同步的结果：目录、检出的提交、提交是否变化，以及远端是否为空仓库。 */
export interface CodeSyncResult { directory: string; commit: string; changed: boolean; empty: boolean }

/** 一次远端探测的结果：分支列表与默认分支；`branches` 为空表示空仓库。 */
export interface RemoteRefs { branches: string[]; defaultBranch: string }

/**
 * 用 `git ls-remote` 探测远端是否可访问。
 * 退出码非零表示不可访问（含权限、站点、主机指纹问题）；退出码为零但没有分支表示仓库为空。
 */
export async function probeRemote(probe: Probe, remote: string, sshKey = '', auth?: GitAuth): Promise<RemoteRefs> {
  if (hasEmbeddedCredentials(remote)) throw new Error('代码仓库远端地址不能包含用户名或密码')
  const extra = auth ? await gitAuthArgs(auth) : { args: [] as string[], cleanup: async () => {} }
  let text: string
  try {
    text = await probe(['git', ...extra.args, 'ls-remote', '--symref', remote], { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: sshCommandOf(sshKey) })
  } catch (error) { throw new Error(redactCredentials(errorText(error))) }
  finally { await extra.cleanup() }
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
  /**
   * 回写路径专用（评审 S1）：分叉时重置到远端而不是失败。仅当调用方能保证写入会重放——
   * 回写副作用仍在退避重试中，被丢弃的只是本副作用自己尚未推送成功的提交，CAS 期望值
   * 与重置后的清单状态一致，写入随后重放。轮询路径必须保持缺省的无损语义。
   */
  resetOnDivergence?: boolean
  signal: AbortSignal
  /** 项目选择的 Git 凭据材料；为空时沿用记录里的 SSH key 或本机助手。 */
  auth?: GitAuth
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
  // 优先使用项目选择的 Git 凭据；没有凭据时退回记录里的 SSH key 或本机助手。
  const auth = input.auth ? await gitAuthArgs(input.auth) : { args: [] as string[], cleanup: async () => {} }
  const ssh = auth.args.length ? auth.args : source.auth === 'ssh' ? ['-c', `core.sshCommand=${sshCommandOf(source.sshKey)}`] : []
  const git = (args: string[]): Promise<string> => scoped.git(ssh.length ? [...ssh, ...args] : args, input.directory)
    await mkdir(input.directory, { recursive: true })
    // 登记目录后，git 的凭据助手才会按目录选择该代码仓库记录的凭据。
    await recordTicketSource(input.stateDir, input.directory, input.codeSource)
    signal.throwIfAborted()
    try {
      if (!(await isRepository(git, input.directory))) {
        await git(['init', '--quiet'])
        await git(['remote', 'add', 'origin', remote])
      } else {
        // 远端更换后旧镜像与新历史没有共同祖先，merge --ff-only 必然报 unrelated histories；
        // 工作副本是纯镜像（执行发生在独立 worktree），远端变化时重建镜像而不是报错。
        const previous = (await git(['remote', 'get-url', 'origin']).catch(() => '')).trim()
        if (previous && previous !== remote) {
          // 重建前先拆除挂在镜像上的工单 worktree（评审 E11）：它们是镜像登记的资源，
          // 直接 rm 镜像会留下指向已消失 gitdir 的残破目录，复活工单的 materialize
          // 校验将从此永久失败；逐个走 git 的拆除协议，单个失败不阻塞重建。
          await detachWorktrees(git, input.directory)
          await rm(input.directory, { recursive: true, force: true })
          await mkdir(input.directory, { recursive: true })
          await git(['init', '--quiet'])
          await git(['remote', 'add', 'origin', remote])
        } else {
          await git(['remote', 'set-url', 'origin', remote])
        }
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
      // 镜像上可能有回写产生的本地提交（评审 S1：011 P0-2 的「提交代替脏文件」修复的后果）。
      // 三种情况全部无损处理：
      // · 本地不领先：正常路径，`merge --ff-only` 快进到远端；
      // · 本地领先、远端未动：保留本地提交（回写结果还在镜像上），ff-only 是空操作——待 push 能力接入后推送；
      // · 双方都前进（分叉）：显式失败并说明处置。绝不静默 reset 丢弃本地回写提交——
      //   已完成的回写副作用不会重放，重置等于丢写，清单行回到待处理还可能触发重复执行。
      const ahead = Number((await git(['rev-list', '--count', `origin/${branch}..${branch}`])).trim() || '0')
      const behind = Number((await git(['rev-list', '--count', `${branch}..origin/${branch}`])).trim() || '0')
      if (ahead > 0 && behind > 0) {
        if (!input.resetOnDivergence) {
          throw new Error(`代码镜像与远端分叉：本地有 ${ahead} 个未推送的回写提交，远端另有 ${behind} 个新提交。`
            + '请在镜像目录手工 rebase 或推送本地提交后重试（push 能力接入见优化计划 S1）')
        }
        // 回写路径（评审 S1 的收敛半边）：分叉说明远端在本轮回写提交之后又前进，推送已被拒。
        // 重置到远端丢弃的只是本副作用自己未推送成功的提交——写入在本轮重试中重放
        // （CAS 期望值与重置后的清单状态一致），随后重新提交并推送。
        await git(['reset', '--hard', '--quiet', `origin/${branch}`])
      }
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
  } finally {
    await auth.cleanup()
  }
}

/** 推送输入：定位材料与同步一致；`branch` 为空时推送工作副本当前检出的分支。 */
export interface CodePushInput {
  commands: Commands
  stateDir: string
  codeSource: string
  branch?: string
  directory: string
  signal: AbortSignal
  auth?: GitAuth
}

/**
 * 把工作副本分支推送到远端（评审 S1 的收口半边）：回写提交不再只留在镜像本地，
 * 「清单在仓库里共享」的产品承诺成立。远端在同步与推送之间前进会让 push 被拒——
 * 错误上抛给回写副作用的退避重试；下一次同步按 `resetOnDivergence` 重置并重放写入后
 * 再次推送，最终收敛。
 */
export async function pushCode(input: CodePushInput): Promise<void> {
  const { signal } = input
  const scoped = input.commands.scope(input.codeSource)
  const source = scoped.source
  if (source?.kind !== 'github' && source?.kind !== 'gitlab') throw new Error('代码仓库记录必须是 GitHub 或 GitLab')
  const auth = input.auth ? await gitAuthArgs(input.auth) : { args: [] as string[], cleanup: async () => {} }
  const ssh = auth.args.length ? auth.args : source.auth === 'ssh' ? ['-c', `core.sshCommand=${sshCommandOf(source.sshKey)}`] : []
  const git = (args: string[]): Promise<string> => scoped.git(ssh.length ? [...ssh, ...args] : args, input.directory)
  try {
    // 分支优先取调用方指定；否则用镜像当前检出的分支（回写路径刚同步/提交过，指向正确），
    // 不做网络探测——推送必须与镜像状态一致，而不是远端的默认分支。
    const branch = input.branch?.trim() || (await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim()
    if (!branch || branch === 'HEAD') throw new Error('无法确定要推送的分支：工作副本不在命名分支上')
    await git(['push', '--quiet', 'origin', branch])
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(redactCredentials(errorText(error)))
  } finally {
    await auth.cleanup()
  }
}

/** 列出并强制拆除镜像登记的全部附属 worktree（主工作树除外）；单个失败不阻塞重建。 */
async function detachWorktrees(git: (args: string[]) => Promise<string>, main: string): Promise<void> {
  const list = await git(['worktree', 'list', '--porcelain']).catch(() => '')
  const directories = list.split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
    .filter(directory => !samePath(directory, main))
  for (const directory of directories) await git(['worktree', 'remove', '--force', directory]).catch(() => { /* 目录已消失或不属本镜像。 */ })
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

/**
 * 判断目录自身就是仓库根。
 * 用 `--show-toplevel` 而不是 `--git-dir`：后者会向上找到父仓库，把嵌在别的仓库里的工作副本目录
 * 误认为已初始化，进而改写父仓库的远端与分支。
 */
async function isRepository(git: (args: string[]) => Promise<string>, directory: string): Promise<boolean> {
  const top = await git(['rev-parse', '--show-toplevel']).then(value => value.trim(), () => '')
  return top !== '' && samePath(top, directory)
}

/** 比较两个路径是否指向同一目录；Windows 大小写不敏感且允许混用分隔符。 */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => resolve(value).replace(/\\/g, '/')
  const a = normalize(left)
  const b = normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
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
