/** 测试启动的 git 进程所使用的环境。 */
import { GIT_LOCATION } from '../../src/infra/environment.ts'

/**
 * 带有 `extra` 的进程环境，并去掉告诉 git 应作用于哪个仓库的变量（`GIT_LOCATION`）：
 * 在 `git rebase --exec` 中运行的测试会继承 GIT_DIR，若在其中执行 `git init`，会重新初始化被测仓库。
 */
export const gitEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> =>
  ({ ...process.env, ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])), ...extra })
