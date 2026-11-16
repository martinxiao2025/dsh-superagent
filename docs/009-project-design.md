# 009 项目交付域设计

> 状态：已实现（0.2.0）。
> 地位：本文是「项目 / 代码仓库 / 任务来源 / 凭据 / 调度 / 界面」的设计权威；前身文档（项目与调度、设置信息架构）、架构评审与两轮重构方案的结论已并入本文与 CHANGELOG，原文见 git 历史。
> 关系：不取代 [001 领域模型](001-domain.md)（Source → Trigger → Thread → Eval → Ticket 主链路）、[003 执行](003-execution.md)（工单执行与会话）、[005 面板](005-panel.md)（面板骨架）、[007 架构](007-architecture.md)（模块与测试清单）。
> 前提：不考虑向后兼容，**不做任何旧数据迁移**；旧状态一律清空重建（见 8.2），新库启动即最终结构。
> 配套：任务清单格式规范见 `010-task-format.md`（编号大于本文，按编号规则不以链接引用）。

## 0. 关键约束（不可协商）

1. **一个项目一个仓库**：`Project.repository` 是单值，没有仓库数组；Excel 任务清单固定从该项目仓库读取，不允许另选。
2. **一个项目一个知识库**：知识库不是「一个节点」，而是「一个空间内的一组根节点（可含多层目录、多个文档与多维表格）」；一个项目只绑定一个知识库，一个知识空间只能归属一个项目；根节点与字段映射归项目。
3. **Git 凭据与飞书凭据是完全独立的两套功能**：独立表、schema、路由、服务端模块、前端页面、校验接口、错误码、文案命名空间、删除与轮换保护；唯一共用的是底层加密存储与掩码工具。
4. **项目只存凭据引用**：`repository.gitCredential` 与任务来源的 `feishuCredential` 各一个 ID；项目负载、设置快照、HTTP 响应里没有私钥、令牌或 App Secret。
5. **项目表单一站式**：名称、启停、执行目录、仓库地址与分支、任务来源、轮询时间在同一张表单内完成，敏感字段带真实「测试」按钮。
6. **任务来源三选一**：`excel`、`feishu-wiki` 或 `feishu-im`（飞书群消息，只读），严格互斥，随项目内联。

## 1. 领域模型

### 1.1 保留的主链路

```
Source(飞书消息) → Trigger → Thread → Eval → Ticket → Worker Session
```

这条链路属于 [001 领域模型](001-domain.md) 与 [003 执行](003-execution.md)，本文不改。本文只改「任务从哪里来、代码从哪里取、凭据怎么管」。

### 1.2 新增与退场

| 概念 | 定位 | 生命周期 |
| --- | --- | --- |
| Project | 交付单元：一个仓库 + 一种任务来源 + 执行与调度策略 | 长期存在，可启停 |
| QueueEntry | 项目任务的持久化队列条目，按「任务 + 工作项稳定键」去重的唯一事实来源 | 随任务产生，终态保留有限窗口 |
| GitCredential | SSH 私钥 / HTTPS 令牌的独立记录，可被多个项目引用 | 独立 CRUD、轮换、引用保护 |
| FeishuCredential | 飞书应用身份（App ID / Secret / 身份模式），可承载消息接入 | 独立 CRUD、轮换、引用保护 |
| KnowledgeBaseBinding | 项目对「一个空间 + 一组根节点」的唯一绑定，含文档集合与字段映射 | 随项目，重置后重新绑定 |
| ~~CodeRepoRecord~~ | 退场：仓库信息内联进项目，认证材料进 Git 凭据 | 重置即清空，不保留复用库 |
| ~~TaskSourceRecord~~ | 退场：任务来源内联进项目，凭据改引用 | 重置即清空，不保留复用库 |

### 1.3 关系

```
Project 1 ── 1 Repository ── 1 GitCredential
   │                └── branch / remote
   ├── 1 TaskSource ── excel（读本项目仓库）
   │                ├─ feishu-wiki ── 1 FeishuCredential ── 1 KnowledgeBase(spaceId 唯一)
   │                └─ feishu-im  ── 1 FeishuCredential ── 群 ID（只读）
   ├── 1 execution.directory / schedule / retry / taskPolicy
   └── * QueueEntry ── 0..1 Ticket ── 1 Worker Session

FeishuCredential 1 ── 0..1 ingress（消息接入）   // 与项目、知识库无关
```

关键边界：

- **代码仓库不产生任务**：只负责克隆、同步、分支、凭据注入与仓库文件读取。
- **任务来源只负责列任务**：过滤、拆解、重试、回写时机属于项目调度。
- **凭据只负责认证**：Git 凭据不读知识库，飞书凭据不做 Git 认证，不存在通用凭据记录。
- **知识库归项目**：飞书凭据可以跨项目复用，但复用凭据不会共享知识库。

## 2. 项目形态

### 2.1 表单分组

| 组 | 字段 | 规则 |
| --- | --- | --- |
| 基本信息 | 名称、启用开关 | 名称必填；ID 首次保存后不可改 |
| 代码仓库 | 仓库全地址、分支、Git 凭据 | 只填仓库全地址（`config.remote`），站点与仓库路径由 `repositoryOfRemote` 推导；仓库类型随所选凭据或地址站点推导为只读标签，仅未绑凭据且地址无法识别站点时保留选择；凭据只选引用 |
| 任务来源 | 类型三选一；位置；飞书凭据（知识库与群消息） | 三选一；Excel 只填清单文件相对路径一个字段；群 ID 支持从机器人已加入的群中选择 |
| 执行与调度 | 执行目录、轮询分钟、启动即跑 | 目录留空 = `<stateDir>/work` 默认 |
| 高级 | 最大重试、退避秒数、待处理/完成/失败状态 | 默认折叠 |
| 危险区 | 删除项目 | 见 7.4 |

### 2.2 任务来源三选一

- 判别联合，`kind` 只能是 `excel`、`feishu-wiki` 或 `feishu-im`。
- 切换类型时清空另一侧配置；若项目已有排队或运行中任务，先确认再切换。
- 飞书知识库必须绑定 `spaceId` + 节点 + 字段映射；群消息绑定飞书凭据与群 ID；Excel 不选飞书凭据。
- 项目只保存凭据引用 ID，不保存任何 Secret。

### 2.3 知识库绑定

- 知识库 = 空间内的根节点集合。绑定记录保存 `spaceId` 与一组 `rootNodeToken`（默认取空间根，允许选多个目录、文档或多维表格）；递归展开后得到文档集合。
- 唯一性建在空间上：一个 `spaceId` 只能归属一个项目（含停用项目），同一空间内不同根节点不能拆给两个项目；冲突即拒绝保存。两个项目共用同一个任务来源也按同一规则拒绝。
- 根集合不单独校验重叠：归属已由 `spaceId` 唯一确定，同一项目内重复或嵌套的根在遍历时按节点去重，不会重复产生任务。
- 归属校验：用项目所选飞书凭据对每个根节点调用 `wiki/v2/spaces/get_node`，返回的 `space_id` 必须等于绑定值；任一不符即拒绝。
- 根节点可以增删，但每次变更都要重新校验；删除根节点等于把该子树移出知识库，其任务按「消失」处理。
- 文档与多维表格在同一知识库内可有多份、可多层目录；快捷方式解析到目标节点，文件夹递归展开。
- 重置后新建的项目必须绑定知识库才能启用；未通过校验时保持停用，详情页直接定位到任务来源组。

## 3. 调度与队列

### 3.1 并发模型

- 全局 `executor.maxWorkers` 是唯一硬上限；每个项目同一时刻最多 1 个执行中任务。
- 出队顺序：全局 FIFO；队首项目已占用时跳过并继续看下一条（项目轮转），避免单项目占满。
- Worker 不是常驻进程：每个任务一个 DSH 会话，任务结束即归档。
- 执行目录按项目组织：`<executionRoot>/<project>/<ticket>`，`executionRoot` 默认 `<stateDir>/work`，项目名来自 `Project.name`。
- 项目工单的目录是**项目仓库的实际检出**，不是空目录：`prepareDirectory` 从轮询工作副本 `<stateDir>/repos/<repo>` 创建 `git worktree --detach`。轮询工作副本是**纯镜像**：远端 URL 变化时整目录重建（而不是 `merge --ff-only`），副本跟随项目 `execution.branch`，与清单轮询、回写、执行 worktree 落在同一分支。轮询副本、执行工作区、`stateDir` 下的队列数据库互不共用工作树，避免任务来源同步与 worker 改动互相踩；同一工单重试时复用已有工作区。`git worktree prune` 在每次创建前清理已删除目录的元数据；工作区默认保留供排查，删除目录后下次创建会自动清掉登记。
- 准备命令 `executor.prepare` 在项目工单中**于工单工作区内执行**（此前在父目录执行），因此依赖安装落在真实检出上；准备失败时本次新建的工作区会被移除，不会在重试时被误认为已就绪。
- **执行中不拉取**：项目只要有任务处于 `starting/running`（或执行器仍占用该项目的槽位），本轮轮询整体推迟，不同步仓库工作副本，避免 `git pull` 与 worker 的检出互相踩。推迟时把下次轮询设为 `min(轮询间隔, 60 秒)`，项目空闲后自动恢复；写回副作用同样需要同步工作副本，遇到项目忙时抛 `Later`，由 `Effects` 在初始延迟后重试且不计入失败次数。
- **手动扫描与定时检查互斥**：`scan()` 与周期 `tick()` 共用同一条执行链；已有检查在跑时，后到的调用并入当前这一轮，不会对同一项目并发轮询。
- 工作副本与 worktree 的清理走 workspace GC 的保留窗口；`repos/` 下的孤儿目录不自动清理。

### 3.2 状态机

```
queued → starting → running → succeeded
                   ↘ failed ──(未达 maxRetries，退避后)──> queued
                   ↘ cancelled（任务消失 / 人工停止 / 项目删除排队项）
```

- 失败重试只由 `Project.retry` 决定，不再由执行器另算一套。
- **每次重试都是新的执行尝试**：触发器 ID 含条目 ID 与 `attempt`（`trigger <queueId> <attempt>`），因此新触发器必然创建新工单，不会复用已结束工单拿回旧结果。
- 队列落 SQLite，重启按 `seq` 恢复；`starting/running` 但工单不存在的条目按一次失败重排。
- **工作项身份是稳定键**：`splitTask` 为每个工作项派生 `itemKey`（内容摘要 + 任务内重复序号）与 `contentHash`。轮询按「任务 + `itemKey`」核对：某一项被删除或改写只影响该项；内容变化时旧条目取消（排队中）或等其自然结束后重新入队（执行中），已成功的同内容不重跑。旧记录没有 `itemKey` 时退回序号。
- **唯一性由数据库兜底**：`queue` 表用生成列 `uniqueKey`（项目 + 任务 + 工作项，仅活动态）建部分唯一索引；应用层去重失效时写入会直接失败，而不是产生两条并行条目。旧库打开时若发现重复活动条目，保留最早入队的一条再建索引。
- **终态清理**：`succeeded/failed/cancelled` 在每次轮询时按 30 天窗口清理（`queue.prune`）；活动条目才是队列事实来源。

### 3.3 停用与删除语义（已实现）

- 停用后不再轮询；`pump` 跳过停用项目的排队项，条目保留为 `queued`，恢复启用后继续。
- 运行中的任务默认继续，另提供「停止当前任务」独立动作（工单停止接口已存在，面板动作待接）。
- **新建与删除项目都会触发安装重跑**（`persistRecord`/`removeRecord` 与 `save` 同一规则计算 `setupChanged`）。删除流程 = 删记录 → `ProjectScheduler.forget`（停止仍在执行的工单——以 `by=human` 的 `stopped` 结束，取消尚未投递的回写副作用，删除该项目的全部队列记录）→ 重跑。
- 界面仍需显示「已停用；仍有 N 个排队、M 个运行」，不能只显示一个「停用」标签。

### 3.4 可观测性

- 队列快照已有：`maxWorkers`、`used`、条目状态、尝试次数、`dueAt`、`reason`；`projects[]` 额外提供 `nextPollAt` 与 `lastError`（成功后清除）以及 `deferred`（因本项目有任务在执行而推迟轮询的原因与时间，下一次真正轮询时清除），周期检查自身的错误在 `error`。
- 项目详情 `GET projects/:id/tasks` 同步携带 `nextPollAt` / `lastError` / `deferred`，面板显示「下次轮询」、最近错误与「轮询已推迟」原因。
- 剩余缺口（结构化日志与请求 ID、写回结果与槽位等待时长）已列入 `tasks/backlog.csv`。

## 4. 凭据（两套独立功能）

### 4.1 独立边界

| 维度 | Git 凭据 | 飞书凭据 |
| --- | --- | --- |
| 数据表 | `git_credentials` | `feishu_credentials` |
| schema | `GitCredentialSchema` | `FeishuCredentialSchema` |
| 服务端目录 | `src/git-credentials/` | `src/feishu-credentials/` |
| HTTP 路由 | `/git-credentials/*` | `/feishu-credentials/*` |
| 前端页面 | `src/client/git-credentials.tsx` | `src/client/feishu-credentials.tsx` |
| 测试接口 | `POST git-credentials/verify` | `POST feishu-credentials/verify` |
| 错误码前缀 | `gitCredential*` / `gitRepository*` / `gitNetworkUnreachable` | `feishuCredential*` / `knowledgeBase*` |
| 文案命名空间 | `gitCredentials.*` | `feishuCredentials.*` |
| 引用保护 | 统计 `gitCredential` 引用项目 | 统计 `feishuCredential` 引用项目与消息接入 |

唯一共用：`src/secrets/` 的加密存储与掩码工具。两个模块不共用业务代码、列表组件、表单组件或错误码。

### 4.2 Git 凭据

- 类型只有 SSH 私钥与 HTTPS 令牌；另存 `provider`（GitHub / GitLab / 通用）用于身份探测。`agent` 类型未实现；未绑定凭据的项目沿用本机 SSH key（gh / glab 的登录路径保留在凭据页）。
- 字段：名称、类型、provider、作用域说明、私钥（粘贴或本机路径）/ 令牌、HTTPS 用户名、可选口令。
- 存储：`<stateDir>/secrets/git/` 独立加密文件；只回显 `{ configured, hint: '••••abcd', fingerprint, updatedAt, revision, lastVerifiedAt }`。
- 测试：带 `repository` 时用临时私钥文件（0600）或临时 `GIT_ASKPASS` 做 `ls-remote` 探测；不带时只做材料与身份校验。临时材料在 `finally` 删除。
- 结果区分：`gitCredentialInvalid`、`gitCredentialForbidden`、`gitCredentialUnreadable`、`gitCredentialKindMismatch`、`gitRepositoryNotFound`、`gitRepositoryEmpty`、`gitNetworkUnreachable`。
- 轮换：`POST git-credentials/:id/rotate` 递增 `revision`；引用项目标记「待复验」，不自动改写项目。
- 删除：被任一项目引用（含停用）时返回 409 与引用列表，要求先改绑。

### 4.3 飞书凭据

- 身份模式：应用身份（App ID + App Secret）或 CLI 身份（lark-cli 配置）。
- 字段：名称、身份模式、App ID、App Secret、CLI 配置、作用域说明；群 / 私聊 / 候选机器人 / 准入策略放在详情的「消息接入」标签。
- 存储：`<stateDir>/secrets/feishu/` 独立加密文件；只回显 `{ mode, appIdHint, configured, hint, updatedAt, revision, lastVerifiedAt, ingressEnabled }`。
- 测试：先验应用身份（tenant access token 或 CLI 登录态），失败返回 `feishuCredentialInvalid` / `feishuCredentialExpired`；带 `spaceId` 时再验知识库权限，无权限返回 `feishuCredentialForbidden`。
- 轮换：递增 `revision`；引用项目标记「待复验」，消息接入健康状态重置。
- 删除：被项目引用或被消息接入使用时返回 409，分别列出影响范围。

### 4.4 项目选择规则

- 每个项目有且只有一个 `gitCredential`，协议必须与仓库地址一致。
- 飞书知识库与群消息项目有且只有一个 `feishuCredential`；Excel 项目不选飞书凭据。
- 项目表单只提供下拉与「新建 / 管理」链接，不内嵌凭据表单。

## 5. 任务来源

### 5.1 驱动接口

```ts
interface TaskSourceDriver<C> {
  kind: string
  title: Localized
  schema: z.ZodType<C>
  fields: FieldSpec[]
  fieldMap: { defaults: TaskFieldMap; required: (keyof TaskFieldMap)[] }
  verify(config: C, field: string, deps: VerifyDeps): Promise<SourceCheck[]>
  list(config: C, ctx: { signal: AbortSignal; commands: Commands; syncRepo: SyncRepo }): Promise<RawTask[]>
  writeback?: (config: C, target: WriteTarget, status: string, ctx: WriteContext) => Promise<void>
}
```

- `list` 只读并规范化，不拆解、不判重、不做业务过滤。
- `verify` 沿用 `SourceCheck`（`{ field, ok, scope, code, values }`），不写设置、不重启。
- `writeback` 可选：Excel 清单与飞书多维表格已实现；docx 与群消息明确不支持（见 5.2）。

### 5.2 驱动

| 驱动 | 位置 | 读取 | 回写 |
| --- | --- | --- | --- |
| `excel` | 本项目仓库内相对路径 | `.csv` / `.tsv` / `.xlsx` | 支持：更新匹配行的状态列并提交为干净工作副本 |
| `feishu-wiki` | 知识空间 + 根节点集合（`spaceId` + `roots[]`） | docx 任务表、bitable 记录；文件夹递归、快捷方式解引用 | bitable 记录的状态字段已支持；docx 明确报未支持 |
| `feishu-im` | 飞书群 ID（从机器人已加入的群中选择） | 按群读取最近消息，一条消息一个任务，去掉 @ 占位、跳过空文本，按消息编号去重 | 无回写目标（只读） |

新增驱动：实现接口 → 在 `src/task-sources/index.ts` 注册 → 面板下拉自动出现 → 在 007 的模块表与测试表登记。

### 5.3 知识库模型（多文档、多层目录）

飞书知识库不等于知识空间：一个空间是一棵节点树，节点可以是文档（docx）、多维表格（bitable）、表格（sheet）、文件夹，或指向其他节点的快捷方式；`/wiki/<token>` 里的是节点 token，真正的数据对象在 `obj_token`（见 `lark-wiki` 技能文档的 node-get 返回模型）。

绑定模型：

| 字段 | 含义 |
| --- | --- |
| `spaceId` | 知识空间 ID；全库唯一归属 |
| `roots[]` | 根节点列表 `{ nodeToken, objType, title, path }`；为空表示整空间根 |
| `mode` | `space`（整空间）或 `roots`（选定子树） |

- 只有 `docx` 与 `bitable` 产生任务；`sheet`、`file` 跳过并计数；`folder` 递归；`shortcut` 解析到目标节点，并用 visited 集合防环。节点类型判定与遍历在 [feishu-wiki-read.ts](../src/task-sources/feishu-wiki-read.ts)。
- 读取链路：`wiki +node-get` 取 `space_id` / `obj_token` / `obj_type` / `has_child` → `wiki +node-list --parent-node-token` 递归（`--page-all` 分页）→ docx 读文档内容、bitable 读记录。
- 身份限制：个人知识库 `my_library` 只对 user 身份可见；应用身份需被加入空间成员。校验必须区分「凭据无权」与「空间不存在」。

多文档任务规划：

| 问题 | 规则 |
| --- | --- |
| 哪些文档算任务文档 | docx 含至少一张表头包含 `task_id`/`title`/`status` 的表格；bitable 字段满足同一契约；其余跳过并计数 |
| 多文档如何合并 | 按遍历顺序拼接（根节点顺序 → 目录顺序 → 表出现顺序），统一排序后进入同一队列 |
| 同一任务在多个文档出现 | 稳定键含 `nodeToken`，默认视为不同任务；严格模式下同一 `task_id` 跨文档出现则整次同步拒绝并列出冲突 |
| 文档增删改名 | 节点 token 不变则任务键不变（改名、移动无影响）；节点删除 → 其任务按「消失」标记 `cancelled`；新增节点 → 新任务入队 |
| 结构变化失效 | 某文档缺必填列 → 该文档整体失败并隔离，其他文档继续；根节点全部失效 → 知识库标记无效、项目停用 |

稳定键：文档 `feishu:<nodeToken>:<task_id>`，多维表格 `feishu-bitable:<nodeToken>:<tableId>:<recordId>`。文档删除后重建会换 token，旧任务按消失处理，不会静默合并。

校验能验证什么：可达性（凭据能否读空间）、归属（每个根节点的 `space_id`）、展开结果（文档/多维表格数量、跳过的节点类型）、任务表识别（哪些文档含标准表头）、解析条数（有效任务、行级错误、警告）。校验不写数据、不入队。

### 5.4 Excel 标准格式

- 标准工作簿是**唯一路径**：`tasks` 表 + 固定表头（`task_id` / `title` / `status` 必填），`_meta` 表存 `schema_version`；模板可生成，校验按标准执行。
- 自定义列映射与工作表选择已移除；非标准清单在校验与轮询中整批拒绝，改造路径是下载模板重建清单。
- 完整规范（列定义、枚举、版本化、模板、边界处理）见独立文档 `010-task-format.md`。
- 任务键：`excel:<projectId>:<repositoryPath>:<task_id>`；`task_id` 改名视为新任务。

### 5.5 字段映射与状态策略

- 字段映射（编号/标题/描述/状态/优先级）由驱动按 010 标准列契约提供默认值；自定义映射已移除，面板不再提供覆盖入口。
- 待处理状态过滤、完成与失败状态写回值属于 `Project.taskPolicy`。
- 任务编号重复或缺失时整批拒绝并定位到行，不做部分导入。

## 6. 接口

面板与智能体可依赖的完整 API 清单以 [006 部署](006-deployment.md) 的管理 API 表为权威；本节只列项目交付域的接口。

### 6.1 项目域接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST/PUT/DELETE | `projects[/:id]` | 项目 CRUD（含内联仓库与任务来源） |
| POST | `projects/:id/run` | 手动触发一次任务同步 |
| GET | `projects/:id/tasks` | 任务与队列状态 |
| POST | `code-repos/verify` | Git 凭据 × 仓库地址的真实探测（项目表单仓库步共用） |
| POST | `code-repos/branches` | 凭据 + 候选仓库 → 分支列表与默认分支（向导选择分支） |
| POST | `task-sources/verify` | 任务来源字段级预检：Excel 读取、飞书凭据 × 知识库归属与唯一性 |
| POST | `feishu-im/chats` | 凭据 → 机器人已加入的群（群消息任务来源的群 ID 选择） |
| GET | `queue` | 队列与槽位快照 |
| POST | `queue/:id/retry` | 手动重试已结束或退避中的条目；尝试次数重置 |
| POST | `queue/:id/cancel` | 取消活动条目；运行中的工单会被停止 |
| POST | `queue/clear?project=` | 清空排队项，不影响运行中的任务 |
| GET/POST/PUT/DELETE | `git-credentials[/:id]` | Git 凭据独立 CRUD |
| POST | `git-credentials/verify` | Git 凭据独立测试（可带 `repository` / `branch`） |
| POST | `git-credentials/:id/rotate` | 轮换，递增 revision |
| GET | `git-credentials/:id/references` | 引用项目 |
| GET/POST/PUT/DELETE | `feishu-credentials[/:id]` | 飞书凭据独立 CRUD |
| POST | `feishu-credentials/verify` | 应用身份 + 可选 `spaceId` 权限 |
| POST | `feishu-credentials/:id/rotate` | 轮换 |
| GET | `feishu-credentials/:id/references` | 引用项目与消息接入 |
| GET | `feishu-credentials/:id/wiki/spaces` | 该凭据可见的知识空间 |
| GET | `feishu-credentials/:id/wiki/spaces/:spaceId/nodes` | 空间内节点 |
| GET | `feishu-credentials/:id/wiki/spaces/:spaceId/tree` | 递归树（含 `objType`、`hasChild`，用于选择根节点） |
| GET | `task-format/template` | 下载标准工作簿模板 |

### 6.2 删除

- `POST sources` 中的 GitHub / GitLab 分支。
- `code-repos/*`、`task-sources/*` 不提供 CRUD：仓库与任务来源内联进项目，这两类前缀只承载字段级预检（verify / branches / chats）。
- 共享的 `POST projects/verify`：拆为 `code-repos/verify` 与 `task-sources/verify` 两个独立校验接口，不设统一入口。
- 设置块 `codeRepo:<id>`、`taskSource:<id>`，以及全部旧设置升级入口。
- 新增 `POST admin/reset`（仅本机回环可用，需确认令牌，见 8.2）。

### 6.3 校验契约

- 请求可携带草稿秘密（仅本次请求使用），响应永远不回显秘密。
- 校验失败返回字段级结果与独立错误码；保存时重跑同一校验，失败不落库。
- 失败文案区分：凭据无效、无权限、仓库不存在、仓库为空、网络不可达（Git）；身份无效、已过期、无权限、知识库不可读（飞书）。
- 统一脱敏：CLI 错误输出在进入日志/工单/面板前经过 `redact()`（URL 内嵌凭据、Authorization、Bearer、`token=`、私钥块）。

## 7. 界面

### 7.1 导航

- 顶层：概览、项目、触发、评估、执行、设置（`src/client/route.ts` 的 `MENU_TABS`），复用既有「触发」「执行」页承载线程与工单视图；无独立「来源」页签，来源状态从概览与项目详情直达。
- 设置一级分组：**Git 凭据**、**飞书凭据**、**项目**、**评估**、**执行**、**提示词**、**部署**（`SETTINGS_GROUPS`）；新建项目向导覆盖前五组。
- 不设统一「凭据」入口；两个凭据页互不跳转，也没有类型切换。

### 7.2 项目页

- 列表：启用状态、仓库、任务来源、运行中/排队数、待复验与待绑定标记；顶部显示全局 `used / maxWorkers`。
- 详情：配置摘要（含最终生效执行目录与两个凭据名）、任务队列（停止/重试/取消排队）、最近工单。
- 启停是详情页头的即时动作，旁注队列后果。

### 7.3 设置页

- Git 凭据：独立列表与表单；测试、轮换、引用保护、危险区删除。
- 飞书凭据：独立列表与表单；详情分「应用身份」「消息接入」两个标签；知识库不在此页配置。
- 项目：唯一业务配置入口，包含内联仓库与任务来源。
- 系统 → 高级：配置历史与诊断；不提供复用库，旧记录在重置时已清空。

### 7.4 动作与危险操作

| 动作 | 位置 | 规则 |
| --- | --- | --- |
| 保存项目 | 表单底部粘性操作条 | 保存前分别跑仓库与任务来源校验，任一失败整体拒绝 |
| 测试 | 仓库组 / 任务来源组 | 只针对已选凭据，调用各自独立接口 |
| 启停 | 项目详情页头 | 停用前说明排队与运行任务的处理方式 |
| 更换仓库/分支/凭据 | 仓库组 | 有排队或运行任务时二次确认，提示重新同步工作副本 |
| 更换知识库/飞书凭据 | 任务来源组 | 必须重新通过归属与唯一性校验 |
| 删除项目 | 危险区 | 有未结束工单时要求输入项目名确认 |
| 删除凭据 | 各自凭据页危险区 | 有引用时 409 + 影响范围，不静默级联 |

### 7.5 空状态与深链

- 无项目：提供「新建项目」；若尚无凭据，先引导创建 Git 凭据与飞书凭据。
- 无 Git 凭据 / 无飞书凭据：就地提供「去创建」，不提供内嵌秘密输入。
- 待绑定知识库：项目标记并保持停用，详情直接定位到任务来源组。
- 所有设置项支持 `?group=...&id=...` 深链。

## 8. 数据模型与重置

### 8.1 目标 schema（示意）

新库首次启动即按本节结构建表，不存在旧版本升级路径。读取校验：queue 按完整 schema，ticket/thread/decision 按关键字段形状（未知字段放行），损坏行明确报错，不做静默强转。

```ts
const GitCredentialSchema = z.object({
  id: z.string(), name: z.string().trim().min(1),
  authType: z.enum(['ssh-key', 'https-token']),
  provider: z.enum(['github', 'gitlab', 'generic']),
  description: z.string().trim().default(''),
  material: z.discriminatedUnion('source', [
    z.object({ source: z.literal('inline'), privateKey: SecretRefSchema, passphrase: SecretRefSchema.optional() }).strict(),
    z.object({ source: z.literal('path'), path: z.string().trim().min(1), passphrase: SecretRefSchema.optional() }).strict(),
    z.object({ source: z.literal('token'), username: z.string().trim().default('x-access-token'), token: SecretRefSchema }).strict(),
  ]),
  revision: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
  lastVerifiedAt: z.string().nullable(),
}).strict()

const FeishuCredentialSchema = z.object({
  id: z.string(), name: z.string().trim().min(1),
  mode: z.enum(['app', 'cli']),
  appId: z.string().trim().default(''), appSecret: SecretRefSchema.optional(),
  cli: z.string().trim().default(''), description: z.string().trim().default(''),
  ingress: z.object({ enabled: z.boolean(), chats: z.array(z.string()).default([]),
    otherChats: z.array(z.string()).default([]), directMessages: z.array(z.string()).default([]),
    allowedUsers: z.array(z.string()).default([]), bots: z.array(z.string()).default([]) }).strict().optional(),
  revision: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
  lastVerifiedAt: z.string().nullable(),
}).strict()

const RepositorySchema = z.object({
  kind: z.enum(['github', 'gitlab']),
  repository: z.string().trim().min(1),
  branch: z.string().trim().default(''), remote: z.string().trim().default(''),
  gitCredential: z.string().trim().min(1),
  gitCredentialRevision: z.number().int().optional(),
}).strict()

const FeishuWikiTaskSourceSchema = z.object({
  kind: z.literal('feishu-wiki'),
  feishuCredential: z.string().trim().min(1),
  feishuCredentialRevision: z.number().int().optional(),
  // 知识库归属的唯一键是 spaceId：一个空间只归属一个项目，根节点只是该空间内的读取范围。
  knowledgeBase: z.object({
    spaceId: z.string().trim().min(1), spaceName: z.string().trim().default(''),
    mode: z.enum(['space', 'roots']).default('space'),
    roots: z.array(z.object({
      nodeToken: z.string().trim().min(1), objType: z.string().trim().min(1),
      title: z.string().trim().default(''), path: z.string().trim().default(''),
    }).strict()).default([]),
  }).strict().nullable(),
  fieldMap: TaskFieldMapSchema,
}).strict()

// feishu-im 变体同构：绑定 feishuCredential 引用与群 ID 列表，只读无回写。

const ProjectTaskSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('excel'), config: ExcelConfigWithoutRepo }).strict(),
  FeishuWikiTaskSourceSchema,
])
```

约束：

- `git_credentials` 与 `feishu_credentials` 两张独立表，不设通用凭据表或 `type` 判别字段。
- 项目只存两个凭据 ID 与上次校验通过的 revision；轮换后 revision 不一致即「待复验」。
- `knowledgeBase.spaceId` 唯一索引（含停用项目），即一个空间只归属一个项目；同一任务来源被两个项目引用同样视为冲突（两个项目因此读取同一空间）；每个 root 解析出的 `space_id` 必须与之一致；`roots` 为空表示整空间。
- `enabled: true` 的前置条件：Git 凭据通过当前仓库校验、飞书凭据通过知识库校验、知识库已绑定且唯一。

### 8.2 重置（不做迁移）

**入口**（三种方式，均需二次确认）：

- 命令：`dsh-superagent reset --yes`；不带 `--yes` 时只打印将删除的清单，不动数据。
- 启动参数：`--reset-state`，用于首次部署或强制回到空基线。
- 面板：设置 → 高级 → 重置，需输入 `RESET` 并再次确认。

**备份**：

- 默认在清空前把 `stateDir` 打包到 `~/dsh-superagent-backup/<timestamp>/`；完成后在命令输出与面板提示中给出绝对路径。
- 备份目录是用户可删资产，运行期不再读取；`--no-backup` 显式跳过，并在输出中标注「未备份」。
- 备份失败即中止重置，不做任何删除。

**清空范围**：

| 类别 | 内容 | 处理 |
| --- | --- | --- |
| 设置 | `settings` 全部记录：`sources`、`codeRepos`、`taskSources`、`projects`、`policy`、`eval`、`executor`、提示词与部署配置 | 删除记录并重建空表 |
| 队列与工单 | `queue`、`ticket`、`thread`、`trigger`、`disposition`、`decision`、`outbox`、`effect` | 删除记录（表结构重建） |
| 历史 | `settings-history`、评估与工单时间线 | 删除 |
| 凭据 | `<stateDir>/secrets/git/`、`<stateDir>/secrets/feishu/` | 删除目录 |
| 工作副本 | `<stateDir>/work/` 下所有项目目录 | 删除目录；项目表单指定的外部执行目录**不删**，只在报告中列出 |
| 仓库缓存 | `<stateDir>/repos/` | 删除目录 |
| 锁与临时文件 | `store.lock`、启动锁、worker shim、临时克隆目录 | 删除 |

**保留**：

- 插件安装目录（package root）与 DSH 自身 profile（模型、账号、插件注册）。
- 日志目录：默认保留最近一份便于排查，重置报告注明路径；`--purge-logs` 可一并删除。
- 用户在 `stateDir` 之外、由项目执行目录字段引用的目录。

**执行顺序**：停止调度与执行 → 获取全局锁 → 备份 → 校验备份完整性 → 关闭数据库 → 删除表与目录 → 以空库重建最终 schema → 写入基线版本 → 释放锁。

**首次启动行为**：

- 直接按最终 schema 建表，不读取、不探测任何旧结构，不存在升级分支。
- 启动后为空态：无项目、无凭据、无来源、无队列；轮询不启动，不自动创建任何记录。
- 概览显示三步引导：创建 Git 凭据 → 创建飞书凭据（可选，Excel 项目不需要）→ 新建项目并测试。
- 若检测到旧版数据库文件但未重置，启动直接报错并提示执行 `reset`，不做半迁移。

**失败处理**：任一步失败保留备份并回滚到重置前（先改名到临时目录再删），不出现「表已清空但目录还在」的中间态。

**版本 ↔ schema ↔ 迁移对照**（随每次 schema 变更更新此表与 CHANGELOG）：

| 包版本 | schema | 打开策略 |
| --- | --- | --- |
| 0.1.x | 10–13 | 迁移链逐版升级（该策略已废弃） |
| 0.2.0 起 | 14 | 硬门禁：只打开当前版本；其他版本一律拒绝并提示 `reset`（先备份）。升级跨 schema 版本 = 备份 → reset → 从空基线重建 |

日常备份（升级前快照）见 [006 部署 · 日常备份](006-deployment.md)。

### 8.3 重置后重建示例

- `demo-tree`：新建项目 → 选 GitHub 仓库 `martinxiao2025/DemoTree`、分支 `main` → 新建 Git 凭据（SSH 路径材料）并测试通过 → 任务来源选 Excel `docs/backlog.csv` → 保存后保持停用。
- 飞书知识库项目：先建飞书凭据并测试应用身份 → 新建项目时绑定知识空间与节点 → 通过归属与唯一性校验后才能启用。
- 验收标准：从空库开始，不借助任何旧记录，完成「建凭据 → 建项目 → 测试 → 启用 → 领取一条任务」全流程。
