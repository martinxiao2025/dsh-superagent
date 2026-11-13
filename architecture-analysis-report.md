# dsh-superagent 独立架构分析与重构方案

> 分析方法：四个独立分析线并行逐行阅读 src/ 全部 152 个源文件（约 4.7 万行 TS/TSX），交叉验证后汇总。所有结论附 `文件:行号` 证据，不依赖 docs/ 的自述（仅用于对照）。

---

## 第一部分：架构全景

### 1.1 系统定位

dsh-superagent 是一个以 DeepSeek Harness（DSH）插件包形式交付的**主动式编码智能体编排系统**：外部消息源（飞书）产生触发器，经策略评估成为工单（Ticket），每个工单在独立的 DSH Session + 独立 git worktree 中由 worker 智能体执行，终态回写任务清单（Excel/飞书 wiki/飞书群）。Web 面板提供管理界面。

### 1.2 模块划分（五大层 + 三个支撑域）

```
┌─────────────────────────────────────────────────────────┐
│ client/  (28 文件)   Web 面板：React + 自研路由 + 双 Context │
│    │  契约：import app/api.ts 的 Api 纯类型（前后端单点维护）   │
├─────────────────────────────────────────────────────────┤
│ app/  (42 文件)  编排运行时（宿主侧）                        │
│   runtime.ts 组合根 → http(40端点)/scheduler(15s轮)/        │
│   store(SQLite)/sessions(DSH会话)/effects(副作用队列)/      │
│   settings(乐观锁块)/views/tools/prompts/outbox            │
├─────────────────────────────────────────────────────────┤
│ core/  (15 文件)  纯领域内核（六边形，零基础设施依赖）           │
│   Engine 门面 → Intake/Evals/Tickets/Assignments/Replies  │
│   model.ts 领域类型 + ports.ts 六个出站端口 + memory.ts 内存实现│
├────────────────────────────┬────────────────────────────┤
│ sources/  消息来源适配       │ task-sources/  任务来源适配    │
│ (feishu三循环轮询/registry)  │ (excel/feishu-wiki/feishu-im) │
├────────────────────────────┴────────────────────────────┤
│ executor/  DSH 会话执行器 (dsh.ts 663行, Effects+Slots并发) │
│ code-repos/ 镜像同步+worktree │ git/feishu-credentials +     │
│                              │ secrets/vault (AES-GCM)      │
└────────────────────────────┴────────────────────────────┘
   infra/ (环境垫片/命令脱敏/worker调度)   index.ts/deployment.ts 入口
```

### 1.3 核心调用链路

**主链（消息 → 工单终态）**：

1. **摄入**：`feishuAdapter.watch` → `runFeishu` 三循环（实时 `lark-cli event consume` / 60s 历史补收 / 线程轮询，feishu-loops.ts:19）→ `feishuTrigger()` 归一化（feishu-trigger.ts:32，确定性 ID 三路径幂等去重）→ `Engine.receive` → `repo.atomic(Intake.receive)`（intake.ts:19-62：去重→scope 过滤→线程 fanout→无归属者入评估队列）。
2. **评估**：时钟轮 `Engine.evaluateDue`（engine.ts:126）→ `Evals.start`（evals.ts:70：防抖合并→逐候选 `policy.gate()` 求最强准入者）→ `assessor.request`（主会话 LLM 评估）→ `Engine.decide` → accept 则构造不可变 `Mandate` → `Tickets.create`（tickets.ts:36：订阅线程+确认回复+`executor.start`+事件）。
3. **执行**：`DshExecutor.launch`（dsh.ts:411：槽位预留→worktree 物化→`sessions.ensure(worker-<ticketId>)`→JSON 首消息）→ worker 智能体在工单 worktree 中工作 → `workerIdle`（dsh.ts:591）静默判定 → `engine.report('waiting')` → ready/dropped 时 `Tickets.end`。
4. **外发**：领域决策 → `Outbox.send`（原子：幂等回执 + `effects.enqueue('reply')`）→ Effects 派发 → `sendFeishu`（幂等键=message.id）。

**项目任务链**：`ProjectScheduler` 15s tick（scheduler.ts:90）→ 逐项目 `poll`（驱动 `list` → `reconcile` 入队）→ `pump`（全局 FIFO，`maxWorkers` + 同项目串行双约束，:176-192）→ `dispatch`（:379：新触发器键 `trigger/schedule/<id>/<attempt>` → `engine.schedule`）→ 终态 `writeBack` 经 effect 队列（幂等键含 attempt，:504）。

**HTTP 契约**：`/orchestrator/api` 40 个端点（http.ts:252-413），client `caller()`（client/api.ts:118）字符串路由 → fetch；视图类型全部 `ApiResponse<'GET x'>` 派生（api.ts:129-152），契约单点维护。

### 1.4 依赖关系与分层评价

分层纪律**整体良好且单向**：`client → app → core ← sources/executor`，core 通过六个端口（SourceScope/Policy/Assessor/Executor/Outbox/Repositories，ports.ts）倒置依赖，零基础设施 import（唯一例外 `node:crypto`，ids.ts:2）。循环依赖（DshExecutor↔Engine）用惰性 getter + 窄接口正确化解（runtime.ts:275,309）。

**分层破口（3 处）**：
- `app/effects.ts` 全 app 唯一持 `store.db` 直写裸 SQL 的模块（:63,:67,:81,:85,:115-148），破坏 Store 仓储封装；
- `app/resources.ts`/`views` 直达 `sources/feishu-read.ts`、`executor/format.ts` 内部实现（只读，尚可控）；
- `core/part.ts` 基类承载跨聚合原语（handBack/takeUp/queueForEval，part.ts:30-63），使 Tickets↔Evals 的协作在依赖图中不可见（tickets.ts:191 调 handBack 实为送回 Evals 领域）。

### 1.5 数据流与状态机

| 聚合 | 状态机 | 关键转换点 |
|---|---|---|
| Trigger | stored→filtered→fanout→evalId→decisionId（单调追加日志型） | intake.ts:19-62 |
| Thread | pending ⇄ evaluating（≤REQUEUES=2 次过期重排后 unavailable） | evals.ts:34-118 |
| Decision | ignore/accept/stop/unavailable（`reopen` 声明了但**无产生点**，遗留） | model.ts:191 |
| Ticket | live ⇄ ended{completed/merged/closed/dropped/stopped}；ended --人的消息 wake--> live | tickets.ts:248-266 |
| Assignment | pending→running→ended；六种 report 子状态 | model.ts:212-217 |
| QueueEntry | queued→starting→running→succeeded/failed/cancelled（退避重试） | queue/model.ts:6 |
| Mandate | 创建后**永不变更**，仅被 `Policy.revalidate` 重新校验（不可变授权） | model.ts:126 |

数据流的核心不变量：**全部 id 内容寻址**（`key()` sha256 截断，ids.ts:3）→ 天然幂等；**队列即事实**（scheduler.ts:3 注释），重启由 recover() 从 SQLite 重建；**密钥永不进配置**（设置快照只存凭据记录 ID，runtime.ts:208）。

### 1.6 核心设计模式与开发者意图

| 模式 | 位置 | 设计意图/权衡 |
|---|---|---|
| 六边形架构（端口-适配器） | core/ports.ts + memory.ts | 领域可独立测试；代价：同步仓储约定（ports.ts:105）把并发边界推给宿主 |
| 角色接口（接口隔离） | `EngineForSources` 等 Pick 类型（engine.ts:307-316） | 编译期强制最小知识，每个调用方只见所需方法 |
| **Effect 模式（泛化 Outbox）** | effects.ts：6 种副作用统一持久队列，每类独立 limit/retry/ordered/quiet；`Later` 不计失败（:143）；generation+seq 双匹配防竞态（:139） | 崩溃可续跑、健康语义精确；全库最精细的设计 |
| 注册表模式 | SourceRegistry / TaskSourceRegistry | **task-source 扩展成本接近零**（实现 Driver + 数组加一行，面板下拉/字段预检自动出现）；source 扩展需另改 deployment schema，成本更高 |
| 不可变授权 + 内容寻址 id | Mandate / key() | 策略变化不改写授权，经 PolicyEffect 输入告知工单（tickets.ts:197） |
| 乐观并发 | 设置块修订/提示词 baseRevision/policy 修订，冲突统一 409 | 多写方（面板/主会话工具/sync）并发安全 |
| 可诊断启动 | AdminMount 先挂路由 + StartupPhase + 503 结构化 payload（index.ts:28-63）→ client api.ts 消费 | "启动失败也能在 UI 讲清楚"的端到端闭环 |
| 白名单 GC | workspace-gc.ts:107-113 | 宁可留垃圾绝不误删未知目录 |
| PrepareFailed 不重试 | dsh.ts:40-45 | 宁可等人来，不把脏目录当工作区 |
| 三方草稿合并 | client/draft.tsx merge3 + revision 变基 | 多面板同时编辑设置的并发基座 |

**权衡总评**：这是一套纪律性很强的"持久化副作用队列 + 单一事实来源"架构。开发者刻意选择的代价包括：同步仓储换取事务简单；零依赖手写 xlsx（538 行 table.ts）换取"清单进 git 仓库"的最小 diff 回写；SCHEMA_VERSION 不迁移直接拒绝（store.ts:57）换取快速迭代期不背迁移包袱；正则匹配错误文本换取快速接入（现为债务）。

---

## 第二部分：技术债务清单（按严重度分级）

### P0 — 正确性/安全风险

| # | 债务 | 证据 | 影响 |
|---|---|---|---|
| 1 | **事务内端口副作用泄漏**：`executor.start` 在 atomic 提交前调用，事务回滚无法撤回端口调用 | tickets.ts:53、replies/outbox 同理；memory.ts:20-23 只回滚数据 | 崩溃/校验失败时执行器收到幽灵启动命令 |
| 2 | **dispatch 三事务非原子窗口**：save('starting')→engine.schedule→save('running') 分离；中间崩溃后 recover 按"工单未建"重试，但工单实际已在跑 | scheduler.ts:379-395（engine.schedule 是同步的，可并入同一事务）、:292-293 | 可能重复建单 |
| 3 | **日期比较双轨**：`isoTime` 失败时原样返回（model.ts:19），而 tickets.ts:86,368,370 手写 `Date.parse` 比较——非法时间串下字典序与语义序分叉 | model.ts:14-20 | 排序/去重错乱的真实 bug 面 |
| 4 | **凭据安全边界名不副实**：主密钥与密文同目录（vault.ts:40-50），实为混淆非加密；HTTPS token 经 argv 进程列表可见（git-credentials/probe.ts:24、sync.ts:65）；SSH passphrase 字段入库却从不使用（sync.ts:52-66），带口令私钥静默不可用 | vault.ts、sync.ts | 同机任意进程可解密全部凭据 |
| 5 | **飞书 API 客户端三重复制**：larkWikiApi vs httpWikiApi 五方法逐行对应（feishu-api.ts:65-178）；feishu-im-api 同病；tenant token 逻辑 3 处、BASE 常量 3 处；feishu-doc.ts 又独立实现一遍 | feishu-api.ts、feishu-im-api.ts、feishu-credentials/probe.ts | 改一个端点要改 2-3 处，漂移即出 bug |
| 6 | **错误分类靠正则猜文本**：5 处 `/permission\|403…/i` 式分类器 | feishu-im.ts:47-58、feishu-wiki.ts:46-55、feishu-credentials/service.ts:28-35、git-credentials/service.ts:41-47、dsh.ts:46-56 | 飞书文案一变，重试/健康判定即失效 |

### P1 — 性能热路径

| # | 债务 | 证据 | 影响 |
|---|---|---|---|
| 7 | **settings() 每次全量 Zod parse**：scheduler 每 tick 多次调用（pump/busy/poll/reportHealth） | store.ts:220；scheduler.ts:140,177,273 | 每 15 秒反复解析整个设置对象 |
| 8 | **调度器全表扫描**：pump/observe/snapshot/retire 都 `queue.list()` 全量解析 JSON+Zod；observe 线性 find；已有 active 部分索引未用于 list | scheduler.ts:178-180,196,205,437,530；store.ts:33-55 | 任务量增长后面板与调度同时变慢 |
| 9 | **registry.resolve 热路径重复 safeParse**：每条消息 scope 判定都重新全量解析来源配置 | sources/registry.ts:181-185 | 每消息一次冗余解析 |
| 10 | **轮询低效**：backfill 每 60s 串行整窗扫描全部群；chatNames 每 60s 全量 `--page-all`；consume 的 `chain.then` 串行化每条事件背压不可见 | feishu-loops.ts:100-109,130-174 | API 配额浪费、事件积压 |
| 11 | **面板统计查询代价**：triggerStats 全表 LEFT JOIN + json_each；search 多重无索引 LIKE | store-read.ts:14,54-57 | 大库面板卡顿 |

### P2 — 可维护性

| # | 债务 | 证据 |
|---|---|---|
| 12 | 超大文件/类：dsh.ts 663 行单类持 9 个可变 Map（dsh.ts:179-197），workerIdle 70+ 行四种职责（:591-662）；scheduler 571、runtime 508、http 474、settings 467、tickets 416、table 538 | 各文件 |
| 13 | core 非空断言密集：`threads[0]!`、`evaluating!`、`runningAssignment()!` 等 8+ 处靠隐式不变量 | model.ts:80、evals.ts:61,235、assignments.ts:50,67 等 |
| 14 | client 表单重复：VerifyRow 逐字重复两处；verify 逻辑近乎复制；checks state 模式 4 处重复；ProjectWizard 18 个 useState 手工重置 12 个 | projects.tsx:62-74,368-549、source.tsx:20-32 |
| 15 | locales.ts 1186 行单文件 ~550 键，占 client 代码 1/3；新增 check 码要 host 与 locales 两处对齐 | locales.ts、text.ts:15-20 运行时探测缺键 |
| 16 | 遗留模型噪声：`reopen` 决策无产生点、`via:'listed'`、`deliveredAt` 旧字段 | model.ts:191,253、model.ts:116,249 |
| 17 | dispatch 之外的杂项：forget 不清 3 张内存 Map（scheduler.ts:445-457）；KV sessions.prompts 修订数组无界增长（sessions.ts:344-346）；单行损坏使整个 list() 失败（store.ts:337-347）；client `<style>` 每实例重复注入（provider.tsx:106）；policyEffects 用 JSON.stringify 比较规则对象对键序敏感（policy.ts:165） | 各处 |
| 18 | 测试缺口：worker-sources 调度器脚本（字符串拼 JS）、route.parseRoute 边界、usePoll 降频/过期丢弃、重启检测状态机、thread.tsx mergeTimeline、两个凭据编辑器 UI、admin-mount 503→ApiError 端到端映射 | tests/ 81 文件盘点 |

---

## 第三部分：重构方案

### 3.1 架构层面：模块边界调整

**A. core：拆解两个巨型部件 + 显式化跨聚合协作**（对应债务 12/13）
- `tickets.ts`（416 行）按聚合切分：`Follows`（follows/threadClosed/unfinished）、`Inputs`（addInput/undelivered/hold）、`TicketLifecycle`（create/end/letGo/wake/retry）；Engine 构造处改注入（engine.ts:52）。
- `part.ts` 基类中的跨聚合原语（handBack/takeUp/queueForEval）改为显式协作接口：Evals 暴露 `handback()`，Tickets 通过构造注入的窄接口调用，依赖图恢复可见。
- 清理 `reopen`/`listed`/`deliveredAt` 遗留：POLICY_REVISION 已升 v3（policy.ts:124），做一次性状态迁移删除。

**B. app：修复三处分层破口**
- Effects 仓储化：Store 增加 `effects = {enqueue/cancel/pending/due/complete/attempt/fail/stats}`，Effects 只留调度与退避。纯搬移，接口天然成组。
- `policy.ts`（260 行）三类关注点分层：schema → `settings/schema.ts`；`settingsPolicy/gate/policyEffects` → `policy/gate.ts`；`assessmentOutcome` → `policy/assessment.ts`；规则比较改 zod parse 后深比较。
- scheduler 拆 `reconcile/dispatch/writeback` 三模块（私有方法集边界清晰）；http.ts 拆 routes-credentials/routes-queue。

**C. 集成层：统一飞书传输层**（对应债务 5，净删 200+ 行）
- 抽 `FeishuTransport { get(path, params) }` 双实现（lark CLI / HTTP），Wiki/Im API 只写一遍端点映射；tenant token 收进单一 `TokenManager`；`feishu-doc.ts` 删除或改薄封装。
- 错误分类结构化：CLI 路径也产出带 code 的 `FeishuApiError`，5 处正则分类器收敛为一个表驱动 `classify(error)`。

**D. client：抽取表单基座**
- `useFieldChecks(endpoint, buildBody)` hook + 单一 VerifyRow，消除 4 处重复；ProjectWizard 18 个 useState 收敛为单一 draft 对象；凭据表单泛型化 `CredentialForm<Draft, Input>`，顺带消灭 `as unknown as` 双重断言（git-credentials.tsx:66）。
- locales 按命名空间拆分（glossary/settings/checks/userError），加强 locales.spec 为与 SETUP_PROBLEMS/USER_ERRORS 键集合的双向 diff，把运行时缺键探测（text.ts:15-20）升级为编译期穷举。

### 3.2 代码层面：可维护性与性能优化

**正确性优先（小改动大收益）：**
1. **事务副作用收口（Command 模式）**：executor.start/stop/deliver 与 outbox.send 改为事务内收集到 `PendingEffects` 数组，Engine 在 atomic 成功后统一 flush——P0#1 一处模式修复全部泄漏点。
2. **dispatch 原子化**：`engine.schedule` 是同步的（scheduler.ts:393 无 await），直接与 save('running') 包进同一 atomic；recover 的"工单未建"分支按触发器键反查 store.triggers 防重单。
3. **日期比较统一**：提供 `before(a,b)` 工具替换三处手写 `Date.parse` 比较；`isoTime` 失败时抛错而非原样返回（model.ts:19），消灭字典序陷阱。
4. 一行级修复：forget 清 3 张 Map；KV prompts 修订封顶 50；entityValues 改单行降级（收集错误行跳过，详情页仍 fail-fast）。

**性能热路径：**
5. **设置缓存**：Store 增 `settingsCached()`，saveSettings 的 afterCommit 中失效；scheduler 每 tick 取一次传递。半天工作量，消除每 15s 的多次全量 parse。
6. **调度查询下推**：pump 改 `WHERE state='queued' AND due<=? ORDER BY seq`（active 部分索引可直接支撑）；SETS.queue 加 ticketId 生成列支撑 observe 反查。
7. registry.resolve 按设置版本号缓存；readFeishu 的 sourceOf 按 triggerId 短 TTL 缓存；chatNames 改 5 分钟或事件触发；backfill 加抖动与失败退避。
8. 面板统计预聚合：triggerStats/flow 改 KV 日增量计数器；search 限前缀/ID 精确匹配或引入 FTS5。

### 3.3 技术债务整改路径（建议顺序）

```
第 1 批（1-2 天，正确性）：事务副作用收口 → dispatch 原子化 → 日期统一
                         → 一行级杂项（forget/KV封顶/损坏行降级）
第 2 批（2-3 天，性能）：设置缓存 → 调度查询下推 → registry 缓存 → 统计预聚合
第 3 批（3-5 天，架构）：Effects 仓储化 → 飞书 Transport 统一 → 错误分类表驱动
第 4 批（5-8 天，长期）：tickets/scheduler/dsh.ts 拆分 → client 表单基座
                       → locales 拆分 → 遗留模型清理（reopen/listed 迁移）
第 5 批（docs/012 未处理事项，约 3-4 天，多为低风险搬移）：
  F1 FieldSpec/Localized 下沉 src/fields.ts 叶子模块（code-repos/task-sources 不再依赖 sources）
  F2 infra 反向依赖清理：Health 类型移 infra/health.ts；CredentialIdSchema 移 secrets/id.ts
  F3 index.ts:69 删除 export * core，插件出口收敛为具名导出
  F4 store.ts:145 DDL 漂移检测改规范化比对（压缩空白/统一引号，或定义哈希存 KV）
  F5 core 提取 touchThread(ref, at) 统一 engine.ts:78-84 与 intake.ts:34-37
  F6 提炼 settleOutcome(ticket) 纯函数作为工单终态→队列结算的唯一出口（保守版，queue.spec 护航）
  F7 层次倒置收尾：format.ts 升格为 app 层共享模块（或 dsh.ts:21 的 resultRelay 下沉），
     恢复 executor 不依赖 app 的方向
  F8 部署文档补"跨 schema 版本升级的 reset 流程与数据备份位置"
持续：补测试缺口（worker-sources 调度器、route 边界、凭据编辑器 UI、503 映射）
```

每批完成后跑 `pnpm check`（typecheck + vitest + build）；第 1、3 批涉及事务语义，改前先在 core 补齐回归测试（memory.ts 已具备内存事务基建，成本可控）。

### 3.4 各步采用的重构技术

| 步骤 | 重构技术 |
|---|---|
| 事务副作用收口 | Command 模式 + 延迟执行（收集-提交-flush） |
| tickets/scheduler/dsh.ts 拆分 | Extract Class / 模块级 Extract Function；门面保留 |
| part.ts 跨聚合原语 | 用显式接口替换隐式基类协作（Replace Implicit Collaboration with Interface） |
| Effects 仓储化 | Move Method（纯搬移，行为不变） |
| 飞书客户端统一 | 提取 Transport 抽象（Strategy）+ 删除重复实现 |
| 设置保存三处复制 | 模板方法（Form Template Method） |
| client 表单 | 提取 Hook（组合优于重复）+ 泛型组件 |
| ProjectWizard 18 state | 以对象取代多个字段（Collapse State into Object） |
| 遗留字段清理 | 一次性迁移 + 版本号递增（已有 POLICY_REVISION 机制可复用） |

---

## 第四部分：与 docs/012 独立评审的对照验证

docs/012-independent-architecture-review.md 是此前另一份独立评审（债务 D1–D15、方案 R1–R14）。我对其全部关键声明在**当前代码**上逐条验证，结果如下。

### 4.1 012 中已经实现/过时的条目（无需再做，附现势证据）

| 012 条目 | 当前状态 | 证据 |
|---|---|---|
| D1/R1 executor↔app 值级模块环（dsh→notices→cards→dsh、dsh→assessment→cards→dsh） | **已修复**：格式化函数已抽到 `executor/format.ts`（73 行），notices.ts:4、cards.ts:4、assessment.ts:14 均已改从 format.ts 导入，环已断 | src/app/notices.ts:4、cards.ts:4、assessment.ts:14 |
| D2/R3 Runtime 分阶段装配 | **已实现**：runtime.ts:129-162 已按六阶段构造（openStorage→buildCredentials→buildSources→buildSessions→buildDomain→buildSourceDeps/bindTools），失败统一回滚 | runtime.ts:129-167 |
| D4/R2 凭据两域共享骨架 | **已实现**：`secrets/credential-service.ts`（140 行）正是 R2 设计的注入式 `CredentialDomain` 泛型骨架，头注释与 R2 方案措辞一致 | secrets/credential-service.ts:1-40 |
| D5/R4 预检收敛单轨 | **大部分已实现**：checkName/checkId 已收敛到 `src/setup.ts:56-64` 单处定义，统一字段分派循环在 setup.ts:94-100；grep 全 src 不再有第二处定义 | src/setup.ts:56-100 |

### 4.2 012 提出、本报告此前未覆盖、且当前代码仍然成立的未处理事项（已并入路线图）

| 012 条目 | 内容 | 现势证据 | 并入 |
|---|---|---|---|
| D7/R8 | FieldSpec/Localized 寄居 sources/kind.ts，code-repos 与 task-sources 反向 import sources 的类型面 | code-repos/kind.ts:5 | 第 5 批 F1 |
| D10/R9 | infra 反向依赖：infra/health.ts 从 sources/host.ts 导入 Health；feishu-credentials/kind.ts 从 git-credentials/kind.ts 导入 CredentialIdSchema（违背两域隔离信条） | infra/health.ts:2、feishu-credentials/kind.ts:4 | 第 5 批 F2 |
| D11/R10 | 插件入口宽出口：index.ts:69 `export * from './core/index.ts'` 暴露整个领域内核 | src/index.ts:68-69 | 第 5 批 F3 |
| D13/R13 | DDL 漂移检测用 `sql.includes('name definition')` 字符串匹配，SQLite DDL 格式扰动即误判 | store.ts:142-146 | 第 5 批 F4 |
| D14/R11 | schedule 与 intake 各自实现"get-or-create 线程 + lastAt 推进"，线程 touch 语义双份 | engine.ts:78-84 vs intake.ts:34-37 | 第 5 批 F5 |
| D12/R12（保守版） | 工单终态→队列结算映射散在 recover/tick/observe，person 阶段反向停单与 forget 时序靠隐式约定；建议提炼 `settleOutcome(ticket)` 纯函数单一出口 | scheduler.ts:299-312、445-457 | 第 5 批 F6 |
| D9/R6（补充面） | 除我报告已列的 pump/observe 下推外：threads/tickets 列表内存分页（slice 全表）、GET queue snapshot 每 5s 全量重建视图，应做 SQL LIMIT/COUNT 下推 + API offset/limit + 面板"加载更多" | views、scheduler.ts:203-224 | 并入第 2 批 |
| D3 残留 | 模块环已断但**层次倒置仍在**：dsh.ts:21 仍从 app/notices 导入 resultRelay（executor→app 单向反向引用）；format.ts 归属 executor 却被 app 六处消费 | executor/dsh.ts:21、notices.ts:4 等 | 第 5 批 F7 |
| R14 | 无迁移策略需文档化（升级跨 schema 版本的 reset 流程与备份位置写入部署文档） | store.ts:78-80 | 第 5 批 F8 |

012 的两处取向判断本报告认同并采纳为约束：**不建 schema 迁移框架**（维持 reset 策略）、**不为未来多来源预抽抽象**；其"模型可见文本即版本化 API"支柱（字符预算 + 禁词表 + 全流程演练契约测试，tests/model-surface.spec.ts）是本报告未展开但值得保持的既有实践。

---

## 总评

dsh-superagent 是一套**完成度和纪律性都显著高于典型原型**的系统：六边形领域内核、泛化 outbox 的 Effect 队列、内容寻址幂等 id、不可变授权、乐观并发、可诊断启动，构成一个自洽且互相印证的架构故事——开发者的核心意图是"崩溃可恢复、重复可去重、失败可解释"，为此愿意付出同步仓储、零依赖 xlsx、正则错误分类等代价。主要风险集中在三处：**core 事务边界与端口副作用的缝隙**、**飞书客户端三重复制的漂移面**、以及**调度热路径的全量解析/扫描**。三者都有清晰的收敛路径，且第 1 批整改（约 2 天）即可消除全部正确性风险。

---

## 第五部分：实施记录（本报告方案已全部落地）

按本报告路线图实施完成，全程以 4 名并行队友（core/app/sources/client 域）+ 团队 Lead 执行，共享任务板 19 个任务全部收口，每项经验证（typecheck + 定向/全量 vitest + build）。

### 已完成整改（按批次）

| 批次 | 任务 | 落地结果 |
|---|---|---|
| 第 1 批 正确性 | T1 事务副作用收口 | core `Repositories.afterCommit` 端口契约 + memory 分层实现 + `defer` 包裹全部 executor/assessor 端口调用（8 处包裹点）；Store 天然满足接口 |
| | T2 日期比较统一 | `before(a,b)` 工具（NaN 回退字典序）统一 4 处比较；isoTime 经来源审计保持不抛错 |
| | T3 touchThread 去重 | 单一实现，engine/intake/part.thread 三处收敛 |
| | T4 dispatch 原子化 | 三事务收进单 atomic；recover 反查触发器按原 attempt 幂等重排；forget 清内存 Map |
| | T5 存储健壮性 | 列表单行损坏降级+日志上报（get 保持 fail-fast）；KV prompts 封顶 50 |
| 第 2 批 性能 | T6 设置缓存 | 按修订指针缓存，写者即失效点，回滚键失配自然失效 |
| | T7 查询下推 | ticketId 生成列+部分索引支撑 pump/observe/retire；GET queue 分页（total/more 只增字段）+ 面板"加载更多"；triggerStats 表达式索引实施后**以证据撤回**（破坏损坏行写入不变量），留待真实性能证据 |
| | T8 sources 优化 | registry 解析缓存、backfill 抖动退避、chatNames 降频 5min、consume 有界并发(4)+背压(200)、pollThread 突发 memo |
| 第 3 批 架构 | T9 飞书传输统一 | `FeishuTransport` 双实现 + TokenManager 单点；Wiki/Im 端点映射各写一遍；删 feishu-doc.ts 死代码（净删约 125 行） |
| | T10 错误分类表驱动 | CLI 错误结构化（解析 `(code)` 尾缀）+ `feishuFailureCode` 表驱动（status→业务码→文本），5 处分类器收敛 |
| | T11 Effects 仓储化 | Store.effects 8 方法仓储面，effects.ts 8 处裸 SQL 全消（全 app 唯一破口关闭） |
| 第 4 批 拆分 | T16 四子项 | tickets.ts 416→180 行七部件（Requeues 显式协作接口，依赖图严格无环）；scheduler 三模块+门面；dsh.ts 583→296 行五模块（9 Map 聚合 WorkerState，重试计数按 assignmentId 保鲜）；policy.ts 260→11 行三层聚合出口（ruleChanged zod 规范化深比较，消除键序敏感） |
| | T17 遗留清理 | reopen（DecisionKind+输入+卡片/SQL/前端全链）删除；via 'listed' 删除（21 处夹具，observation 变体转 bot 活路径）；deliveredAt 删除；POLICY_REVISION 不 bump（reset-only 已隔离旧库） |
| 第 5 批 | T12 小项 | FieldSpec 下沉 src/fields.ts（12 文件涟漪）；Health 整组归位 infra；CredentialIdSchema 归 secrets/id.ts（两凭据域互引消除）；index.ts 出口收敛（dts 4.71 kB）；transport 提升顶层叶子 |
| | T13 由 T16/T17 顺带覆盖 | DDL 规范化比对维持原状（T7 撤回同因缓期）；settleOutcome 出口、层次倒置收尾随 T16② ③ 落地 |
| 计划外 | T19 redact 泄漏修复 | 实施期间发现的真实缺陷：JSON/单引号包裹的 authorization 值绕过遮蔽——引号变体规则+负向先行断言修复（T18③ 副产物立项） |
| 持续 | T18 测试缺口 | ①②③④（core-dev）+⑤⑥⑦（client-dev）共 7 项全落：调度器脚本直接单测、parseRoute 边界、redact、thread-timeline、重启计数契约、凭据面板 spec、503 端到端映射 |
| | T14/T15 client | 表单基座（checks.tsx/credential-form.tsx，`as unknown as` 清零）+ locales 8 命名空间拆分+编译期穷举守卫（reason./stage./setup./userError./healthCode. 缺键即编译错） |

### 验证基线（收官）

- `pnpm typecheck` exit 0；`pnpm build` exit 0（`lib/index.d.ts` 4.71 kB）
- 全量 vitest：**1316 通过 / 13 失败**——13 个全部为既有环境性 symlink EPERM（deployment.spec 11 + environment.spec 2，本机无符号链接权限，需开发者模式或提权 shell；已用探针法逐例裁定，与本轮改动无关，`git diff` 证实相关文件未被触碰）
- docs.spec 门禁绿（所有新模块/测试文件已登记 docs/007，feishu-doc.ts 断链已修复）

### 过程沉淀（流程复盘）

1. **增量绿点纪律**：并行团队共享工作区，任何文件的中间态必须收敛到 tsc 绿再继续——本轮 3 次红灯（无效转义笔误、拆分改名中间态、重复实现）均阻塞过他人验证，最终固化为硬规则。
2. **文件操作只走 read/edit/write 工具链**：一次 pwsh 截断事故损坏 dsh.ts 工作区（git 基线还原+上下文重建+190 行为用例验证恢复）后升级为团队禁令。
3. **证据驱动回退**：T7 的 triggerStats 表达式索引实施后经测试证据证伪"零行为变化"前提即回退——偏离需报备制度的价值实证。
4. **契约快照护航**：40+ spec 的逐字断言是全部重构的安全网；唯一有意的文案变化（reopen 措辞收敛「接单」）随领域删除同步落地。
5. **环境台账**：GIT_CONFIG_GLOBAL 遗留值与 symlink 特权两类宿主干扰的判定方法（stubEnv 隔离 / 探针法）已沉淀进测试与文档。

