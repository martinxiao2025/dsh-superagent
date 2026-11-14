/**
 * 代码仓库的统一端口：路径推导、同步入口与文件读取的单一出口。
 * `sync.ts`（同步算法）、`work.ts`（工作副本生命周期）与 `read.ts`（API 读取）的调用方
 * 都经由这里取入口，路径规则（`<stateDir>/repos/<repo>`）只在 `work.ts` 定义一次；
 * 跨文件不再各自拼接路径或直接 import 同步实现。
 */
export { repoDirectory, syncRepoWorkCopy, commitWorkCopy, type RepoSyncInput } from './work.ts'
export { readRepositoryPath } from './read.ts'
export { probeRemote, remoteOf, sshKeyFile, sshCommandOf, hasEmbeddedCredentials, redactCredentials, type RemoteRefs, type GitAuth,
  type CodeSyncResult } from './sync.ts'
