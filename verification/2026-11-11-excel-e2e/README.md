# Excel 任务来源端到端验证（2026-11-11）

## 范围

用真实的 SQLite 状态库、真实 `ProjectScheduler`、真实 Excel 驱动、真实 git 同步与真实持久化副作用队列，
把「CSV 任务清单 → 队列 → 派工 → 状态回写 → 失败重试 → 幂等重扫」整条链路跑通。

**不覆盖**：真实 DSH 会话执行。本轮的「执行器」只记录工单创建与结束事件，用来驱动调度与回写；
桌面版直连的真实验证在后续步骤单独进行，飞书知识库在此之前保持「未验证」。

## 运行

```powershell
node --experimental-transform-types verification/2026-11-11-excel-e2e/run-e2e.ts
```

- 临时仓库、工作副本与状态库放在系统临时目录 `%TEMP%\dsh-excel-e2e`，不进入仓库。
- 证据写入同目录的 `result.json`；脚本断言失败时会写入 `error` 字段并以非零码退出。

## 场景

初始清单（UTF-8 BOM + CRLF）：

| task_id | title | status | description |
| --- | --- | --- | --- |
| A | 发布准备 | todo | |
| B | 回归测试 | todo | |
| C | 文档更新 | todo | 1. 改 012 / 2. 改 013 |

项目设置：全局 `maxWorkers = 1`、单项目串行、轮询 30 分钟、`maxRetries = 1`、退避 5 秒、
`pendingStatuses = [todo]`、完成 `done`、失败 `blocked`。

## 实际现象（result.json 逐阶段）

1. **启动轮询**：由 `start()` 的真实周期回调触发，首次同步真实克隆本地 git 远端，读到 3 个任务并拆出
   4 个工作项（C 拆成「改 012」「改 013」），随即派出 ticket-1（A）。
2. **执行中扫描**：`scan()` 与周期检查共用执行链；因 A 正在执行，本轮轮询被推迟，
   快照 `projects[].deferred.reason` = `A task from this project is running; polling and the git pull are deferred`，
   工作副本 HEAD 未变化、队列仍为 4 条 —— 没有并发拉取，也没有静默丢失。
3. **A 成功回写**：状态写为 `done`，文件仍保留 UTF-8 BOM 与 CRLF，工作副本产生提交
   `chore: record task A as done`。
4. **B 首次失败**：条目回到 `queued`、`attempt = 1`，`dueAt` 为 5 秒后，清单未被改写（未提前写失败态）。
5. **B 重试耗尽**：退避到期后创建新工单（ticket-3），再次失败后 `attempt = 2`、条目 `failed`，
   清单写为 `blocked`。
6. **C 首个子项成功**：整条任务写为 `done`；下一次轮询时任务 C 不再属于待处理状态，
   第二个子项按 `The task disappeared from its source` 取消。
7. **幂等重扫**：项目空闲时连续 `poll` 两次，队列条目的 `id / state / attempt` 完全不变。
8. **工作项变化**：新增任务 D 后入队一项；把 D 的描述改成两个编号项后再次轮询，
   旧条目 `cancelled`（`The work item changed or disappeared; its newer version is queued`），
   两个新条目 `queued`。

## 本轮暴露并修复的缺陷

首次运行时把临时状态目录放在本仓库的 `.artifacts/` 下，`syncCode` 用 `git rev-parse --git-dir`
判断工作副本是否已初始化；该命令会向上找到**父仓库**，于是工作副本目录被误认为已初始化，
脚本改写了本仓库的 `origin` 并尝试合并不相关的历史（合并被拒绝，工作区未受影响）。

修复：改为 `git rev-parse --show-toplevel` 并要求结果等于工作副本目录本身（`src/code-repos/sync.ts`），
新增 `tests/code-repos.spec.ts` 用例「嵌套目录应初始化而不是沿用外层仓库」。
验证脚本的临时目录也已移到系统临时目录。

被改写的 `origin` 已恢复为 `https://github.com/martinxiao2025/dsh-superagent.git`，
远端跟踪引用 `origin/main` 已恢复到 `e81f79e`。

## 未覆盖与已知限制

- 执行器是内存桩，没有真实模型会话；真实执行留给桌面版直连验证。
- 回写只在工作副本里提交，当前实现不推送；脚本为了继续制造远端变更，手动把该提交推到本地裸远端，
  真实部署缺少这一步（需要用户凭据与推送策略）。
- 回写粒度是「整条任务」：同任务一个子项成功后整条任务写为完成，其余排队子项随后按任务消失取消。
  这是现有语义，本轮如实记录，未改动。
- 飞书知识库任务来源仍未验证（缺飞书凭据）。
