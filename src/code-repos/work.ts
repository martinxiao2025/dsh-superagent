/** 代码仓库工作副本：按记录 ID 固定目录，任务来源读取清单前先同步。 */
import { join } from 'node:path'
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
