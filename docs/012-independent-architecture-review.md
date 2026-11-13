# 012 · 独立架构评审与重构方案

> 本文是一次**独立**架构分析：全部结论从源码本身读出，撰写时未参考 docs/000–011 的论述（仅按文件名定位既有文档）。
> 行号基于撰写当日的工作区状态（含 9 个未提交修改文件）。引用格式 `文件:行`，根为仓库根目录。
> 结构：§0 摘要 → §1–§6 事实层（画像/装配/模块/链路/数据流/模式/理念）→ §7 技术债 → §8 重构方案 → §9 路线图。

---

## §0 摘要

**一句话画像**：dsh-superagent 是一个 Cordis/DSH 插件包（非独立服务）——外部消息（飞书）与项目计划任务归一为 Trigger → 策略评估成 Ticket 工单 → 每张工单在独立 DSH Agent 会话 + per-ticket worktree 中执行 → 状态全量落单文件 SQLite（WAL+FULL）→ React 面板经同源回环 HTTP API 纯轮询（5s）观察操作。约 90+ 源码模块、40 个 spec；运行时依赖仅 2 个（proper-lockfile、zod），SQLite 用 node:sqlite 内建。

**设计理念 7 支柱**（§6 逐条论证）：

| # | 支柱 | 一句话 |
|---|---|---|
| 1 | 零依赖领域内核 | `core/` 只依赖 node:crypto，Ports + 双实现（SQLite/Memory）保证可替换 |
| 2 | 手写 DI + 单组合根 + 角色接口 | `Runtime` 装配一切；调用方只拿 `Pick<Engine,…>` 裁剪面 |
| 3 | 描述符注册表 | 「记录 ID 是身份，kind 只是路由」；四套 registry 驱动可插拔外设 |
| 4 | 持久化默认开启 | queue/effect/outbox 三持久表 + 启动对账；Effects 是进程内 transactional outbox |
| 5 | 串行化换正确性 | 目录锁 + SAVEPOINT 事务 + 槽位同步预留；不引入锁管理器 |
| 6 | 可诊断性与安全为契约 | 路由先于运行时挂载；凭据材料永不落明文；面板独占敏感设置 |
| 7 | 模型可见文本即版本化 API | 字符预算硬上限 + 禁词表 + 全流程演练契约测试 |

**技术债与优化方案总表**（详见 §7/§8）：

| 方案 | 对应债 | 优先级 | 预期收益 | 成本(人日) |
|---|---|---|---|---|
| R1 断 executor↔app 模块环 | D1,D3 | **P0** | 消灭仅有的两处值级环，解锁后续重构 | 1 |
| R2 凭据两域共享骨架 | D4 | **P0** | 删约 250 行同构复制，保留域隔离 | 1.5 |
| R3 Runtime 分阶段装配 | D2 | **P0** | 组合根可读可评审，装配顺序显式化 | 1 |
| R4 预检收敛单轨 | D5 | **P0** | 删三处分派样板与逐字重复 | 1 |
| R5 设置解析按修订缓存 | D8 | P1 | 消除每 15s tick/每 pump 的全量 zod parse | 0.5 |
| R6 列表查询分页下推 | D9 | P1 | 队列/线程/工单视图随量级线性可控 | 2 |
| R7 http.ts 三拆 | D6 | P1 | 新路由改动面从 474 行单文件收敛 | 0.5 |
| R8 FieldSpec 下沉共享模块 | D7 | P1 | 消除 code-repos/task-sources 对 sources 的类型反向依赖 | 0.5 |
| R9 infra 反向依赖清理 | D10 | P1 | 分层方向恢复自洽 | 0.25 |
| R10 插件出口收敛 | D11 | P1 | 入口不再暴露整个领域内核 | 0.25 |
| R11 schedule/intake 线程维护去重 | D14 | P2 | core 内一处实现线程 touch 语义 | 0.5 |
| R12 队列↔工单语义解耦 | D12 | P2 | 终态映射单一出口，反向停单契约显式化 | 2–3 |
| R13 DDL 漂移检测加固 | D13 | P2 | 生成列比对免受格式扰动 | 0.5 |
| R14 无迁移策略文档化 | — | P2 | 把自觉权衡写进面向用户的文档 | 0.1 |

取向：**激进简化优先**——优先删重复、删双轨、收敛边界，接受一次到位的改动；每项同时给出保守回退点（§8）。实施门禁统一为 `pnpm check`（typecheck + vitest + build）全绿，结构性项追加 `pnpm dev` 实机面板走查；全部现有 spec 是行为契约快照，重构以**零契约变化**为目标。

---

## §1 系统画像与装配链路

### 1.1 插件形态

- **宿主内插件，不是独立服务**：`package.json` 的 `dsh.bundle` 段声明补丁与客户端注入；`src/index.ts:11-14` 暴露 `name`/`inject`/`apply`，在宿主（DSH/Cordis）进程内注册服务（`ctx.orchestrator`，`runtime.ts:63`）与管理面板。
- **双构建入口**（tsdown）：`src/index.ts` → Node ESM 插件；`src/client/index.tsx` → 浏览器 CJS 面板（`window.__ModuleLoader__` 包装）。
- **依赖极简**：运行时依赖仅 `proper-lockfile`（状态目录锁）与 `zod`；SQLite 走 node:sqlite 内建 `DatabaseSync`（`store.ts:2`）。
- **进程模型**：单进程、多会话、多子进程。来源循环是进程内 Promise（`runtime.ts:263-276`）；飞书事件流是 spawn 的 lark-cli 长驻子进程；工单工作单元是同进程内 DSH Agent 会话；CLI/git 经 execFile 或 DSH subprocess；跨进程互斥靠目录文件锁。

### 1.2 启动时序（`src/index.ts:14-67`，按执行顺序）

1. 配置校验先于一切路由：`machineOf(config)` 拒绝未知键并指明弃用键去向（`index.ts:16` → `deployment.ts:51-65`）。
2. 禁用宿主自动设置页（`index.ts:18`）。
3. 定义重启函数 `ctx.fiber.restart()` + 重启后 `describe()` 保持表单可编辑（`index.ts:23-25`，`:22` 留有 TODO）。
4. **预挂载管理路由**：`new AdminMount(ctx, machine.stateDir)` 在 Runtime 尚不存在时即注册 `/orchestrator/api` 前缀（`index.ts:28` → `admin-mount.ts`），健康探针以启动状态回答。
5. 记录启动阶段：`record('http-registered', …)` 写 `stateDir/startup.json`（`index.ts:31-37`）。
6. 取状态目录锁（proper-lockfile，stale 30s、最多等 35s，`index.ts:40-42` → `startup.ts:71-85`）。
7. 可选一次性重置 `config.resetState`：备份后清空再按空基线启动（`index.ts:44-48`）。
8. **构造 Runtime（组合根）**：`new Runtime(ctx, machine, restart, {mount, lock})`（`index.ts:50`）——构造序见 §1.3；失败则关库放锁再抛（`runtime.ts:249-253`）。
9. 注册停机钩子（`index.ts:51`）。
10. `await runtime.ready` → `initialize()`（`runtime.ts:324-343`）：挂 HttpHost → `setup.run()` 逐记录探测 CLI 并写 shim/git 环境 → `sessions.install()` + `executor.install()` 订阅宿主事件 → 创建主会话 → 策略同步 → `executor.resume()` 对账未完工单 → `passes.start()`（2s 轮）→ `effects.start()` → `scheduler.start()`（15s tick）。
11. `runtime.startSources(ADAPTERS)`：注册内置种类，**每条来源记录一个独立 `adapter.watch()` 异步循环**（`index.ts:54` → `runtime.ts:263-276`）。
12. 成功写 `ready`；失败**不抛出**——保持路由挂载，写 `locked`/`failed` 由健康接口报告（`index.ts:57-66`）。

### 1.3 Runtime 组合根构造序（`runtime.ts:120-254`，135 行装配 15+ 协作者）

锁处理（126-135）→ `Store`（139）→ `Setup`（140-143）→ `Prompts`（147）→ masterId KV（148-149）→ `Commands`（150）→ `SecretVault`/`GitCredentials`/`FeishuCredentials`（152-156）→ 飞书 wiki/im 读取能力工厂（157-182）→ `Effects`（184）→ `SourceRegistry`（185-190）→ `Links`/`Resources`（191-196）→ `Sessions`（197-200）→ `Settings`（203-204）→ `DshExecutor`（205-207，getter 解 engine 环）→ `MasterAssessor`（208-210）→ `Outbox`（211）→ **`Engine`**（214-226，含领域事件回调：notice/followup/`ticket.ended`→`scheduler.observe`）→ `ProjectScheduler`（229-234）→ writeback 处理器注册（236）→ `Passes`（240-241）→ sourceDeps/toolHost（242-247）→ `this.ready = this.initialize()`（248）。

### 1.4 优雅停机（`runtime.ts:391-416`）

scheduler.stop → passes.stop → abort lifetime → abort 各来源循环 → assessor.stop → 取消主/工单会话（keepInbox）→ `Promise.allSettled` 等 effects.drain 与代理空闲 → executor.shutdown/dispose → sessions.dispose → 反向执行 disposers → sessionPersistence.flush → **先关库后放锁**（408-414）→ `setup.restore()` 还原 `process.env`。

### 1.5 配置三层

1. **插件配置**（SchemaMaster，`deployment.ts:18-37`）：易变项 `.volatile()` 运行时经 `Volatile<T>` 就地读（`deployment.ts:41-50`）；账号类字段变更整插件重启。
2. **用户设置**（面板编辑）：zod schema 持久化为 SQLite 版本化快照（`policy.ts` → `store.ts:217-233`），按块乐观并发（`store.ts:222` blockRevision；`settings.ts:182-206` 双重 stale 检查 + `SettingsConflict`→HTTP 409）。
3. **环境变量**：不读 .env；操作 `process.env.PATH`（垫片前置，`environment.ts:163-169`）、`PATHEXT`（`deployment.ts:196-197`）、`ComSpec`（Windows batch）；执行变量刻意避开 `KEY|PASSWORD|SECRET|TOKEN` 命名以免被 DSH 子进程剥除（`environment.ts:3`）。

---

## §2 模块划分与依赖关系

### 2.1 分层清单（行数为撰写当日实测）

| 层 | 模块（代表文件:行数） | 职责 |
|---|---|---|
| 入口 | index.ts:69、deployment.ts:386、policy.ts:260、kv.ts:47、setup.ts:61、limits.ts:17 | 插件入口、机器配置与账号解析、策略 schema 与准入、KV 键注册表、结构化 SetupError |
| **core**（零依赖内核） | model.ts:354、ports.ts:134、engine.ts:316、tickets.ts:416、evals.ts:337、assignments.ts:137、replies.ts:91、intake.ts:63、part.ts:80、errors.ts:79、stage.ts:26、ids.ts:5、memory.ts:50 | 领域模型与不变量、端口、引擎事务入口、工单/评估/分配/回复/摄入、内存双实现 |
| **app**（组合根+服务+HTTP+视图） | runtime.ts:422、http.ts:474、store.ts:391、scheduler.ts:571、settings.ts:467、setup.ts:471、sessions.ts:≈361、effects.ts:167、outbox.ts:52、passes.ts:69、assessment.ts:282、prompts/context/skill-files、notices.ts:128、cards.ts:95、links.ts、resources.ts、views/*（records.ts:209 等 7 个） | 装配、SQLite 存储、管理路由与纯函数视图、项目调度、设置、初始化预检、会话装饰、持久副作用队列、可靠出站、编排轮次、主会话评估 |
| **sources**（消息来源插件） | registry.ts:186、kind.ts:123、host.ts:78、feishu.ts:140、feishu-loops/-trigger/-read/-channel/-image、github.ts:35、gitlab.ts:35、identity.ts:19 | SourceKind 描述符契约、注册表、飞书适配全套、代码仓库类型 |
| **executor** | dsh.ts:726、background.ts | 工单执行器（槽位/事件/恢复）+ 被 6 个 app 模块反向引用的格式化函数 |
| **infra** | commands.ts:216、environment.ts:209、health.ts:35、text.ts、paths.ts:20、worker-sources.ts | 子进程封装、CLI 垫片与 git 隔离、健康看板、文本工具 |
| 外围域 | secrets/vault.ts:119、git-credentials/service.ts:226、feishu-credentials/service.ts:173、task-sources/*（index.ts:91）、code-repos/*（kind.ts:44）、projects/kind.ts:63、queue/model.ts | 加密材料存储、两套凭据服务、任务来源驱动注册表+驱动、代码仓库同步/工作树、项目 schema、队列条目模型 |
| **client**（浏览器） | index.tsx:58、app/provider/route 等 20+ 组件、api.ts:153、locales.ts、text.ts | React 面板 SPA，经 DSH 客户端 slots 注入，fetch 管理 API |

### 2.2 依赖方向（由 import 交叉验证）

```
宿主(DSH/Cordis)
  │ 加载
  ▼
index.ts ──► app/{runtime,admin-mount,startup,reset} + sources/adapters + deployment
  ▼
app/*（组合根+服务+HTTP+views+tools）
  ├─► core/*（内环，除 node:crypto 零依赖）
  ├─► policy / kv / limits / setup(错误) / admission
  ├─► infra/*
  ├─► sources/* ──► core、deployment、infra、policy、kv
  ├─► executor/* ──► core、infra、policy、projects、code-repos、app/{store,effects,sessions,notices,assessment,execution-environment}
  ├─► task-sources/* ──► core(ids)、infra、setup(错误)、limits、sources/kind(FieldSpec 类型)、code-repos(类型)
  ├─► code-repos/* ──► core(ids)、deployment、infra、secrets(类型)、sources/kind(FieldSpec 类型)
  └─► secrets / git-credentials / feishu-credentials / projects / queue
client/*（浏览器）──► navigation、app/api(仅类型)；经管理 API 与服务端通信
```

一句话：**client →(HTTP)→ app → {executor, sources, scheduler, …} → {core, policy, infra}；core 不依赖任何人。**

### 2.3 模块环实证（值级，非仅类型）

1. **环 A**：`executor/dsh.ts:22` 值级 import `resultRelay` ← `app/notices.ts`；而 `app/notices.ts:4` 值级 import `triggerMessage` ← `executor/dsh.ts`；`app/notices.ts:8` 又 import `ticketCard` ← `app/cards.ts:4`，cards 值级 import `batchLine/inputResource` ← dsh。**dsh → notices → cards → dsh 三点环**。
2. **环 B**：`executor/dsh.ts:21` import `WorktreeNameSchema` ← `app/assessment.ts`；`assessment.ts:13` import `relatedTickets` ← `cards.ts` → dsh。**dsh → assessment → cards → dsh**。
3. 另有单向但反向的引用（不构成环但层次倒置）：`app/views/records.ts:8`、`app/sessions.ts:10`、`runtime.ts:27` 均从 executor/dsh.ts 取格式化函数。

ESM 因引用都在函数体内执行而未触发 TDZ 崩溃，但这是真实的模块环（→ D1）。

---

## §3 核心调用链路

### 链路 A：项目 → 轮询入队 → 调度建单 → 执行 → 终态写回

1. 面板 `POST /orchestrator/api/projects`（`http.ts:289-292`）→ `Settings.createProject`（`settings.ts:322-329`，驱动 schema 双重校验 `settings.ts:66-75` + 知识空间唯一 `settings.ts:336-344`）→ `persistRecord` 落盘（364-376）→ 部署材料变更触发 `setup.restart()`（372-375）。
2. `ProjectScheduler.start` 每 15s tick（`scheduler.ts:62,90-101`）；tick 与手动 scan 共用 `runExclusive` 执行链防并发（132-136）。
3. `poll`：项目忙则推迟（146-151，忙判定 528-531）；否则驱动 `list` 读任务清单（161-162）→ 一个事务内 `reconcile`（167-172 → 318-365：按「任务+工作项稳定键」diff，消失取消、变更取代、新项入队）→ `store.queue.save` 落 `queue` 表；去重靠**数据库部分唯一索引** `queue_unique_active`（`store.ts:51-54,105`）。
4. `pump`（176-192）施加全局 `maxWorkers` 与同项目串行 → `dispatch`（374-402）置 `starting`，以**每次尝试新触发器** `key('trigger','schedule',entry.id,attempt)` 调 `engine.schedule`（381-393）。
5. `Engine.schedule`（`engine.ts:72-99`）单事务：get-or-create 线程 + lastAt（80-84）、构造 mandate{via:'scheduled'} 与 decision{accept}、`Tickets.create`（`tickets.ts:36-55`：`prepareTicket` 钩子→`DshExecutor.prepare` 填 execution（`dsh.ts:272-275`→`ticketExecution` 106-124）、push pending Assignment（374-379）、`executor.start`（53）→ `effects.enqueue('launch', …)`（`dsh.ts:310-312`）。
6. launch 副作用（Effects 落表后微任务分发，`effects.ts:66-71,89-93,108-127`；limit 受暂停与空闲槽位控制 `dsh.ts:266-267`）→ `launchQueued`（316-331）预留 WorkerSlots（`WorkerSlots.reserve` 同步预留，216-222）→ `launch`（474-523）：登记工单→来源映射 shim（485）、按需 `prepareDirectory`（482-308：仓库 materialize + prepare 命令 + 10min 超时，失败删脏目录不重试）、`sessions.ensure('worker-<id>')`（494）、投递首条 assignment（519-521）、`engine.assignmentStarted`（521-522）。
7. 执行回写：worker 回合/报告经宿主事件 `agent/status`、`agent/error`、`session/event`（`dsh.ts:530-565`）→ `workerIdle`（654-725）等后台静默后 `engine.turnEnded` / `engine.report`（`engine.ts:284` → `assignments` 更新工单落盘）；`ready/dropped` 报告结束工单（`tickets.ts:339-357` `end()`，emit `ticket.ended` 355）。
8. 终态→队列→外部：Runtime 的 emit 回调在 `ticket.ended` 时调 `scheduler.observe`（`runtime.ts:225`）→ `settle`（`scheduler.ts:299-312`：成功→`writeBack('done')`+`finish('succeeded')`；人停→cancelled；stage=person→停单重试 307-311；其余失败→`retry` 按项目退避 410-419）。写回是持久化副作用 `effects.enqueue('writeback', key(条目,状态,尝试))`（504-506，处理器 `runtime.ts:236`，失败退避 [5s,10min]），实际执行 `writeBackNow`（509-521，项目忙抛 `Later` 顺延不计数）。

### 链路 B：飞书消息 → 触发器 → 评估 → 工单 → worker

`runtime.startSources` 每记录一个 `adapter.watch` 循环（`runtime.ts:263-276`）→ 飞书事件流子进程逐行解析为 Trigger（feishu-loops）→ `Passes.receive`（`passes.ts:34-39`）→ `Engine.receive`（`engine.ts:66`）→ `Intake.receive`（`intake.ts:19-62`：按 `SourceScope.scope` 过滤、线程订阅 fanout 给工单、未归属者排队评估）→ 返回 `'stored'` 立即 `request()` 一轮即时轮次（`passes.ts:37`）= `effects.kick()` + `engine.evaluateDue()`（`passes.ts:63-68`）。评估由 `MasterAssessor` 经 `assessment` 副作用把候选卡片投主会话（`assessment.ts:97-105`），主会话 `orchestrator_eval*` 工具读取有界上下文并 `decide` → `Engine.decide` → accept 则 `Tickets.create`（同链路 A 第 5 步）。

### 链路 C：面板 ↔ 服务端（纯轮询，无 SSE/WS）

客户端 `caller()` 把类型化路由拼成 `fetch('/orchestrator/api/<path>')` 带 `x-orchestrator-request: '1'` 头（`client/api.ts:37-41,118-127`；类型契约 `app/api.ts`——首行注释明示「面板导入它时不会打包宿主代码」）。`usePoll`（77-108）默认 5000ms 串行轮询（promise 队列防堆积 85-98）、`document.hidden` 降频 6 倍（70,95）、`visibilitychange` 立即刷新（99-103）、响应未变跳过 setState（91）。服务端 `registerHttp` 前缀挂载 + 同源校验（`http.ts:122-127,447-449`：回环 Host + 自定义头 + Origin）；运行时未就绪时健康探针 200、其余 503 `startupPending` 带阶段诊断（453-464）；错误统一映射 400/404/409/500（129-140）。视图是服务端纯函数 JSON 投影（`views/*`，每请求构建 `Snapshot` 做请求内 memo，`records.ts:46-68`）。唯一「准实时」通道是主会话：领域事件经 `sessions.notify/relay` 的有序 `relay`/`notice` 效果注入（`runtime.ts:215-226`、`sessions.ts:108-109`）——那是 LLM 会话不是 UI。

---

## §4 数据流与状态存放

### 4.1 持久化（单文件 SQLite `orchestrator.sqlite`，`store.ts:95-135` 建表）

| 数据 | 表/文件 | 证据 |
|---|---|---|
| 领域聚合（trigger/thread/ticket/decision/disposition） | 行存 JSON + 关键字段生成列/部分索引 | `store.ts:33-55,115-123` |
| 持久化队列 | `queue` 表（seq 全局 FIFO；active/inflight/uniqueKey 生成列） | `store.ts:47-54,127,311-331` |
| 副作用队列 | `effect` 表（kind,key,seq,generation,attempts,due） | `store.ts:124-126`；`effects.ts:66-71` |
| 出站回执 | `outbox` 表（pending/sent/dropped，消息 ID 幂等） | `store.ts:351-388`；`outbox.ts:27-51` |
| 设置 | KV 表内带修订快照 + 每块修订计数（乐观并发） | `store.ts:217-233` |
| 凭据元数据 | `git_credential` / `feishu_credential` 表（**无材料**） | `store.ts:128-129,259-271` |
| 凭据材料 | `<stateDir>/secrets/{git|feishu}/<id>.json` AES-256-GCM 信封 | `vault.ts:75-103` |
| 主密钥 | `<stateDir>/secrets/key`（32B base64，首用生成，icacls 收紧 ACL） | `vault.ts:41-69` |
| 启动诊断 | `startup.json`（轮转保留 .prev） | `startup.ts:36-49` |
| 执行工作区 | `<stateDir>` 下 `项目/工单` 两级目录 + git worktree | `dsh.ts:121-123`；回收 `scheduler.ts:64-66,257-266` |

SQLite 打开即 `PRAGMA journal_mode=WAL; synchronous=FULL`、chmod 0600（`store.ts:98-99`）；schema 版本硬门禁（当前 14，不符拒开要求 reset，`store.ts:57,100-107`）。

### 4.2 仅内存态（重启即失）

调度器 nextPoll/errors/deferred（`scheduler.ts:73-76`）、WorkerSlots.starting（`dsh.ts:186`）、瞬态重试计数（245-247）、HealthBoard（`runtime.ts:103-105`）、来源链接 TextCache（107）、`Runtime.quiet` 计数（118-119）。

### 4.3 并发与恢复

- **并发模型** = 单进程单线程事件循环 + 同步事务：目录锁在开库前获取（`runtime.ts:130-135`；锁被抢占→abort lifetime，125-129）；`Store.atomic` SAVEPOINT 嵌套 + afterCommit 仅最外层提交后执行、回滚丢弃（`store.ts:174-196`，职责分工注释在 191）；`runExclusive`/`passes.pump` 合并并发调用（`scheduler.ts:132-136`、`passes.ts:56-62`）；WorkerSlots 同步预留（`dsh.ts:216-222`）。
- **恢复**：三张持久表 + 启动对账——`scheduler.recover()` 无工单的 in-flight 按失败重试、其余按工单终态结算（`scheduler.ts:286-297`，头注释「队列本身是唯一的事实来源」1-4）；`executor.resume()` 运行中分配停后台后 `assignmentInterrupted`、pending 重新入 launch 队列（`dsh.ts:577-590`）；Effects 启动后重分发（`runtime.ts:340`）。
- **幂等**：队列数据库唯一索引；效果行 `seq+generation` 匹配防旧尝试覆盖新载荷（`effects.ts:139-148`）；重试强制新触发器新工单（`scheduler.ts:381` 注释）；出站回执按消息 ID（`store.ts:366-369`）。

---

## §5 核心设计模式

| 模式 | 位置 | 解决的问题 |
|---|---|---|
| Ports & Adapters（六边形） | `core/ports.ts`（Repositories 同步端口注释 :105、Executor :59-69、Outbox :76-83、Assessor :49-53、SourceScope :12-14）；Store 实现 Repositories（`store.ts:86`）、DshExecutor 实现 Executor（`dsh.ts:241`） | 领域内核可独立测试（`core/memory.ts` 双实现）、外设可替换 |
| 角色接口（ISP） | `EngineForSources/MainSession/People/Settings/Executor` 全是 `Pick<Engine,…>`（`engine.ts:307-316`）；各 Host 接口最小 Pick（ExecutorHost `dsh.ts:66-91` 等） | 每个调用方只拿所需能力，类型层面防越权 |
| Registry ×4 | `SourceRegistry`（`registry.ts:14-30`，注册时序见 §1.2 第 11 步）；`TaskSourceRegistry`（`task-sources/index.ts:38-83`，内置驱动 13）；`CodeRepoType`（`code-repos/kind.ts:33-44`）；Effects 处理器注册表（`effects.ts:72-79` 重复注册即 throw） | 外设即插即用；「记录 ID 是身份，kind 只是路由」（`registry.ts:10-13`） |
| 组合根 + 构造注入 | `Runtime`（`runtime.ts:120-254`），getter/闭包解装配环（205,208） | 单一装配点，测试可换 Host（SchedulerHost.registry/syncRepo 可注入，`scheduler.ts:42-46`） |
| Unit of Work | Engine 每方法一个 `repo.atomic`（`engine.ts:66,72,106,…`）；Store.savepoint + afterCommit | 聚合不变量原子成立 |
| Transactional Outbox（进程内） | `Effects`（`effects.ts:47-167`）：调用方事务内 enqueue 落表→提交后分发、每类 limit()/ordered/退避/健康上报；`Later` 暂缓不计失败（5,143-145）；出站另有 receipts 回执 + `Outbox.deliver` 会话内有序（`outbox.ts:39-51`） | 副作用与领域状态同事务持久，崩溃后重试、幂等 |
| 观察者（领域事件） | `DomainEvents` 类型族（`ports.ts:86-103`）；Runtime emit 回调转主会话通知/续作提醒/调度 observe（`runtime.ts:215-226`） | 领域变化解耦驱动副作用 |
| 状态机 ×3 | 队列 queued→starting→running→终态（`queue/model.ts`）；工单阶段 `ticketStage`（`core/stage.ts`）；分配 pending→running→ended（`tickets.ts:374-382`） | 面板与调度共享一致阶段语义 |
| 乐观并发 | 设置块 revision（`settings.ts:182-206`）、凭据 revision（两 service）、提示词 baseRevision | 无锁多人编辑冲突可检测（409） |
| 单写者健康看板 | `HealthBoard.claim` 重复认领即 throw（`health.ts:19`）；条目按记录 ID 命名防互踩（`sources/identity.ts`） | 子系统故障可观测、可归因 |
| 退避轮询循环 | scheduler tick、飞书消费者、策略同步（`settings.ts:119-128`）、效果退避（`effects.ts:146-148`） | 外部系统不稳定下的韧性 |
| 版本化提示词 | `Prompts` + KV 版本快照 + baseRevision 冲突检测 | 团队文本可回滚、升级不覆盖 |

---

## §6 设计意图与架构权衡

### 6.1 七支柱的证据

1. **零依赖领域内核**：`core/` 的 import 只有 `node:crypto`（ids.ts）与 core 内部；`Repositories` 刻意全同步「以便 atomic 能包裹一个工作单元」（`ports.ts:105`）；`core/memory.ts` 与 SQLite Store 行为逐字段对齐测试（`tests/store.spec.ts`）。收益：领域规则脱离基础设施独立成立，来源/执行器/策略皆可插拔。
2. **手写 DI + 单组合根**：无 DI 容器；`Runtime` 是唯一装配点；角色接口把「谁能调什么」压进类型。作者权衡：显式装配顺序是隐式知识（→ D2），换取零框架与完全可控的初始化失败处理（`runtime.ts:249-253` 失败清理）。
3. **描述符注册表**：一个 `SourceKind` 描述符同时驱动配置校验、面板表单字段（FieldSpec）、策略准入、健康条目声明、环境变量（`sources/kind.ts:85-114`）；「记录 ID 是身份，kind 只是路由」写进注册表头注释（`registry.ts:10-13`），注册表负责按记录校准健康项归属（43-58）。
4. **持久化默认开启**：所有跨崩溃动作走 Effects——统一幂等键合并（同 kind+key 取最新载荷，`effects.ts:67-69`）、指数退避封顶（146-148）、健康上报（157-166）；「内存即时后续用 afterCommit，要扛崩溃的用 Effects」是写进 `store.ts:191` 注释的分工。
5. **串行化换正确性**：目录锁先于开库（`runtime.ts:130-135`）、同步事务包裹一切领域变更、WorkerSlots 在异步启动前同步预留（`dsh.ts:184-225` 类注释）、数据库唯一索引兜底去重（`store.ts:105`）。不引入锁管理器/消息队列中间件——正确性来自串行化。
6. **可诊断性与安全为契约**：管理路由先于运行时存在（`admin-mount.ts`；`index.ts:26-28` 注释说明动机：初始化失败也返回带阶段的 503 而非空 404，`http.ts:453-464`）；凭据「元数据 SQLite + 材料 AES-GCM 文件区」、视图只见掩码+指纹（`vault.ts:26-33`、两 service 的 view）；worker 隔离用文件系统垫片而非环境变量（DSH 会话环境无法按工单注入，`dsh.ts:484` 注释；垫片+凭据助手按「当前目录的祖先登记」选记录，`environment.ts:109-160`），作者自评「默认路径防护栏，而非操作系统级安全边界」（`environment.ts:4`）；敏感设置仅面板 origin 可改——`settings.ts:177` 注释明示这是「针对提示词注入式工具调用的防护栏」，`origin` 无默认值防隐式提权。
7. **模型可见文本即版本化 API**：字符预算硬上限 orchestrator 59,000 / worker 40,500（`tests/model-surface.spec.ts:40`，注释「缩减面向模型的文本时调低此上限」）；全工作流演练后逐项校验：工具引用合法、枚举合法、无过时术语（LEGACY 50-51）、无禁止短语（BANNED 53-58）、资源引用可读；失败清单必须与空的 `KNOWN_FAILURES` 完全一致（60）。作者认为 LLM 行为漂移主要来自提示文本漂移，须像 API 一样防回归。

### 6.2 测试与工程理念

- **Mock 只画在进程边界**：三类边界（DSH 宿主服务、CLI 子进程输出、浏览器 fetch）之外全部真实——真 SQLite、真临时目录（`tests/fixtures/host.ts:139`）、假 CLI 写成真实可执行文件跑真实子进程（`tests/fixtures/program.ts:1-4` 头注释直言动机是跨平台真实化）、CLI mock 在方法层 `vi.spyOn(Commands.prototype)`（`host.ts:142-145`）、UI 测试仅替换全局 fetch 指向实现了全部路由的内存服务器（panel-server）并自检「契约外请求」。甚至有**静态架构测试**扫描 src 保证 kv 键名只在 `kv.ts` 拼写（`tests/store.spec.ts:153-165`）。端到端占大头，因为系统价值在跨环节不变量（如「ACK 失败扣住后续结果」横跨 outbox/effects/overview）。
- **门禁收敛为一条命令**：`pnpm check` = typecheck + test + build；无 CI/Docker/eslint/prettier/husky。质量由高密度契约测试承担（40 spec 对 90+ 模块），工程配置刻意极简——与「研究原型，大量工程由编码智能体完成」的自我定位一致。

### 6.3 自觉权衡（作者注释佐证）

| 权衡 | 证据 | 取舍逻辑 |
|---|---|---|
| 不做 schema 迁移 | `store.ts:78-80` 错误文案直说「back it up and start from an empty baseline with reset」 | 简单性 > 数据寿命；单版本硬门禁消除半迁移状态 |
| 改部署材料 = 整插件重启 | `deployment.ts:17`（易变项就地读）、`settings.ts:175-176,372-375`、`index.ts:22` TODO | 用 Cordis fiber 重启换取「部署解析」单一时点语义 |
| UI 纯 5s 轮询无推送 | `client/api.ts:77-108` | 不引入 SSE/WS；隐藏页降频 + 响应比对缓解 |
| 视图全表扫描 + 每次全量 SettingsSchema.parse | `records.ts:14`、`store.ts:220` | 当前量级可接受；活跃集生成列/部分索引缓解（`store.ts:29-32`） |
| Git/飞书凭据两域互不复用 | `vault.ts:11`「两个模块各自一个目录，互不读取对方的材料」、`http.ts:52-53`「完全独立，互不读取对方的材料」 | 有意隔离（爆炸半径），代价是同构复制（→ D4） |
| 提示词注入防护是护栏不是边界 | `environment.ts:4`、`settings.ts:177` | worker 以运维者 OS 用户运行，文档诚实标注边界 |

---

## §7 技术债识别（D1–D15）

> 每项均附行号证据；严重度 = 对可维护性/正确性风险的估计。

**D1 · executor↔app 值级模块环**（严重度：高）
`dsh→notices→cards→dsh` 与 `dsh→assessment→cards→dsh`（§2.3，`dsh.ts:21-22`、`notices.ts:4`、`cards.ts:4`、`assessment.ts:13`）。当前靠 ESM 惰性求值幸免；任何把引用提到模块顶层的重构（如 const 初始化）都可能变成运行时 TDZ 错误。

**D2 · Runtime 上帝构造器**（高）
`runtime.ts:120-254`：135 行手工装配 15+ 协作者，内联闭包做事件路由（214-226），getter 解装配环（205,208）。新增服务必改此处；装配顺序是隐式知识。

**D3 · dsh.ts 双重身份：执行器 + 全局格式化库**（高）
726 行文件里，`workerSessionId:28`、`ticketOfSession:30`、`mandateInstructions:100`、`ticketExecution:106-124`、`triggerMessage:134-138`、`batchLine:140-141`、`inputResource:163`、`inputMessage:169-177` 等纯格式化函数被 notices/cards/views·records/sessions/runtime 六处反向引用——这是 D1 成环的根因，也是 dsh.ts 无法瘦身的根因。

**D4 · 凭据两域八段同构复制**（中高）
`feishu-credentials/service.ts:45-171` 与 `git-credentials/service.ts:56-225` 的 list/get/create（材料先落盘再写元数据+失败回滚）/update（revision stale）/rotate/remove（引用拒绝）/verify/record/unique/view 逐段同构；`unique()` 两处逐字相同（feishu 147-151 vs git 181-185）。域差异仅在：feishu 的 app/cli 双模式与 material()、git 的私钥规范化/metaOf/authOf/keyPath。

**D5 · 预检双轨 + 逐字重复**（中高）
- `deployment.ts:243-386` 提供 check*/resolve* 探测（注释「字段级预检复用同一组探测，避免两套口径」:280），`app/setup.ts:159-317` 另立三套字段分派样板（checkSource 159-183 / checkCodeRepo 228-247 / checkTaskSource 188-207），`task-sources/index.ts:55-79` 再一套——四处各自实现「parse schema → 按 field 循环 → invalid() 包装」。
- `checkName`：`app/setup.ts:83-89` ≈ `task-sources/index.ts:23-29`（逐字）；`checkId`：`app/setup.ts:90-95` ≈ `task-sources/index.ts:30-35`（仅 taken 来源不同）。

**D6 · http.ts 三合一**（中）
474 行同时承载 40+ zod 请求 schema（213-246）、160 余行路由表（248-414）、matcher 与错误映射（415-474）；新增一条路由要同步改 `app/api.ts` 类型与 `http.ts` 路由两处，且都在同一大文件里评审。

**D7 · 共享 UI 描述符类型寄居 sources**（中）
`FieldSpec/Localized` 定义在 `sources/kind.ts:9-23`，而 `code-repos/kind.ts:5` 与 `task-sources/kind.ts:10` 为复用而反向 import sources——两个与消息来源无关的域依赖了 sources 模块的类型面，sources 的任何类型改动都波及它们。

**D8 · SettingsSchema 每次全量 parse**（中）
`store.settings()` 每次调用 `SettingsSchema.parse` 整份快照（`store.ts:220`），而它在热路径上被反复调用：scheduler 每 15s tick 的 poll/pump/dispatch/retry/writeBack（`scheduler.ts:141,177,375,411,498`）、executor 槽位判断（`dsh.ts:264`）、`paused()`（`runtime.ts:323`）、每个视图请求。设置只在 `saveSettings`（`store.ts:224-231`）变化——存在明确的失效点，却未利用。

**D9 · 列表视图全表扫描**（中）
`page = items.slice(...)` 在内存分页（`records.ts:14`）；线程/工单列表先整表载入再切（store.threads.list()/tickets.open()）；`GET queue` 的 `snapshot()` 每 5s 拉整张 queue 表并重建全部条目视图（`scheduler.ts:203-224`）；`pump` 亦 `queue.list()` 全量（180）。活跃集索引只覆盖活跃行，历史行随时间线性增长（终态保留 30 天）。

**D10 · 杂散反向依赖**（低中）
`infra/health.ts:2` 从 `sources/host.ts` 导入 `Health` 类型（infra 应是最底层）；`feishu-credentials/kind.ts:4` 从 `git-credentials/kind.ts` 导入 `CredentialIdSchema`（与两域「互不复用」的隔离信条相悖，`vault.ts:11`）。

**D11 · 插件入口宽出口面**（低）
`index.ts:69` `export * from './core/index.ts'` + deployment 类型再导出（68）：插件入口暴露了整个领域内核，宿主与外部消费者可绕过 Engine 直接触碰 core 内部。

**D12 · 队列↔工单语义双向缠绕**（低中）
队列自称唯一事实来源（`scheduler.ts:1-4`），但工单终态反向决定队列结算（settle 299-312），且调度器按 `ticketStage` 的 person 阶段反向停单重试（307-311）——`forget` 必须靠「先停工单再清队列+迟到 observe 找不到条目」的时序约定自保（445-457，配套测试 `tests/queue.spec.ts`）。语义正确但耦合方向不单一，改动任一侧都要同时想着另一侧。

**D13 · DDL 漂移检测靠 SQL 字符串匹配**（低）
生成列定义漂移检测用 `sqlite_master.sql.includes('name definition')`（`store.ts:142-146`）——SQLite 重建表时 DDL 的空白/引号格式若与字面量不一致会误判，导致漏重建或多重建列。

**D14 · schedule 与 intake 线程维护重叠**（低）
`Engine.schedule` 80-84 与 `Intake.receive` 34-37 各自实现「get-or-create 线程 + lastAt 推进」；定时路径与消息路径的线程语义靠两处代码保持一致。

**D15 · 杂项**（低）
`Runtime.quiet` 手工 ++/-- 包裹（`runtime.ts:118-119,247`）；`client/api.ts:104` eslint-disable 压 exhaustive-deps 警告；服务端错误模板全英文而项目默认值全中文（`projects/kind.ts:58-60`：'待处理'/'已完成'/'失败'），本地化策略实际全压在客户端 locale 上。

---

## §8 优化与重构方案（R1–R14）

> 模板：问题与证据 → 方案与重构技术 → 实施步骤 → 预期收益 → 实施成本/风险/保守回退 → 验证。
> 总门禁：`pnpm check` 全绿（40 个 spec 是行为契约快照，重构以零契约变化为目标）；标注「实机」的项追加 `pnpm dev` 起 dsh web 后面板走查。取向：激进简化优先。

### R1 · 断 executor↔app 模块环（P0，对应 D1+D3）

- **问题与证据**：见 D1/D3。两处值级环 + 六处反向引用。
- **方案与重构技术**：Extract Module（搬移函数）。新建叶子模块 `src/executor/format.ts`（只依赖 core、zod 与 policy 类型），搬入纯格式化函数与常量：`workerSessionId/ticketOfSession/mandateInstructions/triggerMessage/batchLine/batchOf/inputResource/inputMessage/capped/RESUMED/RETRIED/policyMessage` 及 `WorktreeNameSchema`（从 `assessment.ts:19` 移入，assessment 反向 import）。`ticketExecution/ticketWorktreeName/projectFolderName` 留在 dsh.ts（仅执行器自用）。dsh.ts 从 format.ts re-export 或直接改引用方 import 路径——按激进取向**直接改引用方**（notices/cards/views·records/sessions/runtime/links/resources 及 `tests/model-surface.spec.ts:17,20`），不留兼容 re-export。
- **实施步骤**：① 建 format.ts 并搬函数（纯搬移，不改实现）；② grep `from '../executor/dsh.ts'` / `'./executor/dsh.ts'` 全量改到 format.ts；③ WorktreeNameSchema 移入后改 assessment.ts:19 为 import；④ 删 dsh.ts 中已搬定义。
- **预期收益**：依赖图恢复无环；dsh.ts 缩至纯执行器（约 -150 行）；后续任何 executor/app 重构不再踩 TDZ 雷区。
- **成本/风险**：1 人日；风险低（纯搬移，类型检查兜底）；保守回退：dsh.ts 临时 re-export（一次性，下个提交删）。
- **验证**：`pnpm check`；实机：面板触发器时间线/工单详情/主会话候选卡片正常（这些视图正是反向引用的消费方）。

### R2 · 凭据两域共享骨架（P0，对应 D4）

- **问题与证据**：见 D4，约 250 行同构。
- **方案与重构技术**：Form Template Method（模板方法/参数化基类）。新建 `src/secrets/credential-service.ts`，提供泛型 `CredentialService<Record, Input, View>`：注入 `{ area: SecretArea, schema, inputSchema, repository, references, classifyError, materialOf(input), complete(record, material), viewExtras(record, material) }`，承载 list/get/create/update/rotate/remove/verify 骨架与 record/unique/view。`GitCredentials`/`FeishuCredentials` 保留为薄门面：继承或组合该骨架，域特有方法（git 的 `metaOf/authOf/normalizePrivateKey`、feishu 的 `material`）留在各自文件。**两域的 vault 分区、路由、错误码、探测互不复用不变**——共享的是编排，不是身份。
- **实施步骤**：① 抽骨架（以 git 版为模板，参数化差异点）；② feishu 改为继承/组合并删除同构段；③ 两套 spec（git-credentials.spec / feishu-credentials.spec）不动，全绿即等价证明。
- **预期收益**：删约 250 行复制；未来第三种凭据域（如有）成本从「抄八段」降为「填参数」；bug 修一处两边生效。
- **成本/风险**：1.5 人日；风险中低（行为已被两套 spec 钉死，409/回滚/掩码语义逐条有测试）；保守回退：只抽 `unique/record/view/create 回滚流` 四段公共函数，其余保留。
- **验证**：`pnpm check`（重点 git/feishu-credentials.spec、vault.spec、panel-source.spec 面板文案）；实机：面板凭据增删改轮换走查。

### R3 · Runtime 分阶段装配（P0，对应 D2）

- **问题与证据**：见 D2。
- **方案与重构技术**：Extract Function + 分阶段 builder。把构造体拆为私有阶段方法：`bindLock()`（126-135）、`openStorage()`（139-150）、`buildCredentials()`（152-182）、`buildSourcesAndViews()`（185-196）、`buildSessionsAndSettings()`（197-207）、`buildDomain()`（208-241，Engine/Scheduler/writeback/Passes 含 emit 回调）、`bindTools()`（242-247）。构造函数收敛为按序调用 + `this.ready = this.initialize()`，每阶段头注释写明「必须晚于谁、为什么」。**不引入 builder 框架、不拆文件**——保持单组合根语义，只是把 135 行直线代码变成 7 个可单独评审的方法。
- **实施步骤**：① 机械提取（每段搬进方法，不改语句）；② 补阶段间不变量注释；③ `runtime.spec.ts` 全绿。
- **预期收益**：装配顺序显式化；新增协作者时评审面收敛到单阶段；初始化失败清理逻辑（249-253）不再与装配细节混排。
- **成本/风险**：1 人日；风险低（纯结构搬移，runtime.spec 1637 行覆盖启动/停机/失败路径）；保守回退：只提取 `buildDomain()`（最大段）。
- **验证**：`pnpm check`；实机：冷启动 + `resetState` + 双实例抢锁三条路径（`runtime.spec.ts:1214-1264` 对应实机行为）。

### R4 · 预检收敛单轨（P0，对应 D5）

- **问题与证据**：见 D5，四处分派样板 + 两处逐字重复。
- **方案与重构技术**：Single Source of Truth + 表驱动分派。① `checkName/checkId` 收敛到一处（建议放 `src/setup.ts` 旁的 `src/checks.ts` 或 limits.ts 旁），`task-sources/index.ts` 与 `app/setup.ts` 改为 import（`checkId` 的 taken 回调参数化，两处签名统一为 `(id, taken?)`）；② 四处分派样板（checkSource/checkCodeRepo/checkTaskSource/taskSources.verify）收敛为一个共享 `verifyFields({ schema, fields, field, probe })`：负责 schema.safeParse → invalid() 包装 → name/id/kind 短路 → 按字段循环调用各自的 `checkField` 回调；领域差异（来源/仓库/驱动各自的字段探测函数）以回调注入。`deployment.ts` 保持纯探测层不动。
- **实施步骤**：① 提取 checkName/checkId 并改两处引用；② 提取 verifyFields 骨架；③ 四个入口改为「注入字段探测回调 + 调骨架」；④ 相关 spec（deployment/sources/task-sources/code-repos + panel 预检文案）全绿。
- **预期收益**：删约 120 行样板；「新增一种可预检记录类型」从改四处降为注册回调；预检口径漂移（同一字段两处行为不一致）在结构上不可能。
- **成本/风险**：1 人日；风险中（预检是面板交互密集面，文案 code 会被 panel spec 逐字断言——搬移时**不得改任何 checkFailed/checkPassed 的 code 与 values**）；保守回退：先只做 ①（checkName/checkId 去重），②③ 分独立提交。
- **验证**：`pnpm check`；实机：新建来源/项目向导逐字段预检 + 分支列表。

### R5 · 设置解析按修订缓存（P1，对应 D8）

- **问题与证据**：见 D8。失效点唯一（`saveSettings`）。
- **方案与重构技术**：Memoization with explicit invalidation。`Store` 内缓存 `{ revision: number; value: Settings }`：`settings()` 命中 `KV.settings.revision` 当前值即返回缓存；`saveSettings` 提交后失效。注意 `saveSettings` 可在 `atomic` 内调用（`settings.ts:221-225`），失效应挂在 afterCommit 或直接在写入路径同步失效（saveSettings 自身即写者，同步失效安全）。
- **实施步骤**：① 加缓存字段与失效；② store.spec 增加「保存后读到新值、回滚后读到旧值」用例（可参照 `store.spec.ts:167` 的事务回滚用例形状）；③ 观察 runtime.spec 时长（应略降）。
- **预期收益**：每 15s tick + 每 pump + 每视图请求省一次全量 zod parse（设置快照含全部规则/来源/项目，当前每次毫秒级 × 高频）。
- **成本/风险**：0.5 人日；风险低（写路径单一；MemoryRepositories 不受影响）。
- **验证**：`pnpm check`。

### R6 · 列表查询分页下推（P1，对应 D9）

- **问题与证据**：见 D9。
- **方案与重构技术**：Push computation to storage。① `Store.threads/tickets` 增加 `(filter, offset, limit)` 重载：SQL 层 `LIMIT/OFFSET` + `COUNT`（生成列索引 `ticket.open/thread.active` 已具备过滤条件）；② `scheduler.snapshot()` 的 items 改为 `active()` + 最近 N 条终态（如 200）+ `total` 计数，Api 的 `GET queue` 增加可选 `offset/limit`；③ 视图函数从「全量→slice」改为接收已分页数据，`records.ts:14` 的 `page` 仅保留给已加载小集合；④ 面板 queue 视图加「加载更多」。
- **实施步骤**：① store 查询 + store.spec 对齐用例；② snapshot 改造 + queue.spec 适配（断言聚焦活动条目，总数走 total）；③ http/Api/面板透传。
- **预期收益**：视图成本从 O(全表) 降为 O(页)；30 天终态积累不再影响每次轮询。
- **成本/风险**：2 人日；风险中（queue 快照形状变化会触碰面板与 spec——保持字段兼容，新增字段而非改名）；保守回退：只做 queue snapshot 的「活跃 + 上限终态」截断，threads/tickets 分页缓行。
- **验证**：`pnpm check`；实机：面板队列页/线程页/工单页翻页与搜索。

### R7 · http.ts 三拆（P1，对应 D6）

- **方案与重构技术**：Extract Module。`src/app/http/` 目录：`schemas.ts`（213-246 的请求 schema + 后续新 schema）、`routes.ts`（routes 表与各视图组装函数）、`server.ts`（registerHttp/matcher/failure/sameOrigin/readBody）。`app/http.ts` 保留为出口 re-export 或直接改全部引用方（激进取向：改引用方，约 4 处 import）。`Api` 类型契约（`app/api.ts`）不动。
- **预期收益**：新路由改动面收敛；路由评审不再混入传输层细节。
- **成本/风险**：0.5 人日；风险低（http.spec 直接调用 registerHttp，接口不变）。
- **验证**：`pnpm check`；实机：任一面板请求正常（http.spec 已覆盖 403/503/404/409 矩阵）。

### R8 · FieldSpec 下沉共享模块（P1，对应 D7）

- **方案与重构技术**：Move Type。`FieldSpec/Localized/FieldBase` 移至 `src/fields.ts`（无依赖叶子）；`sources/kind.ts`、`code-repos/kind.ts`、`task-sources/kind.ts` 改 import（激进取向：不留 re-export）。
- **预期收益**：code-repos/task-sources 不再依赖 sources 的类型面；「描述符表单字段」成为与域无关的共享词汇。
- **成本/风险**：0.5 人日；风险低（纯类型搬移，typecheck 全兜）。
- **验证**：`pnpm check`。

### R9 · infra 反向依赖清理（P1，对应 D10）

- **方案**：① `Health` 类型定义移入 `infra/health.ts`（它本就是健康看板的载荷类型），`sources/host.ts` 反向 `import type`；② `CredentialIdSchema` 移入 `secrets/id.ts`（`credentialId` 已在此），`git-credentials/kind.ts` 与 `feishu-credentials/kind.ts` 都从 secrets 取——两凭据域恢复互不相识。
- **预期收益**：分层图恢复「infra 最底、域之间平权」；与作者注释声明的隔离信条一致。
- **成本/风险**：0.25 人日；风险低。
- **验证**：`pnpm check`。

### R10 · 插件出口收敛（P1，对应 D11）

- **方案**：`index.ts:69` 删除 `export * from './core/index.ts'`；先 grep 宿主侧/测试对 `src/index.ts` 出口的 core 符号引用（tests 多数直接 import `src/core/index.ts`，如 `model-surface.spec.ts:11`），仅保留确有消费的具名导出；deployment 类型再导出（:68）按需保留。
- **预期收益**：插件公共 API 面与「组合根是唯一入口」的理念一致；宿主无法绕过 Engine 触碰 core。
- **成本/风险**：0.25 人日；风险低（typecheck 即可证明无外部引用）。
- **验证**：`pnpm check` + build（dts 会暴露外部引用面）。

### R11 · schedule/intake 线程维护去重（P2，对应 D14）

- **方案**：core 内提取 `touchThread(ref, at): Thread`（get-or-create + lastAt 推进），`engine.ts:80-84` 与 `intake.ts:34-37` 改调用；intake 侧的 correlated/subscriptions 逻辑保留原处。
- **预期收益**：线程 touch 语义单一实现；未来改 lastAt 规则只改一处。
- **成本/风险**：0.5 人日；风险低（core 内部重构，store.spec 双实现行为对齐用例护航）。
- **验证**：`pnpm check`。

### R12 · 队列↔工单语义解耦设计（P2，对应 D12）

- **问题**：settle 的终态映射散在 `recover/tick/observe` 三处共用尚可，但 stage=person 反向停单（`scheduler.ts:307-311`）与 forget 的时序自保（445-457）依赖隐式约定。
- **方案**：保守版（推荐先行）：把「工单终态→队列结算」与「person 阶段→项目接管」提炼为 `settleOutcome(ticket): Settle` 纯函数并文档化为唯一出口；给 forget/迟到 observe 的时序契约补一条显式集成测试注释引用。激进版（仅在需要扩展队列语义时）：person 停单改为领域事件（`ticket.needs-person` 之类）由调度器订阅，消除调度器对 `core/stage` 的直接依赖——改动面大，需单独评审，不建议与 P0 同批。
- **预期收益**：语义单一出口 + 契约显式化；激进版解除 queue→core/stage 反向感知。
- **成本/风险**：保守 0.5 人日 / 激进 2–3 人日且风险高（触碰已测死的行为契约）；**建议先保守，激进仅立项不排期**。
- **验证**：`pnpm check`（queue.spec 既有矩阵是护栏）。

### R13 · DDL 漂移检测加固（P2，对应 D13）

- **方案**：`store.ts:142-146` 的 `sql.includes(...)` 改为「规范化后比对」：取 `sqlite_master.sql` 中该列定义片段，压缩空白/统一引号后与 `SETS` 定义比对；或干脆按「hidden 列集合 + 定义哈希存 KV」判断。加一条用例：手工建一个空白不同的同义 DDL 库，断言不误重建。
- **预期收益**：消除对 SQLite DDL 格式的脆弱耦合（升级 node/sqlite 或手工动库后不炸）。
- **成本/风险**：0.5 人日；风险低。
- **验证**：`pnpm check`。

### R14 · 无迁移策略文档化（P2）

- **方案**：不建迁移机制（契合激进简化：删复杂度优于加开关）。在 `store.ts:78-80` 错误文案已够的基础上，于面向用户的部署文档补一段「升级跨 schema 版本时的 reset 流程与数据备份位置」。
- **成本/收益**：0.1 人日；把自觉权衡从代码注释升为用户契约。
- **验证**：文档评审。

---

## §9 优先级排序与实施路线图

### 排序依据

收益/成本比 × 风险 × 依赖关系：R1 是其余结构重构的前置（断环后 R3/R7 的搬移才安全）；R2/R4 是纯删重复、契约测试密度最高、风险最低；R5/R9/R10 是小而确定的收益；R6 触碰 API 形状故排 P1 后段；R12 激进版明确缓行。

### 批次

**批次 A（P0，一次合入，约 4.5 人日）**：R1 → R3 → R2 → R4（R1 先行，为 R3 的 Runtime 搬移清障）。
门禁：`pnpm check` 全绿 + `pnpm dev` 实机走查（面板：来源页/项目向导/凭据页/工单详情/队列页；管理：冷启动、重启生效、双实例抢锁）。

**批次 B（P1，逐项独立合入，每项 ≤ 半天至 2 天）**：顺序 R9 → R10 → R5 → R8 → R7 → R6。
门禁：每项独立 `pnpm check` 全绿；R6 追加面板分页走查。各项互不依赖，可按需插队。

**批次 C（P2，择机）**：R11、R13、R14 随相关区域下次改动顺带；R12 仅做保守版（0.5 人日），激进版单独立项评审。

### 与既有任务清单的关系

本文独立成稿，未参照 docs/011 的任务清单；若采纳，建议把批次 A/B 并入 docs/011 §9.2 统一排期，避免双清单漂移。§1–§6 的事实梳理（装配时序、调用链、状态存放）可直接作为 011 的引用底稿。

### 明确不做

- 不为「未来可能的多来源」预抽抽象——现有四套 registry 已够，FieldSpec 收敛（R8）是唯一值得做的类型统一。
- 不建 schema 迁移框架（R14 维持 reset 策略）。
- 不引入 SSE/WebSocket 推送——轮询 + 降频在当前单用户面板场景下是正确权衡，量级证据出现前不动。
