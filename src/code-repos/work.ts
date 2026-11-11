/** 代码仓库工作副本：按记录 ID 固定目录，任务来源读取清单前先同步。 */
import { join, relative, sep } from 'node:path'
import type { Commands } from '../infra/commands.ts'
import { syncCode, type CodeSyncResult } from './sync.ts'

/** 代码仓库工作副本目录；同一记录多次同步复用同一个目录。 */
export const repoDirectory = (stateDir: string, repo: string): string => join(stateDir, 'repos', repo)

export interface RepoSyncInput {
  /** 已绑定到代码仓库记录的命令入口。 */
  commands: Commands
  stateDir: string
  repo: string
  signal: AbortSignal
  /** 留空时使用仓库默认分支。 */
  branch?: string
}

/** 首次 clone、之后快进同步；失败时抛出带可读原因的错误。 */
export async function syncRepoWorkCopy(input: RepoSyncInput): Promise<CodeSyncResult> {
  return syncCode({
    commands: input.commands,
    stateDir: input.stateDir,
    codeSource: input.repo,
    branch: input.branch ?? '',
    directory: repoDirectory(input.stateDir, input.repo),
    signal: input.signal,
  })
}

/**
 * 在工作副本里提交单个文件的改动，使其不再以「未提交修改」的形式存在。
 * 下一轮同步的 `merge --ff-only` 只会在远端另有提交时失败，而不是因为本地脏文件被拒绝。
 * 只提交本地工作副本，不推送远端；推送是后续能力（见 `TaskSourceDriver.push`）。
 * 不在 git 仓库中或没有改动时静默返回 `false`。
 * @throws 当 git 无法完成提交时；调用方（持久化副作用）会退避重试。
 */
export async function commitWorkCopy(
  git: (args: string[], cwd: string) => Promise<string>,
  directory: string,
  file: string,
  message: string,
): Promise<boolean> {
  const path = relative(directory, file).split(sep).join('/')
  if (!path || path.startsWith('../')) return false
  if ((await git(['rev-parse', '--is-inside-work-tree'], directory).catch(() => '')).trim() !== 'true') return false
  if (!(await git(['status', '--porcelain', '--', path], directory)).trim()) return false
  await git(['add', '--', path], directory)
  // 自动化提交使用固定身份并关闭签名，避免依赖用户本机的 git 配置。
  await git(['-c', 'user.name=dsh-superagent', '-c', 'user.email=dsh-superagent@localhost', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', message, '--', path], directory)
  return true
}
