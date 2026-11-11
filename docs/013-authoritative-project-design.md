# 013 项目交付域设计（权威版）

> 状态：设计定稿建议。本轮只写文档与清单，未改代码、未提交。
> 地位：本文是「项目 / 代码仓库 / 任务来源 / 凭据 / 调度 / 设置界面」的唯一权威版本，合并并取代 [011-projects-and-scheduling.md](011-projects-and-scheduling.md) 与 [012-settings-information-architecture.md](012-settings-information-architecture.md)。两篇旧文档保留为历史记录，冲突时以本文为准。
> 关系：不取代 [001-domain.md](001-domain.md)（Source → Trigger → Thread → Eval → Ticket 主链路）、[003-execution.md](003-execution.md)（工单执行与会话）、[005-panel.md](005-panel.md)（面板骨架）、[007-architecture.md](007-architecture.md)（模块与测试清单）。
> 前提：不考虑向后兼容，**不做任何旧数据迁移**；旧状态一律清空重建（见 9.2），新库启动即最终结构。
> 配套清单：代码裁剪见 `014-code-pruning-inventory.md`，生产就绪差距见 `015-production-readiness-gaps.md`（两份清单为本轮审计产物）。

## 0. 关键约束（不可协商）

1. **一个项目一个仓库**：`Project.repository` 是单值，没有仓库数组；Excel 任务清单固定从该项目仓库读取，不允许另选。
2. **一个项目一个知识库**：知识库不是「一个节点」，而是「一个空间内的一组根节点（可含多层目录、多个文档与多维表格）」；一个项目只绑定一个知识库，一个知识空间只能归属一个项目；根节点与字段映射归项目。
3. **Git 凭据与飞书凭据是完全独立的两套功能**：独立表、schema、路由、服务端模块、前端页面、校验接口、错误码、文案命名空间、删除与轮换保护；唯一共用的是底层加密存储与掩码工具。
4. **项目只存凭据引用**：`repository.gitCredential` 与 `taskSource.feishuCredential` 各一个 ID；项目负载、设置快照、HTTP 响应里没有私钥、令牌或 App Secret。
5. **项目表单一站式**：名称、启停、执行目录、仓库地址与分支、任务来源、轮询时间在同一张表单内完成，敏感字段带真实「测试」按钮。
6. **任务来源二选一**：`excel` 或 `feishu-wiki`，不存在第三种「同时轮询」。

## 1. 审计结论摘要

本轮全仓审计的完整事实与证据见 `014-code-pruning-inventory.md` 与 `015-production-readiness-gaps.md`，这里只列影响设计方向的六条：

1. **概念重复是结构性的，不是文案问题**：同一个仓库在 `codeRepos` 记录、`project.codeRepo`、`taskSources.excel.config.repo` 三处存在，靠 `checkRepoBinding` 补偿（[settings.ts:355-370](../src/app/settings.ts#L355-L370)）；认证材料埋在 `codeRepos.config`，无法独立轮换与测试。
2. **调度实现已经具备目标形态的骨架，并已补齐正确性**：持久化队列（[model.ts](../src/queue/model.ts)）、全局槽位 + 项目串行出队、失败退避、重启恢复都在；本轮已把重试改为新触发器/新工单、把工作项身份改为稳定键、把回写放进持久化副作用队列，并在数据库层加了活动条目唯一索引。剩余缺口是可观测性与界面，而不是重写。
3. **停用/删除语义已闭环**：`pump` 只领取启用项目的排队项；停用后排队项保留为 `queued` 但不再派工，运行中的任务继续；删除项目会停止在跑工单并清理其队列记录（`ProjectScheduler.forget`）。界面仍需显示「停用但仍有 N 个排队」。
4. **设置视图原样下发配置**：`settingsView` 直接返回 `config`（[views/settings.ts:44-63](../src/app/views/settings.ts#L44-L63)）。当前 SSH 只存路径所以危害有限；一旦允许粘贴私钥或 App Secret，这条路径会直接把秘密送到浏览器与快照。
5. **写回已改为持久化副作用**：`writeback` 作为 `Effects` 的一种（`kind = 'writeback'`）落库，失败按退避重试并进入健康度；键包含队列条目、结果与尝试次数，重复投递幂等。文本清单回写保留原 BOM 与换行，并在工作副本中提交该文件，避免脏工作树阻塞 `merge --ff-only`。
6. **文档层已经出现互相取代**：011 的 D4/D7 被 012 推翻，010 描述的是已删除的 pipeline，005 的页签列表停在旧结构。这就是本文合并的原因；旧文档的处置见第 11 节。

## 2. 领域模型

### 2.1 保留的主链路

```
Source(飞书消息) → Trigger → Thread → Eval → Ticket → Worker Session
```

这条链路属于 [001-domain.md](001-domain.md) 与 [003-execution.md](003-execution.md)，本文不改。本文只改「任务从哪里来、代码从哪里取、凭据怎么管」。

### 2.2 新增与退场

| 概念 | 定位 | 生命周期 |
| --- | --- | --- |
| Project | 交付单元：一个仓库 + 一种任务来源 + 执行与调度策略 | 长期存在，可启停 |
| QueueEntry | 项目任务的持久化队列条目，按「任务 + 工作项稳定键」去重的唯一事实来源 | 随任务产生，终态保留有限窗口 |
| GitCredential | SSH 私钥 / HTTPS 令牌的独立记录，可被多个项目引用 | 独立 CRUD、轮换、引用保护 |
| FeishuCredential | 飞书应用身份（App ID / Secret / 身份模式），可承载消息接入 | 独立 CRUD、轮换、引用保护 |
| KnowledgeBaseBinding | 项目对「一个空间 + 一组根节点」的唯一绑定，含文档集合与字段映射 | 随项目，重置后重新绑定 |
| ~~CodeRepoRecord~~ | 退场：仓库信息内联进项目，认证材料进 Git 凭据 | 重置即清空，不保留复用库 |
| ~~TaskSourceRecord~~ | 退场：任务来源内联进项目，凭据改引用 | 重置即清空，不保留复用库 |

### 2.3 关系

```
Project 1 ── 1 Repository ── 1 GitCredential
   │                └── branch / remote
   ├── 1 TaskSource ── excel（读本项目仓库）
   │                └── feishu-wiki ── 1 FeishuCredential
   │                                └── 1 KnowledgeBase(spaceId 唯一) ── node / fieldMap
   ├── 1 execution.directory / schedule / retry / taskPolicy
   └── * QueueEntry ── 0..1 Ticket ── 1 Worker Session

FeishuCredential 1 ── 0..1 ingress（消息接入）   // 与项目、知识库无关
```

关键边界：

- **代码仓库不产生任务**：只负责克隆、同步、分支、凭据注入与仓库文件读取。
- **任务来源只负责列任务**：过滤、拆解、重试、回写时机属于项目调度。
- **凭据只负责认证**：Git 凭据不读知识库，飞书凭据不做 Git 认证，不存在通用凭据记录。
- **知识库归项目**：飞书凭据可以跨项目复用，但复用凭据不会共享知识库。

### 2.4 与现有实现的差异（不是迁移方案）

下表只说明概念差异。新库直接落最终结构，不读取旧表、旧设置块或旧 ID；旧状态一律清空（见 9.2）。

| 现状 | 目标 |
| --- | --- |
| `settings.sources` 中 `kind=github/gitlab` | 不再存在；仓库信息内联项目，材料进 Git 凭据 |
| `settings.codeRepos[id]` | 不再存在；不设复用库，仓库只属于项目 |
| `settings.taskSources[id]` | 不再存在；任务来源只属于项目 |
| `project.codeRepo` | `project.repository`（含 `gitCredential`），单值 |
| `project.execution.branch` | `project.repository.branch` |
| `taskSource.config.repo` | 不存在；Excel 固定读本项目仓库 |
| `taskSource.config.source` | `taskSource.feishuCredential`（只存 ID） |
| `taskSource.config.url` | `knowledgeBase.spaceId` + `knowledgeBase.roots[]` |
| `checkRepoBinding` | 删除；结构上不再需要 |
| `pipeline` | 早已删除；新库不保留任何相关记录 |

## 3. 项目形态

### 3.1 表单分组

| 组 | 字段 | 规则 |
| --- | --- | --- |
| 基本信息 | 名称、启用开关 | 名称必填；ID 首次保存后不可改 |
| 代码仓库 | 类型（GitHub / GitLab）、仓库地址、分支、Git 凭据 | 仓库地址与分支在项目内；凭据只选引用 |
| 任务来源 | 类型二选一；位置；字段映射；飞书凭据（仅知识库） | 二选一；Excel 仓库只读 |
| 执行与调度 | 执行目录、轮询分钟、启动即跑 | 目录留空 = `<stateDir>/work` 默认 |
| 高级 | 最大重试、退避秒数、待处理/完成/失败状态 | 默认折叠 |
| 危险区 | 删除项目 | 见 8.4 |

### 3.2 任务来源二选一

- 判别联合，`kind` 只能是 `excel` 或 `feishu-wiki`。
- 切换类型时清空另一侧配置；若项目已有排队或运行中任务，先确认再切换。
- 飞书知识库必须绑定 `spaceId` + 节点 + 字段映射；Excel 不选飞书凭据。
- 项目只保存 `taskSource.feishuCredential`（知识库时），不保存任何 Secret。

### 3.3 知识库绑定

- 知识库 = 空间内的根节点集合。绑定记录保存 `spaceId` 与一组 `rootNodeToken`（默认取空间根，允许选多个目录、文档或多维表格）；递归展开后得到文档集合。
- 唯一性建在空间上：一个 `spaceId` 只能归属一个项目（含停用项目），同一空间内不同根节点不能拆给两个项目；冲突即拒绝保存。
- 归属校验：用项目所选飞书凭据对每个根节点调用 `wiki/v2/spaces/get_node`，返回的 `space_id` 必须等于绑定值；任一不符即拒绝。
- 根节点可以增删，但每次变更都要重新校验；删除根节点等于把该子树移出知识库，其任务按「消失」处理。
- 文档与多维表格在同一知识库内可有多份、可多层目录；快捷方式解析到目标节点，文件夹递归展开。
- 重置后新建的项目必须绑定知识库才能启用；未通过校验时保持停用，详情页直接定位到任务来源组。

## 4. 调度与队列

### 4.1 并发模型

- 全局 `executor.maxWorkers` 是唯一硬上限；每个项目同一时刻最多 1 个执行中任务。
- 出队顺序：全局 FIFO；队首项目已占用时跳过并继续看下一条（项目轮转），避免单项目占满。
- Worker 不是常驻进程：每个任务一个 DSH 会话，任务结束即归档。
- 执行目录按项目组织：`<executionRoot>/<project>/<ticket>`，`executionRoot` 默认 `<stateDir>/work`，项目名来自 `Project.name`。
- 项目工单的目录是**项目仓库的实际检出**，不是空目录：`prepareDirectory` 从轮询工作副本 `<stateDir>/repos/<repo>` 创建 `git worktree --detach`。轮询副本、执行工作区、`stateDir` 下的队列数据库互不共用工作树，避免任务来源同步与 worker 改动互相踩；同一工单重试时复用已有工作区。`git worktree prune` 在每次创建前清理已删除目录的元数据；工作区默认保留供排查，删除目录后下次创建会自动清掉登记。
- 准备命令 `executor.prepare` 在项目工单中**于工单工作区内执行**（此前在父目录执行），因此依赖安装落在真实检出上；准备失败时本次新建的工作区会被移除，不会在重试时被误认为已就绪。

### 4.2 状态机

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

### 4.3 停用与删除语义（已实现）

- 停用后不再轮询；`pump` 跳过停用项目的排队项，条目保留为 `queued`，恢复启用后继续。
- 运行中的任务默认继续，另提供「停止当前任务」独立动作（工单停止接口已存在，面板动作待接）。
- 删除项目：设置删除成功后调用 `ProjectScheduler.forget`，停止仍在执行的工单、取消排队项并删除该项目的全部队列记录；同时取消尚未投递的回写副作用。
- 界面仍需显示「已停用；仍有 N 个排队、M 个运行」，不能只显示一个「停用」标签。

### 4.4 可观测性

- 队列快照已有：`maxWorkers`、`used`、条目状态、尝试次数、`dueAt`、`reason`；`projects[]` 额外提供 `nextPollAt` 与 `lastError`（成功后清除），周期检查自身的错误在 `error`。
- 项目详情 `GET projects/:id/tasks` 同步携带 `nextPollAt` / `lastError`，面板显示「下次轮询」与最近错误。
- 剩余缺口：写回结果、槽位等待时长、结构化日志与请求 ID（详见 `015`）。

## 5. 凭据（两套独立功能）

### 5.1 独立边界

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

### 5.2 Git 凭据

- 类型：SSH 私钥、HTTPS 令牌；另存 `provider`（GitHub / GitLab / 通用）用于身份探测。
- 字段：名称、类型、provider、作用域说明、私钥（粘贴或本机路径）/ 令牌、HTTPS 用户名、可选口令。
- 存储：`<stateDir>/secrets/git/` 独立加密文件；只回显 `{ configured, hint: '••••abcd', fingerprint, updatedAt, revision, lastVerifiedAt }`。
- 测试：带 `repository` 时用临时私钥文件（0600）或临时 `GIT_ASKPASS` 做 `ls-remote` 探测；不带时只做材料与身份校验。临时材料在 `finally` 删除。
- 结果区分：`gitCredentialInvalid`、`gitCredentialForbidden`、`gitCredentialUnreadable`、`gitCredentialKindMismatch`、`gitRepositoryNotFound`、`gitRepositoryEmpty`、`gitNetworkUnreachable`。
- 轮换：`POST git-credentials/:id/rotate` 递增 `revision`；引用项目标记「待复验」，不自动改写项目。
- 删除：被任一项目引用（含停用）时返回 409 与引用列表，要求先改绑。

### 5.3 飞书凭据

- 身份模式：应用身份（App ID + App Secret）或 CLI 身份（lark-cli 配置）。
- 字段：名称、身份模式、App ID、App Secret、CLI 配置、作用域说明；群 / 私聊 / 候选机器人 / 准入策略放在详情的「消息接入」标签。
- 存储：`<stateDir>/secrets/feishu/` 独立加密文件；只回显 `{ mode, appIdHint, configured, hint, updatedAt, revision, lastVerifiedAt, ingressEnabled }`。
- 测试：先验应用身份（tenant access token 或 CLI 登录态），失败返回 `feishuCredentialInvalid` / `feishuCredentialExpired`；带 `spaceId` 时再验知识库权限，无权限返回 `feishuCredentialForbidden`。
- 轮换：递增 `revision`；引用项目标记「待复验」，消息接入健康状态重置。
- 删除：被项目引用或被消息接入使用时返回 409，分别列出影响范围。

### 5.4 项目选择规则

- 每个项目有且只有一个 `gitCredential`，协议必须与仓库地址一致。
- 飞书知识库项目有且只有一个 `feishuCredential`；Excel 项目不选飞书凭据。
- 项目表单只提供下拉与「新建 / 管理」链接，不内嵌凭据表单。

## 6. 任务来源

### 6.1 驱动接口

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
- `writeback` 可选；Excel 实现，飞书知识库首批只读。

### 6.2 首批驱动

| 驱动 | 位置 | 读取 | 回写 |
| --- | --- | --- | --- |
| `excel` | 本项目仓库内相对路径 + 工作表 | `.csv` / `.tsv` / `.xlsx` | 支持，沿用原子替换 |
| `feishu-wiki` | 知识空间 + 根节点集合（`spaceId` + `roots[]`） | docx 任务表、bitable 记录；文件夹递归、快捷方式解引用 | 首批只读 |

新增驱动：实现接口 → 在 `src/task-sources/index.ts` 注册 → 面板下拉自动出现 → 在 007 的模块表与测试表登记。

### 6.3 知识库模型（多文档、多层目录）

飞书知识库不等于知识空间：一个空间是一棵节点树，节点可以是文档（docx）、多维表格（bitable）、表格（sheet）、文件夹，或指向其他节点的快捷方式；`/wiki/<token>` 里的是节点 token，真正的数据对象在 `obj_token`（见 `lark-wiki` 技能文档的 node-get 返回模型）。

绑定模型：

| 字段 | 含义 |
| --- | --- |
| `spaceId` | 知识空间 ID；全库唯一归属 |
| `roots[]` | 根节点列表 `{ nodeToken, objType, title, path }`；为空表示整空间根 |
| `mode` | `space`（整空间）或 `roots`（选定子树） |

- 只有 `docx` 与 `bitable` 产生任务；`sheet`、`file` 跳过并计数；`folder` 递归；`shortcut` 解析到目标节点，并用 visited 集合防环。
- 读取链路：`wiki +node-get` 取 `space_id` / `obj_token` / `obj_type` / `has_child` → `wiki +node-list --parent-node-token` 递归（`--page-all` 分页）→ docx 读文档内容、bitable 读记录。
- 现有实现只支持「单节点 + docx」（[feishu-doc.ts:46-70](../src/task-sources/feishu-doc.ts#L46-L70) 要求 `obj_type === 'docx'`），因此多文档是新增能力，不是参数调整。
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

### 6.4 Excel 标准格式

- 默认路径是「标准工作簿」：`tasks` 表 + 固定表头（`task_id` / `title` / `status` 必填），`_meta` 表存 `schema_version`；模板可生成，校验按标准执行。
- 自定义列映射保留为高级逃生通道，不改变稳定键规则。
- 完整规范（列定义、枚举、版本化、模板、边界处理）见独立文档 `016-task-format.md`。
- 任务键：`excel:<projectId>:<repositoryPath>:<task_id>`；`task_id` 改名视为新任务。

### 6.5 字段映射与状态策略

- 字段映射（编号/标题/描述/状态/优先级）归项目任务来源；驱动给默认值，用户可覆盖。
- 待处理状态过滤、完成与失败状态写回值属于 `Project.taskPolicy`。
- 任务编号重复或缺失时整批拒绝并定位到行，不做部分导入。

## 7. 接口

### 7.1 保留与新增

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST/PUT/DELETE | `projects[/:id]` | 项目 CRUD（含内联仓库与任务来源） |
| POST | `projects/:id/run` | 手动触发一次任务同步 |
| GET | `projects/:id/tasks` | 任务与队列状态 |
| POST | `projects/repository/verify` | Git 凭据 × 仓库地址的真实探测 |
| POST | `projects/task-source/verify` | Excel 读取；飞书凭据 × 知识库归属与唯一性 |
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
| POST | `task-format/validate` | 按标准格式校验文件或知识库，返回条数与行级错误 |
| GET | `task-format/template` | 下载标准工作簿模板 |

### 7.2 删除

- `POST sources` 中的 GitHub / GitLab 分支。
- `code-repos/*`、`task-sources/*` 的 CRUD 与 verify（新库不提供这两类路由）。
- 共享的 `POST projects/verify`：拆成上面两个独立校验接口，不设统一入口。
- 设置块 `codeRepo:<id>`、`taskSource:<id>`，以及全部旧设置升级入口。
- 新增 `POST admin/reset`（仅本机回环可用，需确认令牌，见 9.2）。

### 7.3 校验契约

- 请求可携带草稿秘密（仅本次请求使用），响应永远不回显秘密。
- 校验失败返回字段级结果与独立错误码；保存时重跑同一校验，失败不落库。
- 失败文案区分：凭据无效、无权限、仓库不存在、仓库为空、网络不可达（Git）；身份无效、已过期、无权限、知识库不可读（飞书）。

## 8. 界面

### 8.1 导航

- 顶层：概览、项目、线程、工单、评估、设置。移除独立「来源」页签。
- 设置一级分组：**Git 凭据**、**飞书凭据**、**项目**、**系统**（评估/执行/提示词/部署）、**高级**（配置历史、诊断）。
- 不设统一「凭据」入口；两个凭据页互不跳转，也没有类型切换。

### 8.2 项目页

- 列表：启用状态、仓库、任务来源、运行中/排队数、待复验与待绑定标记；顶部显示全局 `used / maxWorkers`。
- 详情：配置摘要（含最终生效执行目录与两个凭据名）、任务队列（停止/重试/取消排队）、最近工单。
- 启停是详情页头的即时动作，旁注队列后果。

### 8.3 设置页

- Git 凭据：独立列表与表单；测试、轮换、引用保护、危险区删除。
- 飞书凭据：独立列表与表单；详情分「应用身份」「消息接入」两个标签；知识库不在此页配置。
- 项目：唯一业务配置入口，包含内联仓库与任务来源。
- 系统 → 高级：配置历史与诊断；不提供复用库，旧记录在重置时已清空。

### 8.4 动作与危险操作

| 动作 | 位置 | 规则 |
| --- | --- | --- |
| 保存项目 | 表单底部粘性操作条 | 保存前分别跑仓库与任务来源校验，任一失败整体拒绝 |
| 测试 | 仓库组 / 任务来源组 | 只针对已选凭据，调用各自独立接口 |
| 启停 | 项目详情页头 | 停用前说明排队与运行任务的处理方式 |
| 更换仓库/分支/凭据 | 仓库组 | 有排队或运行任务时二次确认，提示重新同步工作副本 |
| 更换知识库/飞书凭据 | 任务来源组 | 必须重新通过归属与唯一性校验 |
| 删除项目 | 危险区 | 有未结束工单时要求输入项目名确认 |
| 删除凭据 | 各自凭据页危险区 | 有引用时 409 + 影响范围，不静默级联 |

### 8.5 空状态与深链

- 无项目：提供「新建项目」；若尚无凭据，先引导创建 Git 凭据与飞书凭据。
- 无 Git 凭据 / 无飞书凭据：就地提供「去创建」，不提供内嵌秘密输入。
- 待绑定知识库：项目标记并保持停用，详情直接定位到任务来源组。
- 所有设置项支持 `?group=...&id=...` 深链。

## 9. 数据模型与重置

### 9.1 目标 schema（示意）

新库首次启动即按本节结构建表，不存在旧版本升级路径。

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
    z.object({ source: z.literal('agent') }).strict(),
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
  knowledgeBase: z.object({
    spaceId: z.string().trim().min(1), spaceName: z.string().trim().default(''),
    mode: z.enum(['space', 'roots']).default('space'),
    roots: z.array(z.object({
      nodeToken: z.string().trim().min(1), objType: z.string().trim().min(1),
      title: z.string().trim().default(''), path: z.string().trim().default(''),
    }).strict()).default([]),
  }).strict().nullable(),
  node: z.object({ url: z.string().trim().min(1), token: z.string().trim().min(1) }).strict().nullable(),
  fieldMap: TaskFieldMapSchema,
}).strict()

const ProjectTaskSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('excel'), config: ExcelConfigWithoutRepo, fieldMap: TaskFieldMapSchema }).strict(),
  FeishuWikiTaskSourceSchema,
])
```

约束：

- `git_credentials` 与 `feishu_credentials` 两张独立表，不设通用凭据表或 `type` 判别字段。
- 项目只存两个凭据 ID 与上次校验通过的 revision；轮换后 revision 不一致即「待复验」。
- `knowledgeBase.spaceId` 唯一索引（含停用项目），即一个空间只归属一个项目；每个 root 解析出的 `space_id` 必须与之一致；`roots` 为空表示整空间。
- `enabled: true` 的前置条件：Git 凭据通过当前仓库校验、飞书凭据通过知识库校验、知识库已绑定且唯一。

### 9.2 重置（不做迁移）

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

### 9.3 重置后重建示例

- `demo-tree`：新建项目 → 选 GitHub 仓库 `martinxiao2025/DemoTree`、分支 `main` → 新建 Git 凭据（SSH 路径材料）并测试通过 → 任务来源选 Excel `docs/backlog.csv` → 保存后保持停用。
- 飞书知识库项目：先建飞书凭据并测试应用身份 → 新建项目时绑定知识空间与节点 → 通过归属与唯一性校验后才能启用。
- 验收标准：从空库开始，不借助任何旧记录，完成「建凭据 → 建项目 → 测试 → 启用 → 领取一条任务」全流程。

## 10. 待拍板

以下各项本文只给推荐值与影响，不替用户决定。

1. **Git 凭据类型**：SSH 私钥 + HTTPS 令牌 + 可选的 `agent` 模式（复用本机凭据助手），是否全部保留；只做 SSH 可缩小范围。
2. **Git 凭据跨项目复用**：推荐允许，轮换标记待复验；若要求项目独占，需要在保存时强制复制。
3. **飞书消息接入位置**：推荐放在飞书凭据详情第二个标签；独立成页则需接受引用关系。
4. **飞书凭据跨项目复用**：推荐允许；知识库仍为项目专属。
5. **知识库粒度**：推荐按 `spaceId`；同一空间不同节点算同一知识库。
6. **任务来源是否严格二选一**：推荐严格；允许同时需新增多来源合并与去重规则。
7. **被引用凭据的删除策略**：推荐默认不可删 + 返回引用列表；允许强制删除则需二次确认并列出失效项目。
8. **停用后排队项如何处置**：已实现「保留 `queued`、不再派工、显示计数」；如需「停用即清空」仍需定义恢复语义。
9. **写回失败是否重试**：已实现——写入 `Effects` 持久化副作用队列，失败退避重试并进入健康度；项目被删除时取消未投递的回写。
10. **轮换后的复验时机**（新）：推荐下次项目测试或调度前复验，不允许旧凭据继续领取任务。
11. **知识库绑定单位**（新）：推荐「空间唯一归属 + 根节点集合」；若允许两个项目共享同一空间的不同子树，需改为按根集合唯一并处理重叠。
12. **跨文档重复 `task_id`**（新）：推荐默认按文档隔离，严格模式可选；若默认开启，多文档编号必须全局唯一。
13. **Excel 标准格式**（新）：推荐标准格式为默认、自定义映射仅高级；是否保留项目级切换，以及模板生成入口，见 016 第 7 节。

## 11. 旧文档处置

| 文档 | 处置 | 说明 |
| --- | --- | --- |
| [011-projects-and-scheduling.md](011-projects-and-scheduling.md) | 标记废弃，内容保留 | D1/D2/D3/D5/D6/D8–D11 仍有效并已并入本文；D4（任务来源独立记录）与 D7（设置拆两组）作废 |
| [012-settings-information-architecture.md](012-settings-information-architecture.md) | 标记废弃，内容保留 | 信息架构、双凭据、知识库绑定的细节已并入本文第 3、5、8 节；其迁移章节随本方案改为「重置」而作废 |
| [010-pipeline.md](010-pipeline.md) | 保持历史 | pipeline 已删除，仅作背景说明 |
| [009-source-records.md](009-source-records.md) | 局部过期 | 来源只剩飞书消息；Git 记录描述已不适用 |
| [005-panel.md](005-panel.md) | 局部过期 | 页签列表与设置分组以本文为准 |
| [007-architecture.md](007-architecture.md) | 继续有效 | 模块表与测试表由 `tests/docs.spec.ts` 强制与实际文件一致，改代码时必须同步 |
| 本文（013） | 权威 | 与上述冲突时以本文为准 |

## 12. 分阶段计划

| 阶段 | 内容 | 验收点 |
| --- | --- | --- |
| P0 文档与清单 | 本文 + 014 裁剪清单 + 015 差距清单；011/012 标记废弃 | `tests/docs.spec.ts` 通过；无前向链接 |
| P1 空基线与重置入口 | 最终 schema 直接建表；`reset` 命令 / `--reset-state` / 面板入口；备份与清空范围；首次启动空态 | 带数据状态执行重置：备份路径可见、旧表与目录清空、启动为空态且不读旧结构；人为中断可回滚 |
| P2 凭据基础设施 | `src/secrets/`（加密、掩码）、`git_credentials` / `feishu_credentials` 表与 CRUD、独立路由与文案 | 列表只回显掩码；越权测试返回 409；两套接口互不引用 |
| P3 项目内联 | `Project.repository` / `taskSource` 判别联合；设置块收敛；删除 `checkRepoBinding`；标准格式模板与校验入口 | 保存即校验；无 `codeRepos`/`taskSources` 选择项；重置后的空库可直接建项目；模板可生成、校验返回条数 |
| P4 校验闭环 | 两个独立 verify；真实探测仓库与知识库；错误码与文案 | 凭据无效/无权限/仓库不存在可区分；保存失败不落库 |
| P5 知识库唯一 | `spaceId` 唯一索引；归属校验；未绑定保持停用 | 两个项目绑同一空间被拒；未绑定项目无法启用 |
| P6 调度语义与界面 | 停用与排队项、写回重试、错误可见性、队列操作面；五段式导航、项目详情、深链 | 停用后不派工且提示计数；中英文文案齐全；无同名双层入口 |
| P7 裁剪收尾与端到端 | 按 014 执行删除与合并；更新 005/007/009/010；从零跑通一次完整流程 | 空库建 Git 凭据 → 建项目 → 测试 → 启用 → 领取并完成一条任务；typecheck + 测试 + build 通过；007 表与实际文件一致 |

每个阶段结束执行 `pnpm typecheck`、相关 `vitest` 用例与 `pnpm build`。重置相关的验收必须在一份带真实数据的临时 `stateDir` 上完成，不依赖任何旧结构。
