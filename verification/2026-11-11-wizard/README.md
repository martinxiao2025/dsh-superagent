# 向导添加项目全流程实测（2026-11-11）

本目录记录「向导式新建项目」在桌面版 DeepSeek Harness 里的**真实**端到端执行：
创建 Git 凭据 → 仓库连通性验证（携带凭据）→ 拉取远端分支 → 任务来源验证（真实读取清单）
→ 创建项目（选定 `feature/desktop-live` 分支）→ 真实调度、DSH 会话执行 → 回写到选定分支。
证据在 `result.json`（`ok: true`，`WIZARD_LIVE_OK`）。

仓库步在实测后按用户反馈做了二次收敛：项目表单只填**仓库全地址**（`config.remote`）并选择凭据，
`instanceUrl/repository/cli/sshKey` 等低级栏位从表单移除；站点与仓库路径由服务端从地址推导
（[repositoryOfRemote](../../src/code-repos/kind.ts)），认证方式随凭据的 `kind` 决定。
本验证的仓库配置即最简形态 `{ remote, auth: 'https' }`，不含 repository。

## 环境

与 [desktop-live](../2026-11-11-desktop-live/README.md) 相同：桌面版 0.2.2-rc.1，插件以目录联接挂到
`C:\Users\61054\.dsh\profiles\desktop\node_modules\dsh-superagent` → `D:\dsh-superagent`；
状态目录 `C:\Users\61054\.dsh\state\superagent`；管理接口只监听回环，请求带 `x-orchestrator-request: 1`。

本次额外用到：**离线重置**（`reset-state.ts`）。旧版设置把 `codeRepo`/`taskSource` 存成记录引用，
与「并入项目」后的内联结构不兼容，插件启动即失败且管理接口 503；在桌面版停止后调用插件自己的
`resetState`（备份到 `~/dsh-superagent-backup/<时间戳>`，再删除插件拥有的状态条目）恢复空基线。

## 流程与结果（`result.json` 的 `phases`）

1. 等待插件 ready；清理上一次验证的项目、凭据与工作副本（候选预检共用 `repo-candidate` 镜像，一并清掉）。
2. 初始化临时裸库，`main` 与 `feature/desktop-live` 两个分支各带一份 BOM + CRLF 的 `tasks/backlog.csv`，
   进程内只读静态服务以 git dumb 协议托管。
3. `POST git-credentials` + `POST git-credentials/verify`（带仓库远端）：材料与远端探测均通过。
4. `POST code-repos/verify`（field=`remote`，带 Git 凭据，配置只有全地址）：`codeRepoAccessible`，2 个分支。
5. `POST code-repos/branches`（本次新增接口）：返回 `['feature/desktop-live','main']`，默认分支 `main`。
6. `POST task-sources/verify`（field=`file`）：`taskFileStandardOk`，rows=1，schema_version=1。
7. `POST projects` 一次提交完整配置，执行分支选定 `feature/desktop-live`；响应 `restarting: true`，
   插件完成初始化重跑后管理接口恢复 ready。
8. 15 秒调度轮询完成同步、拆分与建单；**轮询工作副本检出到 `feature/desktop-live`**。
9. 桌面版真实 DSH 会话执行工单：队列 `succeeded`、工单 `outcome=completed`。
10. 执行工作区是 per-ticket worktree，`HEAD` 与远端 `feature/desktop-live` 指向同一提交（`refMatches: true`）。
11. 回写副作用把 `done` 写进选定分支上的清单，BOM 与 CRLF 保留。

关键证据（`result.json`）：`branches`、`workCopyBranch`、`ticket`（含 `directory`）、
`workspace`（`refMatches: true`）、`writeback`（`bom: true`、`crlf: true` 与全文）。

## 实测发现并修复的缺陷

1. **新建/删除项目不触发初始化重跑**：`persistRecord`/`removeRecord` 硬编码 `restarting: false`，
   部署里没有新项目的仓库来源，调度轮询报「代码仓库记录必须是 GitHub 或 GitLab」。
   修复：与 `save` 同一规则计算 `setupChanged` 并触发重跑（[settings.ts](../../src/app/settings.ts)）。
2. **远端更换后工作副本报 unrelated histories**：向导候选预检与项目共用工作副本镜像，
   换远端后 `merge --ff-only` 必然失败。修复：`syncCode` 检测 origin URL 变化时重建镜像
   （工作副本是纯镜像，执行发生在独立 worktree，[sync.ts](../../src/code-repos/sync.ts)）。
3. **轮询工作副本不跟随项目分支**：项目选定分支只作用于执行 worktree，清单轮询与回写仍落在默认分支。
   修复：`defaultSync` 把 `project.execution.branch` 传给 `syncRepoWorkCopy`
   （[scheduler.ts](../../src/app/scheduler.ts)）。

## 运行

```
node --experimental-transform-types verification/2026-11-11-wizard/reset-state.ts   # 仅在启动失败时需要
node --experimental-transform-types verification/2026-11-11-wizard/run-wizard.ts
```
前置：桌面版已加载 dsh-superagent 且 `stateDir/startup.json` 为 ready。
