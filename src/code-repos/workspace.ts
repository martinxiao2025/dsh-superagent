/**
 * 项目工单的执行工作区：把项目代码仓库的检出物 materialize 到工单目录。
 * 使用 git worktree（而非直接复用轮询用的工作副本），让 worker 在真实检出上工作，
 * 同时与 `stateDir/repos` 及任务来源轮询互不干扰。
 */
import { readdir, rmdir, stat } from 'node:fs/promises'
import { repoDirectory } from './work.ts'

/** 与 `Commands.git` 相同的调用形态，便于测试注入。 */
export type Git = (args: string[], cwd: string) => Promise<string>

export interface WorkspaceInput {
  git: Git
  stateDir: string
  /** 代码仓库记录 ID。 */
  repo: string
  /** 工单执行目录；已存在且为 git 工作区时直接复用。 */
  directory: string
  /** 期望检出的分支；仓库中不存在该分支时退回检出点 HEAD。 */
  branch?: string
  signal?: AbortSignal
}

/** 目标目录是否存在且非空；非空目录不覆盖，避免删掉 worker 留下的改动。 */
async function nonEmpty(directory: string): Promise<boolean> {
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) return true
    const entries = await import('node:fs/promises').then(fs => fs.readdir(directory))
    return entries.length > 0
  } catch {
    return false
  }
}

/**
 * 在 `directory` 处准备项目仓库的检出物。
 * - 已经是 git 工作区（同一工单重试）时复用；
 * - 否则从轮询工作副本 `stateDir/repos/<repo>` 创建独立 worktree；
 * - 目标目录非空且不是工作区时拒绝覆盖。
 * @returns `'reused'` 或 `'created'`，供调用方在准备失败时清理新建的 worktree。
 * @throws 仓库尚未同步或目标目录被占用时。
 */
export async function materializeWorkspace(input: WorkspaceInput): Promise<'reused' | 'created'> {
  const { git, directory, repo } = input
  input.signal?.throwIfAborted()
  const inside = (await git(['rev-parse', '--is-inside-work-tree'], directory).catch(() => '')).trim()
  if (inside === 'true') return 'reused'
  const checkout = repoDirectory(input.stateDir, repo)
  if ((await git(['rev-parse', '--is-inside-work-tree'], checkout).catch(() => '')).trim() !== 'true') {
    throw new Error(`项目仓库尚未同步到工作副本：${checkout}`)
  }
  if (await nonEmpty(directory)) throw new Error(`执行目录已存在且不是 git 工作区，拒绝覆盖：${directory}`)
  // 上次可能留下了已删除目录的 worktree 元数据，先清理再创建。
  await git(['worktree', 'prune'], checkout)
  const branch = input.branch?.trim()
  const ref = branch && (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], checkout).catch(() => '')).trim()
    ? branch : 'HEAD'
  await git(['worktree', 'add', '--detach', directory, ref], checkout)
  return 'created'
}

/** 删除本次创建的工作区；失败时退回删除空目录，均不掩盖原始错误。 */
export async function removeWorkspace(git: Git, stateDir: string, repo: string, directory: string): Promise<void> {
  const checkout = repoDirectory(stateDir, repo)
  await git(['worktree', 'remove', '--force', directory], checkout).catch(() => rmdir(directory).catch(() => {}))
}
