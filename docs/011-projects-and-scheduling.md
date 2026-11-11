# 项目、代码仓库、任务来源与调度重构设计（定稿）

> 状态：已按 D1–D11 定稿；P1–P4 已实现（队列与调度、项目维度的建单入口），P5 面板未开始。
> 前提：这是插件功能的优化与重构，**不考虑向后兼容**。
> 产品定位：GitHub / GitLab 只作为代码仓库；系统任务只来自任务来源（首批 Excel 文件与飞书知识库），来源类型可扩展；支持多项目，一个项目同时只执行一个任务，超出全局 worker 上限的任务排队等待。

## 0. 决策记录

### 0.1 已定稿的决策

| 编号 | 结论 |
| --- | --- |
| D1 | 项目与代码仓库一对一。`Project.codeRepo` 是单个记录 ID，不设 `codeRepos[]`。 |
| D2 | 每个任务一个执行会话；同一项目串行执行；任务之间不复用同一会话。Worker 是并发槽位 + 每任务会话，不是常驻进程。 |
| D3 | 全局 `executor.maxWorkers` 是唯一硬并发上限；每个项目同一时间最多运行 1 个任务。**这是本设计采用的假设**：`maxWorkers` 统计正在执行任务的工作单元会话数；人工对已在运行的工单续跑不额外开新任务，也不额外占任务槽位。若与你的理解不符，见 0.2 第 2 条。 |
| D4 | 任务来源是独立设置记录，项目通过 `taskSource` 记录 ID 引用。 |
| D5 | 回写是可选能力 `writeback?`：Excel 首批实现；飞书知识库首批只读。 |
| D6 | 删除 GitHub / GitLab 的 Issue、PR、评论、CI 触发器，以及相关适配器、测试与文档。代码仓库只负责克隆、同步、分支与凭据，不产生任何任务。 |
| D7 | 面板新增一级「项目」页签；设置页拆出「代码仓库」与「任务来源」两组。 |
| D8 | 旧 pipeline 记录不迁移，启动时一次性清理废弃；清理范围与影响见第 7 节。 |
| D9 | 任务来源允许多实例，按记录 ID 引用。 |
| D10 | 队列全局 FIFO，按项目轮转出队，避免单个项目的一次大批量任务饿死其他项目。 |
| D11 | 保留 Task → WorkItem → Ticket 三层：外部任务不直接变成工单，仍按现有规则拆解。 |

### 0.2 需要确认的实现冲突与范围说明

以下三项是实现层面必须落定的取舍，文档暂按推荐项写，但需要你确认：

1. **删除 `executor.projectWorkers`**。现有配置项 `projectWorkers`（[policy.ts:96](../src/policy.ts#L96)）默认 `0` 表示「自动取全局上限的一半」，与 D3「每项目同时只跑一个」直接冲突。计划删除该字段、对应 LIMITS、面板字段与相关测试；项目串行由调度器固定为 1，不再可配。
2. **人工跟进的额外槽位**。现有 `WorkerSlots.reserve()` 对 `by === 'person'` 允许在 `maxWorkers` 之外多占 1 个槽位，并绕过项目上限（[dsh.ts:206-214](../src/executor/dsh.ts#L206-L214)）。与「`maxWorkers` 是唯一硬上限」冲突。推荐方案 (a)：人工续跑只作用于已持槽的工单，不再额外 +1；方案 (b)：保留 +1 作为响应速度优先的例外。**需要你选。**
3. **飞书的双重身份**。D6 只覆盖 GitHub / GitLab。飞书目前既是消息来源（产生 Trigger，[feishu.ts:30-70](../src/sources/feishu.ts#L30-L70)），又被 pipeline 用来读取知识库任务。本设计保留飞书消息来源，只把「知识库任务读取」迁入任务来源驱动。若你希望飞书也不再产生消息触发器，需要另行拍板。

### 0.3 次要项（按上一轮默认执行）

- 任务来源中消失的任务：标记 `cancelled` 并保留记录、原因与时间，不自动重新排队；之后重新出现时重新入队一次，并保留上一条历史。
- 停止 / 停用项目：保留队列与任务记录，只暂停调度；恢复后从队首继续。
- 飞书字段映射：允许用户覆盖驱动默认映射；留空时使用驱动默认值。
- 同项目串行执行时不复用同一会话：每个任务仍是独立会话。

## 1. 现状评估

### 1.1 现有主线

`docs/001-domain.md` 的流程是：

```
Source → Trigger → Thread → Eval → Ticket → Executor
```

Source 是「能产生触发器」的插件，飞书沿用同一个 `SourceKind` 契约（[kind.ts](../src/sources/kind.ts)），由 `ADAPTERS` 登记并跑轮询循环（[adapters.ts](../src/sources/adapters.ts)、[runtime.ts](../src/app/runtime.ts)）；GitHub / GitLab 与 pipeline 的适配器在 P3 已删除。

`pipeline` 是一种 SourceKind，但实际上已经承担了「项目」的角色：一条 pipeline 记录同时绑定代码来源、任务来源、时间表、并发、重试和回写（`src/pipeline/pipeline.ts`、`src/pipeline/config.ts`，P3 已删除）。

### 1.2 与目标定位冲突的具体位置

| # | 冲突 | 位置 | 说明 |
| --- | --- | --- | --- |
| 1 | Git 来源仍在产生任务 | `src/sources/github.ts`（`watch`、issues/comments/PR 轮询）、`src/sources/gitlab.ts` 同构；P3 已删除 | 新定位下 Git 只提供代码，不应产生 Issue/PR/评论/CI 触发器 |
| 2 | pipeline 任务伪装成 Git 触发器 | `src/pipeline/runner.ts` 的 `triggerOf()`（P3 已删除） | 把 `source` 设为 `config.codeSource`，工单来源、执行凭据、执行目录都被 Git 记录绑架 |
| 3 | 项目由代码仓库隐式决定 | [execution-environment.ts](../src/app/execution-environment.ts) 的 `projectIdOf()` | 只认 GitHub 的 `repository` / GitLab 的 `project`，飞书与其他来源「没有项目」 |
| 4 | 工单所属项目靠目录名反推 | [dsh.ts](../src/executor/dsh.ts) 的 `projectOfTicket()` | 项目不是一等实体 |
| 5 | Worker 会话按工单创建 | [dsh.ts](../src/executor/dsh.ts) 的 `workerSessionId()` | 会话 ID 是 `worker-<ticketId>`，没有「项目」维度，也没有项目级串行保证 |
| 6 | 两套并发限制互不知情 | `src/pipeline/runner.ts` 的内存 `concurrency` 队列 + [dsh.ts](../src/executor/dsh.ts) 的 `WorkerSlots`（P3 已删除前者） | 流水线先在自己的循环里排队，再被全局槽位二次排队；队列不可见、不可统一调度 |
| 7 | 槽位超限用异常排队 | [dsh.ts](../src/executor/dsh.ts) 的 `reserve()` 抛 `Later` | 不是持久化 FIFO，重启后顺序与可见性不可控 |
| 8 | 任务来源类型写死为枚举 | `src/pipeline/config.ts` 的 `z.enum(['excel','feishu'])`、`task-source.ts`、`writeback.ts`（P3 已迁移或删除） | 已有 `TaskSourcePort` 雏形，但配置、校验、表单、回写仍按枚举分支 |
| 9 | 设置模型没有项目 / 仓库 / 任务来源分类 | [policy.ts](../src/policy.ts) 的 `SettingsSchema.sources` | 所有记录平铺在 `sources` 下，pipeline 记录把三类配置揉进一个 `config` |
| 10 | 持久化没有项目表与队列表 | [store.ts](../src/app/store.ts) | 只有 `kv / trigger / disposition / thread / ticket / decision / outbox / effect` |
| 11 | 面板没有项目视图 | [route.ts](../src/client/route.ts) 的 `TABS`、[settings.tsx](../src/client/settings.tsx)、[source.tsx](../src/client/source.tsx) | 只有「概览 / 来源 / 触发器 / 评估 / 执行 / 设置」，项目只能以来源卡片出现 |
| 12 | 文档术语把 pipeline 当项目 | `docs/010-pipeline.md`、`docs/009-source-records.md` | Pipeline 同时描述代码源与任务源，Source 概念过载 |

结论：现有代码具备「来源插件化」「任务源端口雏形」「全局并发槽位」三块基础，但缺少 **Project 一等实体**、**任务来源独立登记**、**统一的可持久化队列**，并且 Git 适配器仍然越权产生任务。

## 2. 目标架构

### 2.1 核心概念

| 概念 | 定义 | 生命周期 |
| --- | --- | --- |
| Project（项目） | 交付单元。引用一个代码仓库、一个任务来源，并声明执行目录、轮询、重试与任务状态策略 | 长期存在，可启停 |
| CodeRepo（代码仓库） | 代码数据源。GitHub / GitLab 记录，只负责克隆、同步、分支、凭据与仓库文件读取，不产生任务 | 与项目解耦，可被多个项目引用 |
| TaskSource（任务来源） | 任务的权威清单。实现统一驱动接口，首批 Excel 文件与飞书知识库 | 独立设置记录，可复用、可多实例 |
| Task（任务） | 任务来源中的一条待办，含稳定编号、标题、描述、状态、优先级 | 由任务来源读取，可拆成多个 WorkItem |
| Worker（工作单元） | 执行任务的 DSH 会话与并发槽位。每个任务一个会话；同一项目同时最多一个 | 随任务创建，任务结束释放 |
| Queue（队列） | 等待 Worker 的项目任务队列。全局上限满时持久化排队 | 持久化，可观测，可重启恢复 |

### 2.2 关系

```
Project 1 ── 1 CodeRepoRef ──> CodeRepo(GitHub / GitLab 记录)
Project 1 ── 1 TaskSourceRef ──> TaskSource(Excel / 飞书知识库 / 未来类型)
Project 1 ── * Task ──> WorkItem * ──> Ticket ──> Worker
                                        └──> QueueEntry（等待空闲 Worker）
```

关键边界：

- **CodeRepo 不产生 Trigger**。它只在执行阶段被调用：同步代码、切分支、注入凭据、读取仓库文件。
- **TaskSource 只负责「列出任务」**。过滤、拆解、重试、回写时机属于项目调度，不属于来源驱动。
- **Task 不是 Ticket**。Task 是外部清单的一行；Ticket 是系统内可执行、可审计的工单。保留现有 `Task → WorkItem → Ticket` 链路。
- **Worker 属于全局槽位，项目只约束「同时一个」**。Ticket 是 Worker 当前承载的工作，不是并发单位。

### 2.3 与现有概念的映射

| 现有 | 目标 |
| --- | --- |
| `settings.sources[id]` 中 `kind=github/gitlab` | `codeRepos[id]`（保留记录 ID、名称与配置） |
| `settings.sources[id]` 中 `kind=feishu` | 仍留在 `sources`（消息来源）；知识库读取迁移为独立 `TaskSource` |
| `settings.sources[id]` 中 `kind=pipeline` | 不迁移，启动时清理（D8） |
| `pipeline.codeSource` | `Project.codeRepo` |
| `pipeline.taskKind/taskFile/taskSheet/wikiUrl/feishuSource/column*` | `TaskSourceRecord.kind + config`（含字段映射） |
| `pipeline.intervalMinutes/runOnStart` | `Project.schedule` |
| `pipeline.maxRetries/retryBackoffSeconds` | `Project.retry` |
| `pipeline.concurrency` | 删除；由全局槽位 + 项目串行替代 |
| `pipeline.doneStatus/failedStatus/pendingStatuses` | `Project.taskPolicy` |
| `pipeline.directory/remoteUrl/branch` | `Project.execution` 与 `CodeRepo.config` 覆盖项 |

## 3. 领域模型改动

### 3.1 新增实体

```ts
interface Project {
  id: string
  name: string                    // 必填，用于面板与执行目录
  enabled: boolean
  codeRepo: string                // CodeRepo 记录 ID（一对一，D1）
  taskSource: string              // TaskSource 记录 ID（D4）
  execution: { directory?: string; branch?: string }
  schedule: { intervalMinutes: number; runOnStart: boolean }
  retry: { maxRetries: number; retryBackoffSeconds: number }
  taskPolicy: { pendingStatuses: string[]; doneStatus: string; failedStatus: string }
}

interface CodeRepoRecord {
  id: string
  name: string                    // 必填
  kind: 'github' | 'gitlab'
  enabled: boolean
  config: Record<string, unknown> // 由代码仓库类型 schema 校验
}

interface TaskSourceRecord {
  id: string
  name: string                    // 必填
  kind: string                    // 驱动注册名，首批 'excel' | 'feishu-wiki'
  enabled: boolean
  config: Record<string, unknown> // 含来源位置与字段映射，由驱动 schema 校验
}

interface Task {
  key: string                     // 由来源记录 + 外部编号派生的稳定键
  sourceId: string
  externalId: string
  title: string
  description: string
  status: string
  priority?: string
}

interface QueueEntry {
  id: string
  project: string
  taskKey: string
  state: 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  ticketId?: string
  seq: number                     // 全局入队序号，FIFO 依据
  enqueuedAt: string
  attempts: number
  reason?: string
}
```

### 3.2 删除 / 合并

- 删除 `pipeline` 的 SourceKind 身份与整个 `src/pipeline/` 运行时（`pipeline.ts`、`runner.ts`、`config.ts`、`task-source.ts`）；代码同步、Excel 读取、飞书读取、回写分别迁入新模块后删除原文件。
- 删除 `PipelineConfigSchema` 与 `pipeline` 的 KV 记录（`pipeline-state:`、`pipeline-items:`）。
- 删除 GitHub / GitLab 的触发器读取、线程上下文、回复通道、PR 认领与 CI 汇总；保留代码同步、仓库文件读取、`gh` / `glab` 凭据与 CLI。
- 删除 `executor.projectWorkers` 设置与相关 UI、LIMITS、测试（D3）。
- 删除 `policy.sources` 中 GitHub / GitLab 条目的准入表（消息来源只剩飞书；任务来源不接受入站消息）。

### 3.3 设置 schema

按职责拆成四块，全部记录名称必填；加载路径只有一条：

```ts
interface Settings {
  paused: boolean
  sources: Record<string, SourceInstance>        // 消息来源：飞书（保留现状）
  codeRepos: Record<string, CodeRepoRecord>      // 代码仓库
  taskSources: Record<string, TaskSourceRecord>  // 任务来源
  projects: Record<string, Project>              // 项目
  policy: PolicyConfig
  eval: EvalConfig
  executor: ExecutorConfig                       // 删除 projectWorkers
}
```

上一轮的「`name` 必填」半成品合并进本次重构，不再单独收尾：`SourceInstanceSchema.name`、`CodeRepoRecord.name`、`TaskSourceRecord.name`、`Project.name` 一律为 `z.string().trim().min(1)`，移除「空值回退类型名或记录 ID」的运行时兜底；仅在 schema 迁移里对旧记录做一次补齐。

## 4. 任务来源抽象

### 4.1 统一驱动接口

放在 `src/task-sources/kind.ts`，替代现有按枚举分支的 `createTaskSource()`：

```ts
interface TaskSourceDriver<C> {
  kind: string
  title: Localized
  /** 来源位置与字段映射等配置 */
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** 字段映射：外部列 / 块 → Task 字段；驱动给出默认值与必填项，用户可覆盖 */
  fieldMap: { defaults: TaskFieldMap; required: (keyof TaskFieldMap)[] }
  /** 预检：真实访问来源，返回字段级结果；不写设置、不重启 */
  verify(config: C, field: string, deps: VerifyDeps): Promise<SourceCheck[]>
  /** 列出任务；只读取与规范化，不拆解、不判重、不做业务过滤 */
  list(config: C, ctx: { signal: AbortSignal; commands: Commands }): Promise<RawTask[]>
  /** 可选能力：把状态写回外部清单 */
  writeback?: (config: C, target: WriteTarget, status: string) => Promise<void>
}
```

要点：

- `list` 取代 `TaskSourcePort.load()`，不再依赖 `PipelineConfig`。
- 字段映射属于任务来源记录；项目只负责 `pendingStatuses` 过滤与拆解策略。
- `verify` 沿用现有 `SourceCheck` 契约（`{ field, ok, scope, code, values }`），与 `POST task-sources/verify` 一致。
- `writeback` 可选；Excel 驱动实现，飞书知识库首批不实现。

### 4.2 首批实现

| 驱动 | 配置 | 读取 | 回写 |
| --- | --- | --- | --- |
| `excel` | 绝对路径、工作表、列映射 | 复用现有 `src/pipeline/excel.ts` 与 `tasks.ts` 的导入校验 | 支持 `.csv` / `.tsv` / `.xlsx`，沿用现有原子替换 |
| `feishu-wiki` | 知识库 URL、机器人 CLI | 复用现有 `src/pipeline/feishu.ts` 的读取逻辑 | 首批只读 |

### 4.3 新增一种任务来源需要做什么

1. 实现 `TaskSourceDriver`：`schema`、`fields`、`fieldMap`、`verify`、`list`，按需 `writeback`。
2. 在 `src/task-sources/index.ts` 注册。
3. 预检至少覆盖「来源可达」「字段映射完整」「能读到至少一条任务」。
4. 面板无需改动：项目页的「任务来源」下拉从注册表生成。
5. 在 `docs/007-architecture.md` 的模块表与测试表登记新文件（文档测试会检查）。

## 5. 多项目与并发调度

### 5.1 Worker 池

- 全局 `executor.maxWorkers` 是唯一硬上限（删除 `projectWorkers`）。
- 每个项目固定同时最多 1 个执行中的任务（D2 / D3）；项目内继续执行的任务必须等待前一个结束。
- Worker 不是常驻进程：每个任务一个 DSH 会话（沿用 `worker-<ticketId>`），不跨任务复用；会话结束后归档。
- 执行目录按项目组织：`work/<project>/<ticket>`；项目名来自 `Project.name`，不再从仓库配置反推。

### 5.2 队列

新增统一持久化队列，替代 pipeline 内部循环与 `WorkerSlots` 的 `Later` 重试：

```
轮询任务来源 → 过滤 pendingStatuses → 按 taskKey 去重 → 入队（queued）
            → 调度器挑队首（全局槽位有空 + 该项目无运行中任务）→ starting
            → 创建 Worker 会话 → running
            → 终态 succeeded / failed / cancelled → 可选回写
```

- 队列落 SQLite（新增 `queue` 表），重启后按 `seq` 恢复。
- 出队顺序：全局 FIFO；若队首任务所属项目已有运行中 / 启动中任务，则跳过它继续看下一条（项目轮转），避免单项目大批量任务占满队列。
- 全局槽位满时不出队，队列保持 `queued`，面板可见排队数与位置。
- 同一任务（`taskKey`）在 `queued / starting / running` 期间不重复入队。

### 5.3 任务状态机

```
queued → starting → running → succeeded
                   ↘ failed ──(未达 maxRetries，退避后)──> queued
                   ↘ cancelled（来源中消失 / 项目停止时人工取消）
```

- 失败重试只由 `Project.retry` 决定，不再由 pipeline runner 与 executor 各算一套。
- 来源中消失的任务：标记 `cancelled`，保留记录与原因；再次出现时重新入队并保留上一段历史。
- 项目停用 / 停止：队列保留为 `queued`，只暂停调度，不丢弃；恢复后继续。
- 宿主重启：`starting` / `running` 且对应工单已不存在的条目，按一次失败处理并退避重排（计入 `attempts`，受 `maxRetries` 限制），避免永久卡在运行态。

### 5.4 失败、停止与抢占

- 工单失败 / 停止沿用现有引擎状态机；调度器只观察工单终态并更新队列条目。
- 停止项目不等于停止正在运行的工单：默认等待当前工单结束（或由用户显式停止工单）。
- 人工续跑现有工单不创建新的队列条目，也不改变项目占用。

### 5.5 可观测性

- API 暴露每个项目：排队数、运行数、最近失败原因、下一次轮询时间。
- 概览页展示全局槽位使用、队列长度、各项目等待时间。

## 6. 接口与面板改动

### 6.1 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` / `POST` / `PUT` / `DELETE` | `/orchestrator/api/projects[/:id]` | 项目 CRUD 与启停 |
| `POST` | `/orchestrator/api/projects/:id/run` | 手动触发一次任务同步 |
| `GET` | `/orchestrator/api/projects/:id/tasks` | 当前任务与队列状态 |
| `GET` / `POST` / `PUT` / `DELETE` | `/orchestrator/api/code-repos[/:id]` | 代码仓库记录 |
| `POST` | `/orchestrator/api/code-repos/verify` | 代码仓库字段级预检 |
| `GET` / `POST` / `PUT` / `DELETE` | `/orchestrator/api/task-sources[/:id]` | 任务来源记录 |
| `POST` | `/orchestrator/api/task-sources/verify` | 任务来源字段级预检（含名称必填校验） |
| `GET` | `/orchestrator/api/queue` | 队列与槽位快照 |

- 删除 `POST sources` 中 GitHub / GitLab 分支；`sources` 只保留消息来源（飞书）。
- `PUT settings/:block` 的 block 改为 `project:<id>`、`codeRepo:<id>`、`taskSource:<id>`、`policy`、`eval`、`executor`。
- 预检保持「不写设置、不重启」，名称字段按必填校验。

### 6.2 面板

- 一级页签增加「项目」（`TABS`：概览 / 项目 / 触发器 / 评估 / 执行 / 设置）。
- 项目列表：名称、代码仓库、任务来源、运行状态、排队数；项目详情：任务清单、队列、运行历史、字段映射覆盖。
- 设置页分组改为「代码仓库」「任务来源」「评估」「执行」「提示词」「部署」：
  - 代码仓库：仓库、实例、CLI、凭据与同步字段；不再有 Issue/PR/评论/CI 开关。
  - 任务来源：文件或知识库位置、字段映射，带逐字段「验证」与「全部验证」。
- 概览增加项目维度与全局槽位；执行页增加项目过滤。
- 文案继续走 `locales`，样式沿用 `dt-*`。

## 7. 数据清理与重建（D8）

### 7.1 迁移步骤（一次性，schema 11 → 12）

`src/app/migration.ts` 增加 `migrateTo12(store)`，在单个事务里完成：

1. 遍历 `settings.sources`：
   - `kind=github/gitlab` → 原样移动到 `settings.codeRepos`（保留 id、name、enabled、config）。这是字段搬移，不是兼容分支；名称缺失时在这一步用记录 ID 补齐一次。
   - `kind=feishu` → 保留在 `settings.sources`。
   - `kind=pipeline` → **直接删除**，不做项目转换。
2. 删除 `settings.policy.sources` 中属于已删除 pipeline 记录的条目。
3. 删除 KV：前缀 `pipeline-state:`、`pipeline-items:`、`github-`、`gitlab-` 的键（后两者只服务已删除的触发器）。
4. 不迁移任何 pipeline 任务项、运行状态或回写进度。
5. 已存在的工单记录保留（审计需要），其 `execution.project`、`origin` 不改写。

### 7.2 会影响哪些现有数据

| 数据 | 处理 | 影响 |
| --- | --- | --- |
| `settings.sources` 中的 pipeline 记录 | 删除 | 旧流水线配置、任务文件/知识库地址、列映射、并发与重试设置全部丢失，需要按 7.4 重建 |
| `pipeline-state:` / `pipeline-items:` | 删除 | 旧任务的去重、续跑与回写进度丢失；已回写的 Excel 状态保留在文件里 |
| GitHub / GitLab 的触发器游标、PR/CI 记录 | 删除 | 历史触发器与线程不再更新；已存在的触发器与工单仍可查看 |
| GitHub / GitLab 来源记录 | 移动到 `codeRepos` | 凭据、CLI、仓库配置保留；UI 位置从「来源」变为「代码仓库」 |
| 飞书来源记录 | 保留 | 消息接收与历史不变 |
| pipeline 产生的未结束工单 | 保留 | 不会自动继续；其来源记录已不存在，面板按「来源缺失」显示，可手动停止 |
| `stateDir/pipeline/<id>/code` 与旧 `work/` 目录 | **不自动删除** | 目录里可能有代码检出或未提交改动，自动删除有数据风险；列入手动清理清单 |

### 7.3 SQLite 与 stateDir

- 新增表：
  - `project (id TEXT PRIMARY KEY, value TEXT NOT NULL)`
  - `code_repo (id TEXT PRIMARY KEY, value TEXT NOT NULL)`
  - `task_source (id TEXT PRIMARY KEY, value TEXT NOT NULL)`
  - `queue (id TEXT PRIMARY KEY, project TEXT NOT NULL, state TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL)`，索引 `(project, state, seq)`。
- 迁移后运行的 settings 快照只保留新结构；旧 `sources` 中的 pipeline 条目不再出现。
- `stateDir` 执行目录统一为 `work/<project>/<ticket>`；`stateDir/pipeline/` 不再写入。

### 7.4 升级后的重建步骤

1. 启动插件，确认迁移完成、旧 pipeline 记录消失。
2. 在「设置 → 代码仓库」确认 GitHub / GitLab 记录存在且字段校验通过。
3. 在「设置 → 任务来源」新建记录：Excel 填文件路径、工作表与列映射；飞书填知识库 URL 与 CLI。
4. 在「项目」页新建项目，选择代码仓库与任务来源，设置轮询间隔、重试与任务状态策略。
5. 手动清理旧目录（可选）：`<stateDir>/pipeline/` 以及确认无用的旧 `work/` 目录。

## 8. 受影响文件清单

### 8.1 删除

| 文件 | 原因 |
| --- | --- |
| `src/pipeline/pipeline.ts`、`src/pipeline/runner.ts`、`src/pipeline/config.ts`、`src/pipeline/task-source.ts` | pipeline 作为 SourceKind 与运行循环整体移除 |
| `src/sources/github-trigger.ts`、`src/sources/github-pull.ts`、`src/sources/github-channel.ts` | GitHub Issue / PR / 评论 / CI 触发器与回复通道（D6） |
| `src/sources/gitlab-trigger.ts`、`src/sources/gitlab-channel.ts` | GitLab 触发器与回复通道（D6） |
| `src/sources/forge.ts` | 只服务 Git 触发器准入表 |
| `tests/gitlab.spec.ts`、`tests/github-read.spec.ts` 等 Git 触发器测试 | 随功能删除 |

### 8.2 新增

| 文件 | 内容 |
| --- | --- |
| `src/projects/kind.ts` | Project schema、默认值与校验 |
| `src/projects/scheduler.ts` | 取任务、入队、出队、项目串行与失败退避 |
| `src/projects/queue.ts` | 队列表读写与重启恢复 |
| `src/projects/directory.ts` | 项目执行目录命名 |
| `src/code-repos/kind.ts`、`src/code-repos/sync.ts`、`src/code-repos/read.ts` | 代码仓库登记、同步（迁移自 `pipeline/code.ts`）、仓库文件读取（迁移自 `github-read.ts` 的 `readRepositoryPath`） |
| `src/task-sources/kind.ts`、`src/task-sources/index.ts`、`src/task-sources/excel.ts`、`src/task-sources/feishu-wiki.ts`、`src/task-sources/tasks.ts`、`src/task-sources/writeback.ts` | 驱动接口、注册表与首批实现（迁移自 `pipeline/`） |
| `src/app/views/projects.ts`、`src/client/projects.tsx` | 项目 API 视图与面板页 |
| `tests/projects.spec.ts`、`tests/scheduler.spec.ts`、`tests/task-sources.spec.ts`、`tests/code-repos.spec.ts`、`tests/panel-projects.spec.tsx` | 新增测试 |

### 8.3 修改

| 文件 | 改动 |
| --- | --- |
| `src/policy.ts` | `SettingsSchema` 拆为 `sources / codeRepos / taskSources / projects`；名称必填；删除 `projectWorkers` |
| `src/app/migration.ts` | `SCHEMA_VERSION` 11 → 12；新增 `migrateTo12` 与清理逻辑 |
| `src/app/store.ts`、`src/app/store-read.ts` | 新增项目 / 代码仓库 / 任务来源 / 队列表与读取 |
| `src/app/settings.ts`、`src/app/settings-history.ts` | 新 block 类型、CRUD 与变更历史 |
| `src/app/setup.ts`、`src/setup.ts` | 名称必填校验；代码仓库 / 任务来源预检字段 |
| `src/app/http.ts`、`src/app/api.ts` | 新路由、删除旧 sources 中 Git 分支 |
| `src/app/runtime.ts` | 移除 Git 触发器适配器与 pipeline 适配器；接入项目调度器 |
| `src/app/views/settings.ts`、`src/app/views/sources.ts`、`src/app/views/overview.ts` | 分组、项目维度与来源缺失占位 |
| `src/app/execution-environment.ts` | 项目来自 `Project.name`；删除 `projectIdOf()`；目录 `work/<project>/<ticket>` |
| `src/app/resources.ts`、`src/app/cards.ts`、`src/app/assessment.ts`、`src/app/prompts.ts`、`src/app/context.ts` | 删除 Issue / PR / CI 资源与 PR 卡片；保留仓库文件读取 |
| `src/app/tools/executor.ts` | 删除 PR 认领工具；保留工作单元执行工具 |
| `src/executor/dsh.ts` | 项目来自 Project；`WorkerSlots` 项目上限固定 1；与队列对接 |
| `src/sources/kind.ts`、`src/sources/registry.ts`、`src/sources/adapters.ts` | 来源只保留消息类（飞书）；删除 Git 触发器契约 |
| `src/sources/github.ts`、`src/sources/gitlab.ts` | 收缩为代码仓库类型描述（schema、fields、facts），不再 `watch` |
| `src/infra/worker-sources.ts`、`src/infra/commands.ts`、`src/infra/environment.ts` | 记录类型改为代码仓库 / 任务来源；保留 `gh` / `glab` / `lark-cli` 分发 |
| `src/client/route.ts`、`src/client/settings.tsx`、`src/client/source.tsx`、`src/client/overview.tsx`、`src/client/execution.tsx`、`src/client/locales.ts`、`src/client/api.ts`、`src/client/text.ts` | 项目页签、设置分组、文案与路由 |
| `src/deployment.ts`、`src/limits.ts` | 代码仓库部署字段；删除 `projectWorkers` 限制 |
| `src/kv.ts` | 删除 `pipeline`、`github`、`gitlab` 键族，新增项目 / 队列键 |
| `docs/000-philosophy.md`、`docs/001-domain.md`、`docs/003-execution.md`、`docs/005-panel.md`、`docs/007-architecture.md`、`docs/009-source-records.md`、`docs/010-pipeline.md` | 术语与流程同步；007 的模块表 / 测试表必须同步增删 |
| `tests/*` 中 pipeline、github、gitlab、sources、settings、migration、execution-environment、runtime-concurrency、panel-source 等 | 按新模型重写或删除 |

## 9. 分阶段实施计划与验收点

| 阶段 | 内容 | 验收点 |
| --- | --- | --- |
| P1 领域与设置 | Project / CodeRepo / TaskSource schema；settings 四块拆分；名称统一必填；迁移 11→12 与 pipeline 清理；CRUD API 与设置视图 | typecheck 通过；迁移测试覆盖 pipeline 删除与 Git 记录搬移；旧库启动不报错；旧 pipeline 记录不再出现 |
| P2 任务来源 | 抽出 `TaskSourceDriver`；实现 `excel` 与 `feishu-wiki`；`verify` 支持逐字段与全部验证；删除 pipeline 枚举分支 | 两种来源都能列出任务；新增一个假驱动即可接入；名称必填预检失败文案正确；不写设置、不重启 |
| P3 代码仓库收敛 | GitHub / GitLab 移除全部触发器（D6）；保留同步、分支、凭据与仓库文件读取；清理入口、工具、面板字段 | 任何 Issue / PR / 评论 / CI 都不再产生触发器；项目任务只来自任务来源；代码同步与 `gh` / `glab` 可用 |
| P4 调度与队列 | Queue 表、调度器、全局槽位、项目串行、失败退避、重启恢复、消失任务取消 | 并发超限时排队可见；同项目严格串行；重启后顺序恢复；失败按 `maxRetries` 重排 |
| P5 面板 | 项目页签、项目详情、代码仓库 / 任务来源设置分区、队列与项目概览 | 端到端可在面板创建项目、验证来源、查看排队与执行；文案中英文齐全 |
| P6 清理与文档 | 删除旧 pipeline / Git 触发器代码与 KV；更新 000 / 001 / 003 / 005 / 007 / 009 / 010；移除本文「待确认」标记 | 无死代码与无引用文件；`tests/docs.spec.ts` 通过（编号连续、链接可解析、007 模块表与测试表完整） |

每个阶段结束都执行 `pnpm typecheck`、相关 vitest 用例与 `pnpm build`；全部完成后按既有方式打包并安装到插件目录，安装后核对仓库产物；DSH 是否需要重启按实际情况说明，不擅自重启。

## 10. 风险与开放问题

1. **D3 的边界**：`maxWorkers` 是否把「人工续跑现有工单」计算在内，直接决定是否保留 `WorkerSlots` 的 +1 语义（0.2 第 2 条）。
2. **飞书双重身份**：本次只迁移知识库读取；若后续要求飞书只做任务来源，需要再删一轮消息来源代码。
3. **严格项目串行的吞吐**：大项目会让同项目任务等待较久；这是 D2 / D3 的直接结果，若需要项目内并行必须重新拍板。
4. **字段映射覆盖**：飞书内容按表头 / 复选框自动识别，抽象为可覆盖映射后，需要确认覆盖失败时的错误提示是否足以自助修复。
5. **任务编号稳定性**：任务来源中编号重复或改变会导致重复执行或历史断裂；导入校验继续整批拒绝并定位到行。
6. **队列与工单状态不一致**：宿主崩溃可能留下 `running` 条目；恢复策略按一次失败重排，需要测试覆盖。
7. **旧目录与凭据**：`stateDir/pipeline` 与旧 `work/` 不自动迁移；需要用户手动清理，文档已列步骤。

## 11. 下一步

请确认 0.2 的 2 个取舍（删除 `projectWorkers`、人工跟进是否保留额外槽位）以及 0.2 第 3 条的飞书范围。确认后按第 9 节 P1 开始编码；在此之前不改实现代码、不打包、不安装。
