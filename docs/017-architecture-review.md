# 017 架构与方案评审（独立评审产出）

> 评审对象：`dsh-superagent`（DeepSeek Harness 插件）当前工作区代码
> 权威方案：[013 项目权威设计与实施基线](013-authoritative-project-design.md)
> 配套：014（裁剪清单）、015（生产就绪差距）、016（任务格式规范）；011、012 已废弃
> 评审方式：只读。静态阅读 + 依赖图脚本核验 + 与 013/014/015/016 逐条比对；未运行 `pnpm test`/`build`，未修改任何源码
> 评审日期：2026-11-11

## 0. 结论摘要

当前实现处于「领域与存储、任务来源与仓库同步、队列与调度」已落地，「凭据、项目内联、重置、知识库多文档」未落地的中间态。整体方向与 013 一致，`core` 的端口划分基本干净；但队列与回写这条主链路上存在 4 个会造成**数据不一致或功能失效**的缺陷，其中「重试不会真正重跑」与「回写污染仓库工作副本」属于上线阻塞级。

| 级别 | 数量 | 主题 |
| --- | --- | --- |
| P0 | 4 | 重试失效、回写污染工作副本、回写无持久化重试/幂等、执行目录未物化项目仓库 |
| P1 | 10 | 实体无运行时校验与迁移矛盾、队列唯一性与保留、工作项级 reconcile、停用/删除闭环、轮询并发、`runOnStart` 失效、016 未落地、飞书模型差距、分层泄漏、凭据越权面 |
| P2 | 4 | 硬编码与配置、可观测性、测试策略、发布与文档一致性 |
| 过度设计 | 4 | 凭据两套全量复制、016 的元数据与自研 xlsx、`spaceId` 全库唯一、队列终态永久保留 |
| 遗漏能力 | 4 | 队列操作面、告警、日常备份、速率限制 |

**一句话判断**：队列的状态机设计是对的，但「工单」与「队列」之间的幂等、回写与工作区三条边界没有闭合；013 需要在这些边界上补齐契约，否则后续面板与飞书多文档会在错误的地基上继续叠加。

## 1. 复核基线与方法说明

- 依赖图：用脚本对 `src/**/*.ts(x)` 做静态 import 解析（跳过 `import type` 与 `node:`/外部包），按强连通分量（SCC）统计。
- 实测结果：**2 组 SCC、26 条环内边**，而不是 014 所述的「13 条」。差异原因见 P2-4；014 未说明计数算法，无法复核，建议改为 CI 工具口径。
- `src/core/` **没有任何跨层 import**（对 `app/infra/sources/executor` 的运行时依赖为 0），因此 014 中「core↔app 循环」这一条已不成立。
- 两处真实环：`deployment.ts ↔ infra/*`（3 节点 5 边）与 `executor/dsh.ts ↔ app/{assessment,notices,links,cards,resources,views/records}`（10 节点 21 边）。
- 跨层边统计：`app → core` 22、`app → sources` 12、`app → infra` 11、`app → executor` 8、根文件 → infra 4。

## 2. P0：上线阻塞

### P0-1 失败重试不会真正重新执行任务

- **问题**：`retry` 把条目改回 `queued` 并清空 `ticketId`，下一次 `dispatch` 用**同一个** `triggerId` 再次调用 `engine.schedule`；而 `schedule` 对同一 trigger 只返回已存在的工单（`created: false`），不会新建assignment。于是重试只是把队列指向那张**已结束**的工单，`settle` 立刻再次判定失败，直到 `maxRetries` 耗尽标记「最终失败」。真实项目里表现为「重试 2 次，但只执行过 1 次」。
- **证据**：
  - [scheduler.ts:253](../src/app/scheduler.ts#L253) `triggerId` 仅由 `project + entry.id` 决定，不含 attempt
  - [scheduler.ts:264](../src/app/scheduler.ts#L264) 重试路径复用同一 trigger
  - [engine.ts:72-77](../src/core/engine.ts#L72-L77) 已存在即 `created: false`
  - [scheduler.ts:281-289](../src/app/scheduler.ts#L281-L289) 重试只改队列状态
  - [queue.spec.ts:61-66](../tests/queue.spec.ts#L61-L66) 测试用的 fake engine 每次都新建工单，恰好掩盖了该缺陷
- **影响**：所有「自动重试」承诺失效；超时、限流、偶发网络失败会直接把任务推进「最终失败」，且外部清单被回写为失败，必须人工改表。
- **建议**：`triggerId` 纳入 attempt（`key('trigger','schedule',entry.id,attempt)`），或改为「每次派工生成新 trigger + 队列记录 `ticketId` 历史」；`settle` 只对**本次**工单结算。同时把 `person` 阶段从「失败重试」改为「超时后重试」（见下一小节）；把队列测试换成真实 `Engine` + 内存 `Store`，断言第二次尝试产生了新的 assignment。
- **工作量**：2–3 人日（含回归用例）。

### P0-2 回写直接改仓库工作副本，破坏后续同步

- **问题**：Excel 回写读取 `<stateDir>/repos/<repo>` 的清单文件并原子替换为**规范化后的 UTF-8、LF 换行、无 BOM** 内容；既不提交也不还原。下一次轮询对同一目录执行 `fetch` + `merge --ff-only`，当远端有新提交触及该文件（或任何被本地修改的文件）时，git 拒绝合并，`poll` 抛错 → 该项目此后每轮都失败。即使远端没变，工作副本也会长期带着未提交修改，逐步积累成「脏树」。
- **证据**：
  - [writeback.ts:37](../src/task-sources/writeback.ts#L37) 读入即 `.replace(/^\uFEFF/,'')`
  - [writeback.ts:50](../src/task-sources/writeback.ts#L50) 以 `utf8` 重写
  - [writeback.ts:67](../src/task-sources/writeback.ts#L67) 统一 `\n` 与尾部换行
  - [sync.ts:112](../src/code-repos/sync.ts#L112) `merge --ff-only`
  - [work.ts:7](../src/code-repos/work.ts#L7) 仓库目录按记录固定，回写与读取共用同一份工作副本
- **影响**：任务状态回写成功后，项目轮询随时可能永久失败；CSV 会被整文件重写（换行/BOM 变化），产生无意义 diff，人工 review 无法分辨真实状态变更；`.xlsx` 走自研 ZIP/XML 重写，风险更高。
- **建议**：把「任务清单工作副本」与「项目代码工作副本」拆开：回写用独立目录（`<stateDir>/task-cache/<repo>`）或临时 worktree；回写后显式 `git add` + `commit`（可选 `push`），或立即 `git checkout -- <file>` 还原并在下次读取时重新拉取。写入必须保持原字节风格（探测并保留 BOM 与 CRLF）；`.xlsx` 若无法保证样式保真，先降级为只读并明确报错。
- **工作量**：3–5 人日。

### P0-3 回写是「发起即忘」，且先改队列再写外部

- **问题**：`succeed`/`retry` 先调用 `writeBack`（`void ... .catch`），紧接着 `finish` 把队列置为 `succeeded`/`failed`。写回失败只写入内存 `errors`，不重试、不持久化、重启即丢；写回成功也没有任何「已应用」标记与幂等键。由于 `enqueueable` 对 `succeeded` 永久返回 false，写回失败后该任务**永远不会再被处理**，而外部清单仍是「待处理」。
- **证据**：
  - [scheduler.ts:275-278](../src/app/scheduler.ts#L275-L278) 先回写后置成功
  - [scheduler.ts:306-321](../src/app/scheduler.ts#L306-L321) `void` + `catch` 仅记录
  - [scheduler.ts:311](../src/app/scheduler.ts#L311) 来源被停用则静默跳过回写
  - [scheduler.ts:235-239](../src/app/scheduler.ts#L235-L239) 成功态不再入队
- **影响**：「队列成功、清单未变」的静默分叉；重放会覆盖人工修改（无 CAS）；无法回答「这条任务到底写回了没有」。
- **建议**：复用现成的持久化副作用队列 `Effects`（[effects.ts](../src/app/effects.ts)，已具备指数退避、`key` 去重、`generation` 与健康度），新增 `kind='writeback'`：`key = entry.id + statusRevision`，payload 带 `taskId/taskTitle/期望旧状态/新状态`；写入前做 CAS（读到期望旧值才写），写入后记录 `appliedAt/attempts/lastError` 并计入快照。队列状态改为 `succeeded`（执行成功）与 `writeback: pending|applied|failed` 两个正交维度。
- **工作量**：3–4 人日（含面板字段与测试）。

### P0-4 执行目录没有物化项目仓库

- **问题**：工单执行目录是 `<executionRoot>/<project>/<ticket>`（空目录），与任务清单使用的 `<stateDir>/repos/<repo>` 完全是两棵树。唯一的补齐手段是**全局** `executor.prepare` 命令，它不属于项目、也被所有项目共享。
- **证据**：
  - [dsh.ts:117](../src/executor/dsh.ts#L117) 目录由 `executionRoot + folder + ticketId` 组成
  - [dsh.ts:277-290](../src/executor/dsh.ts#L277-L290) 仅 `mkdir` 与执行 prepare
  - [policy.ts:95-100](../src/policy.ts#L95-L100) `maxWorkers`/`directory`/`prepare` 是全局设置
  - [013 §4.1](../docs/013-authoritative-project-design.md#L120-L126) 只写「执行目录按项目组织」，未要求 checkout
- **影响**：任务在**不含项目代码**的目录里执行，所谓「改代码 + 提 PR」无法成立；多个项目共享同一 prepare 脚本会互相污染（同一份缓存、同一套凭据注入）；013 的「一项目一仓库」承诺在运行时不成立。
- **建议**：把「工作区」定义为项目仓库的 per-ticket worktree：`git worktree add <work>/<project>/<ticket> origin/<branch>`，队列条目记录 `repo/branch/baseCommit`；prepare 改为**项目级**（在 worktree 内装依赖），全局 prepare 仅作为兜底。派工前校验 worktree 的 remote 与 project.repository 一致，不一致直接拒绝并给出明确错误码。
- **工作量**：5–8 人日（worktree 生命周期、清理、Windows 路径、并发 git 锁）。

## 3. P1：影响可靠性，需在首个生产周期内解决

### P1-1 实体读取无校验，且迁移链与 013 的「不做迁移」冲突

- **问题**：`ticket`/`thread`/`queue`/`trigger`/`decision` 一律 `JSON.parse(...) as T`，只有 `settings` 经过 Zod；`QueueEntrySchema` 定义了却从未用于读取。同时 `Store` 仍保留 schema 10→11→12→13 的迁移链，与 013 §9.2「新库直接落最终结构、不做迁移」相悖，且「重置」入口并不存在。
- **证据**：[store.ts:133](../src/app/store.ts#L133)、[store.ts:242](../src/app/store.ts#L242)、[store.ts:258](../src/app/store.ts#L258)、[store.ts:174](../src/app/store.ts#L174)；[model.ts:9](../src/queue/model.ts#L9) 未使用；[store.ts:96-98](../src/app/store.ts#L96-L98) 迁移链；[013 §9.2](../docs/013-authoritative-project-design.md#L422-L428)。
- **影响**：任何一次字段改名/类型收紧都会在运行期变成 `undefined` 或静默错判（例如 `dueAt` 变字符串后比较结果错误）；旧库升级路径与目标 schema 双轨，测试与文档都要维护两套事实。
- **建议**：读取时用对应 schema `parse`，失败的行进入 `quarantine`（带原始 JSON 与错误），并让健康度面板可见；短期先给 queue/ticket 加校验（成本最低、风险最高），再决定是否删除迁移链并落地 `reset`。
- **工作量**：2 人日（校验）+ 2 人日（reset 与删迁移）。

### P1-2 队列唯一性只在应用层，终态无保留上限

- **问题**：`queue` 表只有 `id` 主键与 `seq` 索引；`(project, task, item)` 去重完全依赖 `reconcile` 在事务内计算。`appearance` 用「历史条目数」做后缀，`cancelled/failed` 条目永久保留，因此条目数单调增长，`seq` 与 `appearance` 都随之膨胀。
- **证据**：[store.ts:88-93](../src/app/store.ts#L88-L93)；[scheduler.ts:218-229](../src/app/scheduler.ts#L218-L229)；[scheduler.ts:327-329](../src/app/scheduler.ts#L327-L329)；[013 §2.2](../docs/013-authoritative-project-design.md#L44) 明确「终态保留」。
- **影响**：并发触发（手动 scan + 定时 tick）或崩溃恢复时可能产生同任务双条目；队伍越用越大，快照与面板渲染随之变慢；「第 N 次出现」的语义难以向用户解释。
- **建议**：把 entry 的关键字段列化（`project/task/item/state/attempt/seq/due_at/ended_at`）并加部分唯一索引 `UNIQUE(project, task, item) WHERE state IN ('queued','starting','running')`；终态设置保留窗口（如 30 天）与归档表；`appearance` 只在「消失后重现」时递增，并在同一次事务内持久化「已见过的最大出现代次」。
- **工作量**：2 人日。

### P1-3 reconcile 只按「任务」判断消失，工作项级增删改会执行陈旧内容

- **问题**：`present` 以 `task.id` 为键，条目是否取消只看 `present.has(entry.task)`。因此：任务描述里的复选框从 3 条改成 2 条，第 3 条仍在队列里并会被派工；两条互换顺序时 `item index` 复用旧条目的 `title/text`，新的第 0 条永远不会入队；描述的文本修改不会触发重跑（没有内容哈希）。
- **证据**：[scheduler.ts:201-215](../src/app/scheduler.ts#L201-L215) 只按 task 判断；[scheduler.ts:216-231](../src/app/scheduler.ts#L216-L231) 以 index 作为条目身份；[scheduler.ts:235-239](../src/app/scheduler.ts#L235-L239) 已有条目直接跳过。
- **影响**：用户改了任务描述，系统仍执行旧内容；删掉的工作项照跑，产生「幽灵任务」；回写时按旧标题匹配，可能写错行。
- **建议**：`splitTask` 为每个工作项生成稳定键（`itemKey = hash(title/anchor)` 或清单项文本），队列条目存 `itemKey + contentHash`；reconcile 以 `taskKey + itemKey` 匹配，缺失即取消，`contentHash` 变化时生成新一代条目（或把旧条目降级为 `superseded`）。同时把「按 index 定位」从回写匹配中移除。
- **工作量**：3 人日。

### P1-4 停用与删除没有闭环，错误与下一次轮询不可见

- **问题**：`poll`/`dispatch` 会因 `enabled` 拒绝，但停用后排队条目永久停留且无任何操作入口；`DELETE projects/:id` 不停止运行中的工单，也不清理队列条目，删除后条目变成没有归属的孤儿（`dispatch` 永远返回 false）。`scheduler.errors` 与 `nextPollAt` 不进入任何接口。
- **证据**：[scheduler.ts:83](../src/app/scheduler.ts#L83)、[scheduler.ts:250](../src/app/scheduler.ts#L250)；[settings.ts](../src/app/settings.ts) `removeProject`；[http.ts:253](../src/app/http.ts#L253)、[http.ts:263](../src/app/http.ts#L263) 仅有查询与删除项目；[scheduler.ts:42](../src/app/scheduler.ts#L42) 错误只在内存。
- **影响**：用户以为「停用=暂停」，实际队列越积越多且无法清空；删项目后残留条目可能让后续排查完全失去线索；「为什么没跑」只能翻日志。
- **建议**：按 013 §4.3 定案落地：停用保留 `queued` + 详情页显示「排队 N / 运行 M」+ 独立动作「停止当前任务」「清空排队」；删除项目流程改为「停止运行工单 → 取消/归档队列条目 → 删除记录」同一事务；`GET queue` 与 `GET projects/:id/tasks` 增加 `lastError/nextPollAt/lastWriteback`；补 `POST queue/:id/retry|cancel`。
- **工作量**：2–3 人日。

### P1-5 轮询在 tick 内串行 await，超时与互斥不完整

- **问题**：一个 tick 里对每个到期项目 `await this.poll(id)`，`poll` 内部包含网络 `fetch`/`clone` 与文件读取，任何项目慢都会阻塞后续项目与 `pump`；命令层统一 90 秒硬超时，大仓库首次 clone 会直接判失败；手动 `scan()` 没有 `running` 互斥，与定时 tick 并发时会对同一工作目录重复 `git fetch`/`merge`。
- **证据**：[scheduler.ts:146-167](../src/app/scheduler.ts#L146-L167)；[scheduler.ts:71-77](../src/app/scheduler.ts#L71-L77)（无互斥）；[commands.ts:10](../src/infra/commands.ts#L10)（90s 全局）；[sync.ts:101](../src/code-repos/sync.ts#L101)。
- **影响**：项目多、仓库大时轮询抖动明显（「15 秒一次」实际不可控）；`index.lock` 冲突；一次 clone 失败会让整轮调度跳过其他项目。
- **建议**：把「项目轮询」也做成 `Effects` 任务（`kind='poll'`, `key=project`, 单项目串行、全局有限并发），tick 只负责「到期投递」；git 类命令单独给更长超时（可按仓库配置）；`scan` 与 tick 共用同一把 per-project 互斥锁；到期时间加入抖动（±10%），避免所有项目同时打远端。
- **工作量**：3 人日。

### P1-6 `runOnStart` 实际不生效

- **问题**：启动判定写成 `startup ? (!runOnStart && due === undefined) : ...`。`start()` 只为 `runOnStart=false` 的项目设置 `nextPoll`，因此该分支恒为 `false`，启动 tick 仍会立即轮询。用户关闭「启动即跑」没有效果。
- **证据**：[scheduler.ts:59](../src/app/scheduler.ts#L59) 初始化 `nextPoll`；[scheduler.ts:156](../src/app/scheduler.ts#L156) 判定条件。
- **影响**：重启后立刻向所有仓库/飞书发起请求，可能触发限流；该配置项成为摆设。
- **建议**：改为 `startup ? !project.schedule.runOnStart : (due !== undefined && due > now)`，并补一条「runOnStart=false 启动不轮询、到点后轮询」的用例。
- **工作量**：0.5 人日。

### P1-7 016 标准格式未落地，且与现有默认策略冲突

- **问题**：016 要求 `tasks` 工作表、`_meta.schema_version`、固定状态枚举、非法行整批拒绝、模板下载；实现则是自动探测表头 + 4 个默认待处理状态（`待处理/todo/pending/open`）+ 状态自由文本，且只读第一个工作表。任务稳定键也缺 `repositoryPath`。
- **证据**：[tasks.ts](../src/task-sources/tasks.ts) 的导入与列匹配；[excel.ts](../src/task-sources/excel.ts) 的首表读取；[table.ts](../src/task-sources/table.ts) 的 CSV/TSV/XLSX 解析；[projects/kind.ts:30-33](../src/projects/kind.ts#L30-L33)；[013 §6.4](../docs/013-authoritative-project-design.md#L260-L263)。
- **影响**：016 不能作为可执行契约；同一个仓库在不同人的表结构下行为不同；状态拼写差异（「Done」vs「已完成」）导致任务不被领取或永远不被回写。
- **建议**：先实现 016 的**最小闭环**（`tasks` 表 + 3 个必填列 + 固定枚举 + 行级错误码 + 模板），把自定义映射降级为高级开关；在项目上增加 `statusMap`（标准枚举 ↔ 本地文本）；任务键按 016 补齐 `repositoryPath`。若决定不实现 `_meta`，必须同步修改 016，而不是让文档悬空。
- **工作量**：4–6 人日。

### P1-8 飞书知识库仍是「单节点 docx」，且唯一性表述自相矛盾

- **问题**：现有驱动只接受一个 `url`，解析到单个 `docx` 节点；013 §6.3 的「spaceId + roots[]、文件夹递归、shortcut 解引用、bitable、失效文档隔离、跨文档去重」均未实现。同时 013 §9.1 要求 `spaceId` 全库唯一，而 §10.11 推荐「空间唯一归属 + 根节点集合」，两处结论不一致。
- **证据**：[feishu-wiki.ts](../src/task-sources/feishu-wiki.ts) 的 `url` 字段与单节点解析；[feishu-doc.ts:46-70](../src/task-sources/feishu-doc.ts#L46-L70) 要求 `obj_type === 'docx'`；[013 §6.3](../docs/013-authoritative-project-design.md#L227-L242)；[013 §9.1 L419](../docs/013-authoritative-project-design.md#L419)；[013 §10.11 L485](../docs/013-authoritative-project-design.md#L485)。
- **影响**：目标能力缺口最大的部分；若先按单 URL 做 UI，后续多文档改造会连带改绑定模型、校验、错误码与回写。
- **建议**：先定案并统一为一套模型（建议根集合唯一 + 重叠检测，`spaceId` 只做归属提示），再实现遍历器；`list` 返回 `{tasks, skipped, warnings, invalidDocs}`，单文档失败只跳过该文档并计数，不整批失败；任务键含 `nodeToken`。
- **工作量**：8–12 人日。

### P1-9 分层泄漏与循环依赖

- **问题**：`core` 干净，但 `app` 直接依赖 12 个 `sources`、11 个 `infra`、8 个 `executor` 具体模块；`scheduler` 既注入了 `SchedulerHost`，又直接 import 具体 `syncRepoWorkCopy` 与 `taskSources` 单例；根文件 `policy.ts` 同时承担「领域聚合 schema」与「适配器记录 schema」的组装，并依赖 `infra` 工具，导致 `deployment.ts` 与 `infra/*` 形成环。
- **证据**：[scheduler.ts:8-12](../src/app/scheduler.ts#L8-L12)；[policy.ts:8-15](../src/policy.ts#L8-L15)；[views/settings.ts:44-66](../src/app/views/settings.ts#L44-L66) 直接消费三类记录 schema；依赖图实测 2 组 SCC。
- **影响**：替换适配器要改调度器；单测必须构造大量真实对象；初始化顺序脆弱（环内任意一方在模块顶层求值就可能拿到 `undefined`）。
- **建议**：分两步：①把 `Commands`/`Machine` 等宿主类型下沉到 `core/ports`，`deployment` 只做装配，断开 `deployment ↔ infra`；②把 `notices/links/cards` 中的纯格式化函数抽到无依赖的 `format/`，让 `executor` 不再反向依赖 `app`；③`scheduler` 改为必传 `repoSync` 与 `registry`，删除默认单例；④CI 增加 `dependency-cruiser` 规则（禁止 `core → *`、禁止 `executor → app`）。
- **工作量**：5–7 人日。

### P1-10 凭据注入方式在「两套独立凭据」落地前就存在越权面

- **问题**：HTTPS 走 `recordTicketSource(stateDir, directory, codeSource)`，把凭据助手**按目录**注册，该目录下任何进程（含 worker 会话里的任意 shell、prepare 脚本）执行 `git` 都能拿到仓库凭据；SSH 则把私钥路径通过 `-i` 注入。两者都与「凭据只对本次调度生效」的最小权限原则不符。当前也没有 `src/secrets/`，Windows 上 `chmod 0600` 无效。
- **证据**：[sync.ts:90](../src/code-repos/sync.ts#L90)；[commands.ts:97](../src/infra/commands.ts#L97) 按记录 `scope`；[store.ts:68](../src/app/store.ts#L68) `chmodSync(0o600)`；[013 §5.2](../docs/013-authoritative-project-design.md#L172-L180)。
- **影响**：一个项目的工作区被攻破即等于该仓库凭据泄漏；未来落地面板粘贴私钥后风险进一步放大（`settingsView` 目前原样下发 `config`，见 [views/settings.ts:55](../src/app/views/settings.ts#L55)）。
- **建议**：凭据只在**调度器执行的 git 命令**上生效：HTTPS 用 `-c http.extraHeader=Authorization: Basic ...`（仅该进程、不落 `.git/config`）或临时 `GIT_ASKPASS`+环境变量；SSH 优先走 `ssh-agent`（`SSH_AUTH_SOCK`），必须落盘时写到仅当前用户可读的临时目录并用 `icacls` 收紧 ACL（Windows 的 `chmod` 不可依赖）；worker 会话默认**不**注入 git 凭据，需要提 PR 时显式开启。加密存储建议 Windows 用 DPAPI（当前用户作用域）+ 文件 ACL，避免明文密钥库。
- **工作量**：3–4 人日（不含 `src/secrets/` 全量实现）。

## 4. P2：工程质量

### P2-1 硬编码与配置粒度

- **问题**：命令超时统一 90 秒（clone/fetch/`lark` 共用）；tick 固定 15 秒；默认 CLI 写死 `gh`/`glab`；`prepare` 是全局而非项目级；`pendingStatuses` 默认四种同义词。
- **证据**：[commands.ts:10](../src/infra/commands.ts#L10)；[scheduler.ts:36](../src/app/scheduler.ts#L36)；[deployment.ts](../src/deployment.ts)；[policy.ts:95-100](../src/policy.ts#L95-L100)；[projects/kind.ts:30](../src/projects/kind.ts#L30)。
- **影响**：大仓库首次同步必然超时；不同项目无法差异化配置；同义词默认值与 016 的固定枚举互相打架。
- **建议**：把超时按命令类别拆（`gitFetch/gitClone/lark/cli`）并允许项目覆盖；tick 间隔与抖动进配置；CLI 名称从类型描述里读；`prepare` 移到 `Project.execution`。
- **工作量**：1–2 人日。

### P2-2 可观测性

- **问题**：无结构化事件、无请求 ID、无耗时指标；`snapshot.used` 取执行器槽位，与队列 `running` 数可能不一致；`errors`、`nextPollAt`、写回结果都不进快照。
- **证据**：[scheduler.ts:132-144](../src/app/scheduler.ts#L132-L144)；[scheduler.ts:42](../src/app/scheduler.ts#L42)。
- **影响**：面板无法解释「卡在哪」，运维只能读日志。
- **建议**：最小闭环——`queue` 快照增加 `lastError/nextPollAt/writebackBacklog`；为 poll/sync/launch 记录 `startedAt/finishedAt`；日志统一字段 `project/task/ticket/command/durationMs`，凭据统一走 `redact()`。
- **工作量**：2 人日。

### P2-3 测试策略

- **问题**：队列测试使用 fake engine，掩盖 P0-1；回写路径（CSV/TSV/XLSX 三种）零用例；无「停用 + 排队」「重启 + running」「并发 scan/tick」用例；Windows 下 11 例符号链接失败作为「已知基线」被容忍；`runtime.spec.ts` 是 1600+ 行的巨石，定位成本高。
- **证据**：[queue.spec.ts](../tests/queue.spec.ts)（fake engine）；`tests/` 下无 writeback 用例；[015 §2 P2-6](../docs/015-production-readiness-gaps.md#L44)。
- **影响**：最高风险的写路径没有回归网；「已知失败」会持续吞掉真实回归。
- **建议**：给队列/调度补「真实 Engine + 临时 stateDir」集成用例；把写回拆成纯函数（bytes → bytes）+ 文件系统用例；为 Windows 跳过项加显式 `describe.skipIf` 与 issue 编号，禁止裸失败。
- **工作量**：3–4 人日。

### P2-4 发布、回滚与文档一致性

- **问题**：版本仍是 `0.1.0`，无 changelog/发布脚本；013 要求「重置」但未实现；014 的「13 条循环」与实测 2 组 SCC 不符，且引用了不存在的 `tests/scheduler.spec.ts`、`tests/projects.spec.ts`；007 测试表里 `tests/queue.spec.ts` 出现两次（[007 L444](../docs/007-architecture.md#L444)、[007 L466](../docs/007-architecture.md#L466)），且 `src/task-sources/writeback.ts` 被描述为「`.xlsx` 未支持」，与 [writeback.ts:26](../src/task-sources/writeback.ts#L26) 实际调用 `writeXlsxStatus` 矛盾；013 §12 的阶段编号与实际开发顺序（队列先于重置）已错位。
- **证据**：如上及 [014](../docs/014-code-pruning-inventory.md)；[013 §12](../docs/013-authoritative-project-design.md#L501-L513)。
- **影响**：新人按 014 预估裁剪工作量会失准；按 013 的阶段表无法判断当前进度；`docs.spec.ts` 只校验「存在与覆盖」，查不出重复行与语义漂移。
- **建议**：文档里所有量化断言改为「由脚本生成」；在 `docs.spec.ts` 增加「测试表无重复行」「013/014 引用的路径存在」；版本策略定为 `0.2.0`（含 schema 重置）并在 013 增加「版本 ↔ schema ↔ 迁移」对照表。
- **工作量**：1–2 人日。

## 5. 过度设计（建议简化）

| 编号 | 设计 | 问题 | 建议 |
| --- | --- | --- | --- |
| O-1 | 两套凭据「不共用业务代码、列表/表单组件或错误码」（[013 §5.1 L170](../docs/013-authoritative-project-design.md#L170)） | Git 与飞书凭据的生命周期（CRUD/掩码/轮换/引用保护/复验）几乎同构，全量复制会产生 2 套表、2 套路由、2 套表单、2 套错误码前缀与 2 套文案，长期维护成本翻倍 | 保留**存储与表独立**（安全隔离有意义），但抽取一个 `CredentialStore` 内核 + 一个通用表单/列表原语，按 `kind` 提供字段描述；错误码可共享前缀族（`credentialInvalid/Forbidden/Expired`）并在文案层区分 |
| O-2 | 016 的 `_meta/schema_version/depends_on` + 自研 xlsx 读写 | 单人/单团队场景下 `_meta` 收益有限；`depends_on` 明确「只记录不阻塞」属于半成品；自研 ZIP/XML 需自行处理共享字符串、样式、日期、内联字符串，维护成本高且静默损坏风险大 | 先落地 3 个必填列 + 固定枚举 + 行级错误；`_meta` 可选；删除 `depends_on` 直到调度支持依赖；xlsx 明确标注「实验性只读」，或引入成熟库并接受包体增长 |
| O-3 | `knowledgeBase.spaceId` 全库唯一（[013 §9.1 L419](../docs/013-authoritative-project-design.md#L419)） | 企业常见「一个知识空间被多个团队共用」，强制全库唯一会直接挡住正常用法，且与 §10.11 的根集合方案冲突 | 统一为「按根节点集合唯一 + 重叠检测」，`spaceId` 仅做归属一致性与提示；同一空间不同子树允许分属不同项目 |
| O-4 | 队列终态永久保留（[013 §2.2 L44](../docs/013-authoritative-project-design.md#L44)） | 条目数单调增长，`appearance` 与快照无限膨胀，且「永久保留」与 SQLite 单库的运维现实不符 | 保留窗口 + 归档表；「唯一事实来源」限定为**活动条目**，终态转为可查询历史 |

## 6. 遗漏的必需能力

1. **队列操作面**：013 §7.1 有 `GET queue`，但没有「重试/取消/清空/调序」动作。任务卡在 `queued` 或 `failed` 时用户无路可走，只能改数据库。
2. **告警与通知**：项目连续 N 次轮询失败、写回积压、凭据过期、队列长时间无进展，都没有出口（现有通知只覆盖工单结束）。
3. **日常备份/恢复**：013 只在「重置」时备份；SQLite WAL + `secrets/` 的定期备份、恢复到指定时间点没有定义。
4. **速率限制与配额**：GitHub/GitLab `fetch` 与飞书 OpenAPI 都是限流接口，当前没有退避/令牌桶，多项目时会互相拖垮。
5. **明确非目标**：多仓库、任务优先级、任务依赖、并发 PR、跨项目共享知识库等，建议在 013 增加「非目标」小节，避免评审时反复讨论。

## 7. 对 013 方案的具体修订建议

> 按章节顺序，逐条给出「改哪里、改成什么」。

| 013 章节 | 修订建议 |
| --- | --- |
| §2.2 实体表（L43-L49） | `QueueEntry` 增加 `itemKey/contentHash/attempt/ticketId/writeback` 字段；把「终态保留」改为「活动条目为唯一事实来源，终态保留 30 天后归档」；明确 `QueueEntry` 是任务状态的投影，工单是执行记录，两者不做双向同步 |
| §2.3 关系（L51-L70） | 项目 → 仓库 → 凭据的引用关系保持不变；补充「项目仓库 ↔ 工作副本目录」「工单 ↔ per-ticket worktree」两条运行时关系，避免 §4.1 的执行目录与实际实现脱节 |
| §3.2/§3.3（L102-L117） | 保留「任务来源严格二选一」；知识库绑定改为「根节点集合唯一 + 重叠检测」，删除 `spaceId` 全库唯一，或将其降级为一致性校验 |
| §4.1 并发模型（L120-L126） | 增加「执行目录必须是 `project.repository@branch` 的 checkout（建议 `git worktree`）」，并把 prepare 改为项目级；明确轮询是独立副作用任务，不在 tick 内串行 await |
| §4.2 状态机（L127-L138） | 补 `writeback: pending/applied/failed` 与 `superseded`；补「同一 `taskKey+itemKey` 在活动态唯一」的索引级约束；补「任务重新出现」与「任务内容变更」两种再入队规则；`person` 阶段改为「超时重试」 |
| §4.3 停用语义（L139-L147） | 把推荐定义升级为定案：停用保留 `queued`、显示计数、提供「停止当前任务」「清空排队」；删除「待拍板」措辞 |
| §4.4 可观测性（L149-L152） | 快照增加 `lastError/nextPollAt/lastWriteback/writebackBacklog`；定义最小日志字段与指标（排队数、运行数、失败率、写回积压、轮询耗时） |
| §5.1 独立边界（L156-L170） | 改为「存储、加密、掩码、生命周期共用；业务语义、错误文案、页面入口独立」，删除「不共用列表/表单组件」的硬约束 |
| §5.2 Git 凭据（L172-L180） | 明确凭据**只对调度器发起的 git 命令**生效（`-c http.extraHeader` 或临时 askpass），不注册目录级 helper；SSH 优先 `ssh-agent`，落盘私钥改 DPAPI/ACL；补 Windows 的权限实现与验证方法；worker 默认不继承 git 凭据 |
| §5.4 项目选择规则（L191-L195） | 增加「项目记录 `lastVerifiedRevision`，凭据 revision 不一致即待复验」的落库字段与判定位置 |
| §6.1 驱动接口（L199-L216） | `list` 返回值改为 `{tasks, skipped, warnings, invalid}`（单文档/单行失败可隔离）；`writeback` 增加 `idempotencyKey` 与 `expectedStatus` 参数 |
| §6.3 知识库模型（L227-L242） | 保留根集合模型；补「文档级失效隔离」「增量读取（`obj_edit_time`/revision）」「跨文档 `task_id` 默认按文档隔离、键含 `nodeToken`」三条规则 |
| §6.4/§6.5（L258-L269） | 明确 016 标准格式是**前置条件**而非建议；任务键补齐 `repositoryPath`；状态枚举与 `taskPolicy` 的关系写成「标准枚举 + 项目级映射表」；`depends_on` 删除或标注「保留字段，暂不参与调度」 |
| §7.1 接口（L273-L295） | 增加 `PUT projects/:id`（若保留 settings 块则标注等价关系）、`POST projects/:id/run`、`POST queue/:id/retry|cancel`、`POST queue/clear`；`GET projects/:id/tasks` 合并写回状态 |
| §7.3 校验契约（L305-L309） | 「保存时重跑同一校验」需要落到服务端 `create/update` 内部（当前只在面板点「验证」时执行），并明确失败不落库 |
| §8.4 危险操作（L332-L343） | 「删除项目」补「先停止运行工单、取消队列条目」，与实现对齐；「更换仓库/分支」补「重建工作副本与 worktree」的明确步骤 |
| §9.1 目标 schema（L353-L420） | ①`queue` 列化并加部分唯一索引；②补 `writeback_*` 字段；③知识库唯一约束改为根集合；④删除 `spaceId` 唯一索引；⑤与 §10.11 的表述合并，消除自相矛盾 |
| §9.2 重置（L422-L464） | 重置必须先于队列/面板继续扩展（当前顺序相反）；补「备份 = `stateDir` 打包 + SQLite `VACUUM INTO`」的具体实现与 Windows 路径处理 |
| §10 待拍板（L471-L487） | 第 8/9/11/12/13 项已可定案，写回正文并关闭；保留真正未决的「权限模型（单用户 vs 多角色）」「CI 平台」两项 |
| §12 分阶段计划（L501-L513） | 重排为：P1 重置与 schema → P2 凭据 → P3 项目内联 → P3.5 队列加固（真实重试、唯一索引、item 级 reconcile、写回 outbox、worktree 工作区）→ P4 校验 → P5 知识库 → P6 界面/端到端；已完成的队列工作标注「待按 P3.5 回归」 |

## 8. 建议的修复顺序（用于排期参考）

1. **先修正确性**：P0-1（重试）、P1-6（runOnStart）、P1-3（item 级 reconcile）——改动小、收益直接。
2. **再修一致性**：P0-2（工作副本隔离）、P0-3（写回进入 `Effects`）。
3. **再修边界**：P0-4（worktree）、P1-9（分层）——这两项会改变项目与执行器的契约，宜在面板大规模开发前完成。
4. **最后补能力**：P1-7/P1-8（016、飞书）、P1-2/P1-4（队列约束与操作面）、P1-10（凭据）。
5. 全程配套 P2-3 的测试补齐；文档侧按第 7 节逐章回写 013，避免方案与实现继续分叉。
