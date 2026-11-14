/**
 * 给已绑定的 `Commands` 覆盖 git 类命令的超时。
 * 大仓库首次 clone 可能需要数分钟；全局 `gitTimeoutMs` 之外，项目可用 `execution.gitTimeoutSeconds` 放宽。
 * 其余方法（CLI、API）保持原样，仍走部署配置的超时。
 */
import type { Commands } from './commands.ts'

/** 返回一个 `Commands` 视图：git 调用固定使用 `timeoutMs`，其余委托给 `base`。 */
export function withGitTimeout(base: Commands, timeoutMs: number): Commands {
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    git: (args: string[], cwd: string): Promise<string> => base.git(args, cwd, timeoutMs),
  })
}
