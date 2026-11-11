# Excel 作为工单来源的设计

> 本文件只做设计，不含实现、不改代码。所有结论都从当前仓库代码读出，引用格式为 `文件:行号`。
> 标注「判断」的是我的取舍建议，标注「待拍板」的是必须由用户决定的事项。

## 0. 结论摘要

1. **仓库里已经有「Excel → 工单」的完整链路**：来源类型 `pipeline` + `taskKind: 'excel'`（`src/pipeline/config.ts:31`、`src/pipeline/pipeline.ts:13-51`），支持 `.xlsx`/`.csv`/`.tsv`，按时间表读表、按待办状态过滤、拆成工作项、定时准入工单、自动派工，并对 `.csv`/`.tsv` 回写状态（`src/pipeline/writeback.ts:17-38`）。
2. **不需要新增与 github/gitlab/feishu 并列的 `excel` 来源类型**。判断：应把「Excel 导入工单」收敛为 `pipeline` 记录的一种用法，只补三个真实缺口：显式导入语义、行级留痕、稳定身份（见第 4、5 节）。
3. **缺口是真实的，不是文档措辞问题**：重复主键会被静默吞掉、缺表头列会让整批任务「成功导入 0 条」、`.xlsx` 无法回写、`priority` 读了但从未使用（第 3-5 节逐条给出行号）。
4. 当前 `docs/010-pipeline.md` 有 5 处描述与实现不一致（第 1.3 节）。设计以代码为准，并建议后续单独校准文档。

## 1. 现状事实

### 1.1 现有来源种类与触发方式

| 种类 | 触发方式 | 关键代码 |
| --- | --- | --- |
| `github` | 轮询通知 / Issue / PR / CI，产生 `Trigger` 后交评估 | `src/sources/github.ts`、`src/sources/adapters.ts:11` |
| `gitlab` | 轮询 Issue / MR，产生 `Trigger` | `src/sources/gitlab.ts`、`src/sources/adapters.ts:11` |
| `feishu` | 机器人事件（被 @ 或私信），产生 `Trigger` | `src/sources/feishu.ts`、`src/sources/adapters.ts:11` |
| `pipeline` | **无外部事件**，按 `intervalMinutes` 定时运行；任务清单转工单，不经过评估 | `src/pipeline/pipeline.ts:1-4,54-71`、`src/pipeline/runner.ts:165-197` |

四者共用同一条「工单 → 派工 → 执行器」链路；`pipeline` 只是第二个授权入口（`MandateBasis` 的 `scheduled` 分支，`src/core/model.ts:120-123`）。

### 1.2 现有 Excel 链路的真实结构

| 环节 | 事实 | 代码位置 |
| --- | --- | --- |
| 记录配置 | 一条 `pipeline` 记录必须指向一条 `github`/`gitlab` 记录作为代码源；`taskKind` 为 `excel` 或 `feishu` | `src/pipeline/config.ts:25-50,71-86` |
| 读取 | `.csv`/`.tsv` 自写解析；`.xlsx` 用 `node:zlib` 解 ZIP + 正则解析 XML，不引入第三方库 | `src/pipeline/excel.ts:13-22,36-58,64-153` |
| 表头 | 第一行即表头，逐列 `trim` 后作为键；表头为空的列忽略 | `src/pipeline/excel.ts:25-33` |
| 工作表 | `taskSheet` 是单个表名，空则取第一张表 | `src/pipeline/config.ts:35`、`src/pipeline/excel.ts:64-77` |
| 行 → 任务 | `title` 为空的行被**静默丢弃**；`id` 缺省时取 `row-<32 位摘要(title+description)>` | `src/pipeline/tasks.ts:42-54,100-104` |
| 状态过滤 | 状态为空，或状态在 `pendingStatuses` 中，才进入本轮 | `src/pipeline/runner.ts:91-93` |
| 拆解 | 描述里的 Markdown 复选框优先，其次编号列表（≥2 项），否则整条任务一项 | `src/pipeline/tasks.ts:56-70` |
| 准入 | `engine.schedule()` 直接创建工单：不经过策略、不经过评估；同一触发器只建一次 | `src/core/engine.ts:20-33,70-96` |
| 派工 | `Tickets.create()` 末尾立即 `executor.start()`，无需人工点开始 | `src/core/tickets.ts:49-53`、`src/executor/dsh.ts:266-268` |
| 并发 | 执行器按 `executor.maxWorkers` 限槽位；工单排队等槽 | `src/executor/dsh.ts:231-235` |
| 工单目录 | `<executionRoot>/<kebab 名称>-<工单 ID 前 12 位>`，由执行器在启动前创建，**与 Excel 无关** | `src/app/execution-environment.ts:19`、`src/executor/dsh.ts:59,98-113,249-262` |
| 状态持久化 | 运行状态与任务项状态写 KV：`pipeline-state:<记录>`、`pipeline-items:<记录>` | `src/kv.ts:64-65`、`src/pipeline/runner.ts:69-73,112-115` |
| 回写 | 只支持 `.csv`/`.tsv`；`.xlsx` 明确报「暂不支持回写」 | `src/pipeline/writeback.ts:17-38` |
| 记录变更 | 新增/删除来源记录会重启插件（U8 实测 `restarting: true`） | `src/app/settings.ts:228-238`、`verification/2026-11-10-u8-delivery.md` |
| 单实例 | 进程级状态目录锁，最多等 35 秒，锁过期 30 秒 | `src/app/startup.ts:71-85` |

### 1.3 文档与实现的差异（设计必须知道）

| `docs/010-pipeline.md` 的说法 | 代码事实 | 影响 |
| --- | --- | --- |
| `TaskSourcePort.load` 返回 `{ tasks, warnings }`（第 54 行） | 只返回 `RawTask[]`，没有 warnings | 行级问题无处留痕，第 5 节的核心缺口 |
| 「单飞锁（进程内 Promise 复用）」（第 142 行） | `watchPipeline` 是单循环顺序执行，没有 Promise 复用 | 结论仍成立（不重叠），但机制描述错误 |
| `concurrency` 与 `executor.maxWorkers` 取较小值（第 199 行） | `const limit = Math.max(1, config.concurrency)`，未与 `maxWorkers` 比较 | 实际并发可能大于执行器槽位，表现为排队而非超发 |
| 崩溃恢复 `running → queued`（第 200 行） | 工单丢失时写 `failed`，工单仍在则保持 `running` | 与文档不符，属于可接受的保守行为 |
| 去重键写作 `pipelineItem/scheduledTicket`（第 146-150 行） | 实际为 `key('pipeline-item', 记录, taskId, index)`、`key('pipeline-task', 记录, item.key)`、`key('ticket', trigger.id)` | 语义一致，名称不同 |

## 2. 归属形态：三种方案

### A. 新增来源类型 `excel`（与 github/gitlab/feishu 并列）

改动面：

- 新增 `src/sources/excel.ts` 的 `SourceKind` + `SourceAdapter`，在 `src/sources/adapters.ts:11` 登记；
- 需要自己的 `fields`、`health`、`scope`、`schema`（`src/sources/kind.ts:85-113`）；
- 面板自动出现新卡片，`POST /orchestrator/api/sources` 可创建（`src/app/settings.ts:228-238` 只校验 kind 已注册）。

优点：语义最贴「来源」；与代码源解耦，可以不绑定 GitHub 仓库。

代价：

- 与 `pipeline` 大量重复：读表、状态过滤、拆解、准入、等待、回写、KV 状态、健康；
- 「代码从哪来」仍要回答。执行器的工作目录由 `executor.prepare` 决定（`src/executor/dsh.ts:249-262`），但触发器 `source` 必须指向一条真实来源记录，否则环境变量、CLI 凭据、仓库信息都为空（`src/app/execution-environment.ts:32-45`）。所以新类型仍需引用一条 github/gitlab 记录，只是把 `codeSource` 换个名字；
- 要再维护一套「任务项状态 + 回写」状态机，两条实现会漂移。

### B. 复用并扩展 `pipeline`（判断：推荐）

改动面：

- 配置层：新增 1-2 个字段（如 `importMode: 'continuous' | 'once'`、`forceReimport` 或 `reimportOnChange`），`src/pipeline/config.ts:25-50`；
- 运行器：一次性模式（读完即停）与持续模式的循环分离，`src/pipeline/runner.ts:165-197`；
- 留痕：`TaskSourcePort` 增加 `warnings`（与 010 文档原本的设计一致），健康条目 `pipeline:tasks` 带上跳过行数与原因（`src/sources/host.ts:20-24` 已有健康码机制）；
- 身份：替换 32 位摘要为 `key()` 的 32 字节十六进制（`src/core/ids.ts:3-5` 已提供），或要求 `id` 列必填；
- 面板：现有字段自动渲染（`src/pipeline/pipeline.ts:24-50`），不需要新类型。

优点：一条实现；已可实测（`tests/pipeline.spec.ts` 覆盖解析、拆解、准入、幂等、重试、回写）；代码源、凭据、工作目录、回写都沿用现有语义。

代价：`pipeline` 的语义会从「定时流水线」扩展为「清单导入 + 定时执行」两种模式，需要把字段含义写清楚，否则用户分不清「一次导入」和「持续同步」。

### C. 独立于来源的外部工单入口

形态：新增管理路由（例如 `POST /orchestrator/api/import`）或 CLI 子命令，直接调用 `engine.schedule()`。

事实依据：`schedule` 目前只通过 `SourceContext` 暴露（`src/sources/host.ts:57-58`、`src/app/source-context.ts:50`），HTTP 层没有该路由；管理路由统一要求 `x-orchestrator-request: 1` 且校验 Host（`docs/009` 管理 API 一节）。

优点：不新增来源记录，不触发「新增记录即重启」；适合「人工偶尔导一批」。

代价：

- 绕过来源记录后，`trigger.source` 指向谁？必须仍指定一条 github/gitlab 记录，否则执行环境没有仓库与凭据（`src/app/execution-environment.ts:41`）；
- 一次性工单没有「导入历史」的归属：KV 记录挂在哪个记录下？删除记录时如何清理？
- 需要新的鉴权面与测试；
- 面板没有对应 UI，用户只能用脚本。

### 结论（判断）

- 若需求是「把 Excel 当稳定的任务清单，持续跑、结果回写」→ **B**。
- 若需求是「人工一次性导入一批，之后不再管 Excel」→ **C** 更纯粹，但要接受「仍需一条代码来源记录」和「导入历史无归属」。
- **A 不推荐**：它把 B 的实现复制一份，且仍要绑定代码来源，收益只有命名。

## 3. 表格契约

### 3.1 列映射

| 列（默认表头名） | 映射到 | 必填 | 现状 |
| --- | --- | --- | --- |
| `id` | 任务身份（不是行号） | 否（缺省用摘要） | `src/pipeline/tasks.ts:46` |
| `title` | `ticket.title`、工作项标题 | **是**（空则整行丢弃） | `src/pipeline/tasks.ts:43` |
| `description` | 触发器正文 `trigger.text`；拆解来源 | 否 | `src/pipeline/tasks.ts:45`、`src/pipeline/runner.ts:269` |
| `status` | 是否准入（`pendingStatuses`） | 否（空视为待办） | `src/pipeline/runner.ts:91-93` |
| `priority` | **未使用**（读入后没有任何消费方） | 否 | `src/pipeline/tasks.ts:48`；`runner.ts` 全文未引用 |

判断：`priority` 要么接进工单（例如写进 `scope` 或触发器 meta，`src/pipeline/runner.ts:259-272`），要么从契约里删掉。当前「读了不用」会让用户以为它生效。

### 3.2 最小示例

```markdown
| id | title | description | status |
| --- | --- | --- | --- |
| DEMO-1 | 修复首页统计口径 | 按 README 的指标定义调整 `/api/stats`，并补测试。 | 待处理 |
| DEMO-2 | 增加导出按钮 | 在报表页加导出 CSV 按钮；<br>- [ ] 前端按钮<br>- [ ] 后端接口 | todo |
```

- 第 1 行必须是表头（`src/pipeline/excel.ts:25-33`）；
- 两行会产生 2 个任务项、3 个工作项（`DEMO-2` 拆成 2 项），各自一个工单（`src/pipeline/tasks.ts:56-70`）；
- `.xlsx` 的单元格读取支持共享字符串与内联字符串（`src/pipeline/excel.ts:137-153`），公式单元格读到缓存值，读不到则为空。

### 3.3 表头识别与多工作表

- 表头按字面匹配配置里的列名（`columnId` 等，默认见 `src/pipeline/config.ts:37-41`）；大小写、空格都敏感（只做 `trim`）；
- 重名列后者覆盖前者（`src/pipeline/excel.ts:29-31`）；
- 多工作表：一条记录只能选一张表（`taskSheet` 单选）。**多表 = 多条记录**，每条记录独立代码源、独立轮询、独立健康；
- 多行 → 每行一个任务项；任务项可能再拆成多个工作项，工作项才对应工单。

## 4. 幂等与去重（最容易做错的部分）

### 4.1 现有身份链

```
任务项 key   = key('pipeline-item', 记录ID, 任务ID, 子项序号)        src/pipeline/tasks.ts:79-81
触发器 ID    = key('pipeline-task', 记录ID, 任务项 key)              src/pipeline/runner.ts:263
工单 ID      = key('ticket', 触发器 ID)                              src/core/engine.ts:73
```

三层都是内容派生的稳定哈希，**不含行号、不含文件路径、不含时间**。这是正确的方向。

### 4.2 判定表

| 场景 | 判定依据 | 现状结果 | 结论 |
| --- | --- | --- | --- |
| 同一行重复导入（文件没变） | 任务项 key 相同；KV 记录已是终态 | `plannable` 过滤掉（`src/pipeline/tasks.ts:87-94`）；即使漏过，`schedule` 也因工单已存在返回 `created: false`（`src/core/engine.ts:73-75`） | 幂等，正确 |
| 同一行内容被修改，`id` 不变 | 身份只看 `id` | 仍是同一任务项，终态记录不重跑 | 当前语义：**改了不重跑**。「修改后重新导入」需要用户拍板是否要新工单 |
| 同一行内容被修改，`id` 缺失 | 身份 = 标题+描述摘要 | 摘要变化 → 新任务项 → **新工单** | 会重复开单，且旧工单不会被清理 |
| Excel 行顺序变化 | 身份不含行号 | 无影响 | 正确 |
| 两行使用同一个 `id`（重复主键） | 两项 key 完全相同 | `plannable` 产生两项；`running` Map 与记录都以 key 索引（`src/pipeline/runner.ts:108,112-115`），第二项被覆盖；回写按 `taskId` 聚合（`src/pipeline/runner.ts:206-215`），只可能写一行 | **静默吞行，必须改为显式拒绝或跳过并留痕** |
| 无 `id` 列且两行标题+描述完全相同 | 32 位摘要相同（`src/pipeline/tasks.ts:100-104`） | 同上，被当作同一任务 | 静默吞行 |
| 32 位摘要碰撞 | 仅 32 位、非加密哈希 | 不同任务被当作同一个 | 概率低但不可解释；建议换 `key()`（256 位截 32 字符）或要求 `id` 必填 |

### 4.3 判断

- 身份必须用「记录 ID + 显式主键」；无主键时用 `key('pipeline-item', 记录, 标题, 描述)` 而不是 32 位摘要；
- 重复主键必须在读取阶段拒绝整批或逐行跳过，不能进入准入循环；
- 「内容修改是否重跑」是产品语义，不是技术细节：默认不重跑（幂等优先），需要重跑时用显式操作（例如把 `status` 改回待办、或 `forceReimport` 一次性开关），而不是靠改标题。

## 5. 错误处理

| 情况 | 现状 | 问题 | 建议（判断） |
| --- | --- | --- | --- |
| 文件不存在 / 不可读 / 无 ZIP 目录 | 抛 `TaskFileError`，本次运行失败，不产生工单（`src/pipeline/runner.ts:95-98,188-194`） | 正确 | 保持「整批拒绝」 |
| 扩展名不支持 | 明确报错（`src/pipeline/excel.ts:21`） | 正确 | 保持 |
| 工作表不存在 | 明确报错（`src/pipeline/excel.ts:75,127`） | 正确 | 保持 |
| 缺 `title` 列 / 表头拼错 | 每行 `title` 为空 → 全部丢弃 → 运行「成功」，`pipeline:tasks` 显示 0 条（`src/pipeline/tasks.ts:43,52-54`、`src/pipeline/runner.ts:94`） | **最危险**：用户看到「跑完了」但什么都没发生 | 读取前校验表头包含 `columnTitle`；缺列 → 整批失败并给出列名 |
| 单行 `title` 为空 | 静默丢弃 | 无留痕 | 逐行跳过，记录行号 + 原因，汇总进健康详情 |
| 重复主键 | 静默吞行（见 4.2） | 无留痕 | 逐行跳过 + 汇总；或整批拒绝（待拍板） |
| `status` 值不在待办集合 | 不进入本轮 | 合理，但用户不知道「为什么没跑」 | 健康里报告「已跳过 N 条非待办」，或面板展示过滤明细 |
| 数值/日期单元格 | 一律按字符串读，不做类型校验 | `priority` 无消费方，暂不影响 | 若将来接入，需定义类型错误 |
| 回写失败 | 记 `writeback-failed`，健康报错，不重跑工单（`src/pipeline/runner.ts:223-229`） | 行为正确，但 `.xlsx` 永远失败 | 明确告知 `.xlsx` 不支持回写，或实现回写（第 8 节） |

留痕位置（现有可用的）：

- 健康：`pipeline`、`pipeline:code`、`pipeline:tasks` 三项（`src/pipeline/pipeline.ts:19`；命名按 `healthNames` 规则，见 `src/sources/identity.ts`），可带 `detail`；
- 运行状态：`KV.pipeline.state(<记录>)` 的 `phase/detail`（`src/pipeline/runner.ts:69-73`）；
- 面板：来源卡片的健康摘要与最近运行；
- 不足：没有「逐行结果」的持久记录；`ItemState` 里有 `skipped`（`src/pipeline/tasks.ts:27`），但代码从未写入该状态。判断：补一个 `skipped` 记录（key 用任务项 key + 行号仅作展示），是留痕的最小改法。

## 6. 导入后的生命周期

| 问题 | 现状 | 依据 |
| --- | --- | --- |
| 导入后是否自动执行 | 是。创建工单即入队 `launch`，按 `maxWorkers` 槽位启动 | `src/core/tickets.ts:49-53`、`src/executor/dsh.ts:231-235,266-268` |
| 工单目录在哪 | `<stateDir>/work/<kebab 名>-<工单 ID 前 12 位>`；名由评估/计划给，Excel 标题不直接进目录名 | `src/app/execution-environment.ts:19`、`src/executor/dsh.ts:59,112` |
| 目录何时创建 | 派工前，由执行器的准备命令创建；导入本身不建目录 | `src/executor/dsh.ts:249-262` |
| 与源文件是否保持关联 | 只保留「记录配置里的文件路径」与任务项 KV，不保存文件快照 | `src/pipeline/config.ts:34`、`src/kv.ts:64-65` |
| Excel 后续改动是否重新导入 | 每轮重读文件；状态列改动会改变准入；已成功项不重跑 | `src/pipeline/runner.ts:86-104` |
| 源文件被移动 | 下一轮读取失败，记录进 `failed`，已有工单不受影响 | `src/pipeline/runner.ts:95-98` |
| 源文件被删除 | 同上；工单不级联删除 | 同上 |
| 记录被停用/删除 | 停止产生新工单；已有工单继续（删除有未结束工单时 409） | `docs/009` 删除一节、`src/app/settings.ts` |
| Excel 里删掉一行 | 已有工单不结束、不删除；KV 记录保留 | `src/pipeline/runner.ts:238-251` 只恢复、不清理 |

判断：**导入是「开单」，不是「镜像」**。工单一旦创建就独立于 Excel 行；Excel 后续删除某行不会停止工单。这需要明确告知用户，否则会出现「我删了任务，它还在跑」。

## 7. 运行形态与共存

### 7.1 现状

- `pipeline` 是常驻适配器，`watch` 在进程内循环（`src/pipeline/pipeline.ts:56-71`、`src/pipeline/runner.ts:165-197`）；
- 每次运行内：同步代码 → 读表 → 过滤 → 拆解 → 逐项准入 → 等待工单结束 → 回写；
- 同一记录不重叠（单循环顺序执行）；跨进程由状态目录锁保证单实例（`src/app/startup.ts:71-85`）；
- 记录增删会重启插件（U8 实测）。

### 7.2 一次性导入的两种落地（判断）

| 方式 | 改动 | 优点 | 代价 |
| --- | --- | --- | --- |
| a. 创建一条 `runOnStart` 的 `pipeline` 记录，导入后停用 | 零新代码（现有字段即可） | 立刻可用；导入有归属 | 创建记录会重启；停用后仍占一个记录；「一次性」靠人操作 |
| b. 新增 `POST /orchestrator/api/sources` 之外的 `import` 路由 | 需要把 `schedule` 暴露到 HTTP 层，新增鉴权与测试 | 可做按钮；不重启 | 新路由、新错误码、面板新 UI；导入历史仍要挂到某条记录 |

建议：先做 a，观察是否真的需要按钮。若用户要「面板上一键导入」，再评估 b。

### 7.3 与锁、状态目录的关系

- 导入必须发生在持有状态目录锁的进程内（即插件自身）；外部脚本直接写 `orchestrator.sqlite` 会破坏 KV 一致性，禁止；
- 任务项状态、运行状态都在 `stateDir` 的 KV 中（`src/kv.ts:64-65`），备份/迁移与现有状态目录一致；
- 一次性导入若走 CLI，必须通过 HTTP 管理接口，不能新开第二个进程去抢锁。

## 8. 技术选型

| 需求 | 候选 | 判断 |
| --- | --- | --- |
| 读 `.xlsx` | 现有零依赖实现（`node:zlib` + 正则，`src/pipeline/excel.ts:60-187`） | **沿用**。已覆盖共享字符串、内联字符串、列字母定位、deflate/stored；不支持 ZIP64、加密、`.xls`、样式、公式求值 |
| 读 `.xls`（BIFF8） | 需第三方库（SheetJS / exceljs） | 不支持，明确报错；若用户确有 `.xls`，让用户另存为 `.xlsx` |
| 读大文件 | 现有实现整文件读入内存 | 10 万行以内可接受；超过需流式解析（代价高，暂不做） |
| 写回 `.xlsx` | 需保留样式/合并单元格，`exceljs` 或 SheetJS 均可 | **建议不做**，保持明确报错（`src/pipeline/writeback.ts:20`）；若用户要求，需单独评估依赖体积与样式丢失 |
| 写回 `.csv`/`.tsv` | 现有原子替换（临时文件 + rename，`src/pipeline/writeback.ts:35-37`） | 保留 |

判断：不引入重型依赖。现有解析器已通过真实 xlsx 测试（`tests/pipeline.spec.ts:69`）。

## 9. 验证方式（如何证伪）

必须覆盖的场景，以及当前是否有测试：

| # | 场景 | 期望 | 现有覆盖 |
| --- | --- | --- | --- |
| 1 | 同一文件连续导入两次 | 只开一次工单 | 有（`tests/pipeline.spec.ts:172`） |
| 2 | 行顺序打乱后重新导入 | 不新开、不重复 | **缺** |
| 3 | `id` 不变、`title`/`description` 改动 | 默认不重跑；显式重跑时只开一次新工单 | **缺** |
| 4 | 两行同 `id` | 拒绝/跳过并留痕，不静默吞行 | **缺** |
| 5 | 缺 `title` 列（表头拼错） | 整批失败并指出缺哪列 | **缺**（现状静默 0 条） |
| 6 | 单行 `title` 为空 | 跳过该行并留痕，其余照常 | **缺** |
| 7 | 文件不存在 / 非 ZIP / 工作表不存在 | 本次失败、不开单、健康报错 | 部分（解析层有，运行层缺） |
| 8 | `.xlsx` 回写 | 明确报错并保留工单结果 | 部分（回写单测有 csv，xlsx 未测） |
| 9 | 重启后未完成项续跑 | 不重复开单、续等已开工单 | **缺**（`recover` 无直接测试） |
| 10 | `concurrency` 与 `maxWorkers` 交叉 | 不超发、按槽位排队 | **缺** |
| 11 | 文件被删除后工单继续 | 工单不受影响、记录报错 | **缺** |
| 12 | 多工作表切换 | 切表后按新表导入 | **缺** |

判断：第 4、5、6 条是「静默错误」，优先级最高；第 9、10 条是运行期正确性。

## 10. 待拍板（必须用户回答）

1. **「工单目录」的含义**：指「工单清单/一批工单」，还是指磁盘上的工单工作目录？本设计按前者理解。
2. **一次性还是持续**：Excel 导入一次就停，还是像现在这样按间隔持续同步？
3. **内容修改语义**：`id` 不变但标题/描述改了，默认不重跑（当前行为）是否可接受？还是要自动开新工单？
4. **回写范围**：必须回写 `.xlsx` 吗？若不必须，保持 `.csv`/`.tsv` 回写 + `.xlsx` 只读。
5. **重复主键策略**：整批拒绝，还是逐行跳过并在面板列出？
6. **是否要面板按钮**：需要「一键导入」UI，还是接受「创建记录 + runOnStart」？
7. **身份强度**：是否强制 `id` 列必填？（可消灭 32 位摘要与重复行问题）

## 11. 若实施，建议的拆分（本回合不做）

1. 读取层：表头校验 + `warnings` + 稳定身份（`src/pipeline/excel.ts`、`tasks.ts`、`task-source.ts`）；
2. 运行层：一次性/持续模式、`skipped` 留痕、健康详情（`src/pipeline/runner.ts`）；
3. 配置层：`importMode`、`forceReimport`、`priority` 的去留（`src/pipeline/config.ts`、`pipeline.ts`）；
4. 面板/接口（仅当第 10 节第 6 条答案为「要」）；
5. 测试：第 9 节第 2-12 条。

## 12. 未验证与限制

- 真实 GitHub 仓库 `martinxiao2025/Demo.ProjectOnline` 未在本机验证：`gh` 不在 PATH（`Get-Command gh` 为空），`gh auth status` 无法执行；应用生成的 `worker-bin/gh.cmd` 只是把调用转给宿主（`DeepSeek Harness.exe worker-dispatch.mjs gh`），不是真实 CLI。任何「真机全流程」都必须先安装并登录 `gh`。
- 真实模型执行未在本回合验证；上述结论来自代码与单测，不来自端到端跑通。
- `.xlsx` 回写、多账号、GitHub Enterprise 实例地址均未验证。
