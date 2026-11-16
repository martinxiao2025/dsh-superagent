# 更新日志

## Unreleased

### 文档结构收敛批次（2026-11-16）

代码进入稳定态后的第二轮文档收敛（第一轮见下方「文档收敛批次」）：方案文档按先例收官即删，
记录面收敛为「CHANGELOG（已完成）+ tasks/backlog.csv（待办）」。文档守卫（docs.spec）全绿。

- **删除 011（评审与剩余清单）、012（优化重构方案）、013（精简与连续性方案）**：三者均已收官，
  批次结论在 CHANGELOG 各条目留有完整摘要；011 §9.2 剩余任务逐项与 CHANGELOG/代码对账后迁入
  tasks/backlog.csv（新增 #9–#14：凭据注入收尾、凭据过期告警、可观测性最小集、速率限制与退避、
  飞书回写目标定案、飞书群列表实测；已关闭项不迁移）。原文见 git 历史。
- **009 瘦身为纯设计文档并更名 `009-project-design.md`**：删历史章节（审计摘要、待拍板、旧文档处置、
  分阶段计划、实施状态），定案并入正文——任务来源改为三选一（补 feishu-im 驱动）、bitable 回写已支持、
  自定义列映射已移除、接口表按实现修正（verify 路由改名、删孤立条目、补 `code-repos/branches` 与
  `feishu-im/chats`）、schema 示意清理 agent 分支；章节重排为 §0–§8，交叉引用（006/010/种子 JSON）同步。
- **007 行为规则复述收敛**：Engine 方法表与共享谓词段改为一句话目的 + 指向 001–003 的权威章节，
  消除双头维护；模块表与测试表（docs.spec 守卫的活索引）不变。
- **README 按当前架构重写**（文档目录更新为 000–010，去掉已收官批次的表述）；**新增 AGENTS.md**
  （智能体工作约定：常用命令、架构速览、测试守卫的硬规则、文档纪律）。
- **删除 `verification/2026-11-15-m0m5-smoke`**：M6 冒烟使命完成，结论已记入本文件，剩余人工步骤中
  可执行的项由 backlog #6 覆盖。
- CHANGELOG 历史条目对已删文档的链接改为纯文字（原文见 git 历史）；docs 现为 000–010 连续十一篇。

### 精简与连续性批次（docs/013，2026-11-15/16）

按 docs/013（已删除，原文见 git 历史）的 N0–N2 实施（四路并行全库审计为据，
全部结论经全仓引用计数复核）；全部 1402 例测试通过，`pnpm check` 全绿。

- **LLM 连续性与 token（N1，012 M2.5 补课）**：准入评估详述五段迁为技能
  `dsh-superagent-admission`（仅注册主会话，`skill/admission` 可团队覆盖），主会话每请求
  固定提示词 14.5k→12.7k 字符，评估细节改为按需进入上下文；评估线程窗口按线程键复用
  （TTL 10 分钟，超时重排/重启后免全量重拉）；工单转写（`ticket/<id>/transcript`）进
  TextCache，会话新事件到达即失效；预算硬档结束工单后向被截断的工作单元注入一次
  `budget_hard` 解释（幂等、不唤醒）——人继续该会话时模型知道回合为何被取消。
- **死代码清除（N0）**：policy 聚合桶 16 个死再导出、`KV.queues` 死键族、7 种无消费者的
  领域事件、若干零引用导出与死参数、客户端 57 个死 locale 键与 4 个死导出——净删约 120 行。
- **重复逻辑合并（N2）**：回写行定位（ID 优先/标题兜底/多行拒绝/CAS）与任务行校验各自
  单源化，xlsx/CSV/飞书多维表格三处共用；凭据域仓储接口与脱敏收敛到共享单源；面板
  Git/飞书凭据卡片+列表 ~250 行同构消除（`CredentialDomain` 注入）；调度器/HTTP/runtime
  的键构造、前奏与回退链收口。不采纳项及理由见 git 历史中的 docs/013 §三。

### 优化重构批次（docs/012，2026-11-15）

按 docs/012（已删除，原文见 git 历史）的 M0–M5 实施（M6 真机冒烟另行执行）；
全部 1400 例测试通过，`pnpm check`（typecheck + test + build）全绿。**注意：SCHEMA 14→15，旧状态库需 reset。**

- **各阶段模型自由定义（M1）**：工作单元全流程规范为六阶段（调查/设计/实现/验证/评审/交付，
  `core/stages.ts`），工单记录 `stage`/`stageHistory`（记录而非硬状态机）；设置新增 `models` 块
  ——角色位（编排/工作单元）+ 六阶段 + 子代理 + 工具型小模型，任何一项留空继承宿主默认；
  模型路由改为**每请求覆盖**（`agent/request` waterfall + 解析缓存），worker 按工单当前阶段解析；
  worker 新工具 `orchestrator_stage`；阶段聚焦提示词 `prompts/stages/*.md`（未声明阶段时与旧组合逐字一致）；
  面板新增「模型」分组（阶段×模型矩阵）。
- **最少 token 消费（M2/M3）**：新 `UsageMeter` 把每次模型请求的 token 结算按工单归因落账
  （`usage` 表，子代理沿父链归因，含阶段与提示词修订）；两档预算（`executor.budget`，
  项目 `execution.budget` 优先）——软档 80% 注入工作单元引导收敛并封锁新子代理、硬档 100%
  自动结束工单（调度器结算为最终失败，不重试）；只读资源 `usage`；面板概览用量区与
  工单用量行；自我升级闭环：`orchestrator_retrospective` 按提示词修订/模型/阶段聚合
  工单结果与用量，面板「按修订对比」简表——度量→改一处→再度量。
- **宿主项目自动建立与会话归类（M5）**：每个启用项目自动拥有宿主 workspace（标题=项目名，
  汇聚项目根下的人工会话）；工单 workspace 命名「<项目名> · <工单标题>」（同项目按前缀聚拢、
  搜索直达）；项目删除与工单回收时自动注销对应 workspace，宿主侧边栏不残留失效分组。
- **地基与架构收敛（M0/M4）**：SCHEMA 15（项目独立建表 `Store.projects`，项目迁出设置快照，
  `usage` 表）；删 7 处旧数据兼容死代码；`infra/win32.ts` 单源（cmd 引号/路径归一/PATHEXT，
  六处拷贝收敛 + 垫片一致性单测）；工具注册表化（`tools/definitions/`）；worker-dispatch 垫片
  模板独立成模块并加 `node --check` 测试；审计修复 8 项（查询参数 400、`/health` 免同源、
  客户端 ErrorBoundary、transient 结构化、VACUUM 参数化、队列隔离区、Setup 并行解析、
  飞书读取器缓存、xlsx 解压上限）；runtime 凭据域与客户端 projects 组件拆分；
  优化台账转 Markdown（`docs/012`），删除 xlsx 与 11 个 round 脚本。

### DSH 最佳实践对齐批次（2026-11-15）

按 DSH 官方插件实践（dsh-doc practices/compositions/tool-design）逐条对照后的优化与完善；
全部 1363 例测试通过，`pnpm check`（typecheck + test + build）全绿。

- **升级 DSH 至 0.2.2-rc.3**：`engines.dsh` 与全部 `@deepseek-ai/*` 依赖升级
  （cordis 4.1.0、schemastery 3.19.0、zod 4.6.6）；`webServer.port` 在绑定前为 undefined、
  `sessionController.inspect` 被 `events` 分页取代、`ConfigFormSnapshot.mode` 移除（可写性由 `writable` 表达）、
  `installModelSelection` 改为仅装在智能体上下文——四处 API 变更全部跟进。
- **模型预算重试投影化**（011 §9.2）：重试等待状态改为 DSH 会话投影单元
  （`modelRetryProjectionDefinition`，宿主专用无 wire 块）：注册表随已提交事件增量折叠，
  支持投影缓存检查点；`Sessions` 注册后不再手写 `session/event` 监听与快照重放
  （`RetryHealth` 类保留为可选服务缺失时的回退与单测面）。
- **会话装饰双 owner**：每个受管会话的提示词、技能、工具与限制注册包进一个
  `agent.ctx.effect()`（await 等待注册完成），智能体释放时 Cordis 自动拆除；
  插件卸载路径保留自有 disposer——两条拆除路径共用同一 LIFO 收尾。
- **Effects 精确唤醒**：`Later` 重试的再调度由 2 秒轮次心跳改为最近到期行的
  精确 `setTimeout`，重试延迟贴近设定值、心跳空转减少；`drain` 时清理定时器。
- **调度告警出口**（011 §6-2 部分关闭）：连续轮询失败与写回积压经调度器 `alert` 出口
  注入主会话（复用 `notify` 管道：同名通知合并、恢复时再次注入，不唤醒智能体）；
  面板语言包新增 `health.poll`。
- **分层收口（011 P1-9 关闭）**：部署类型权威下沉零依赖叶子 `deployment-types.ts`
  （infra 只看叶子，deployment ↔ infra 值级环断开）；`Later` 与执行目录纯函数分别下沉
  `app/later.ts`、`execution-paths.ts`（executor 不再反向依赖 app，仅剩 later 叶子）；
  `scheduler` 的 `registry`/`syncRepo` 改为宿主必传，删除模块单例回退；
  `tests/architecture.spec.ts` 静态守卫同步收紧。
- **轮询并发模型（011 P1-5 关闭）**：项目轮询改造为持久化副作用 `poll`（键为项目 ID，
  单项目串行由键去重保证；全局并发由 Effects 处理器 `limit` 决定）——tick 只投递到期轮询，
  慢项目（大仓库首次 clone）不再阻塞其他项目的轮询、建单与回写；手动 `scan` 保留同步语义。
- **预设补丁与 include 锚定规则（真机验证修复）**：最初尝试把两个预设共享的 shell/任务等待/
  压缩配置抽到 `presets-shared.yml` 由 `cordis:include` 引用；桌面版真机启动失败——bundle 补丁行
  拼进 profile 的根 include 树挂载，预设挂载时 include 的相对路径按 **profile 目录**解析，包内文件
  永远找不到。已回退为两个预设各自内联相同行（两个预设是独立的 PresetTree，同 id 行跨预设无冲突），
  并在补丁文件头记录该锚定规则与不可行的去重手段（合并键静默丢字段、整行锚点复制同 id 条目）。
- **主题令牌审计**：面板 CSS 引用的 35 个 `--dsw-*` 令牌与宿主主题包实际定义逐一比对，
  全部存在，无需 fallback。
- 007 模块表补充三个新叶子文件；011 §9.2 关闭记录同步。

### 文档收敛批次（2026-11-15）

- **原 012（独立架构评审）并入 011 后删除**：其 R1–R14 行动项经逐项核对全部消耗
  （R1/R9 随本分支分层收口关闭，R2/R7/R8/R12/R13 随 2026-11-14 批次关闭，其余在更早批次）；
  关闭证据表落在 011 §10，事实层分析原文见 git 历史。文档现为 000–011 连续十二篇，
  每篇单一职责：理念/领域/授权/执行/提示词/面板/部署/架构/手册/项目设计/任务格式/评审与剩余清单。
- 文档守卫（docs.spec：连续编号、只链更早文档、链接可解析、007 模块与测试表无重复）全绿。

### 提示词与工具定义结构化批次（2026-11-15）

对照 DSH 官方工具设计实践（tool-design.md）优化面向模型的文本：

- **提示词分段**：`work.md`（4→6 段：主动范围/线程归属/GitHub 与 PR/上下文与角色/交付流程/报告与状态）、
  `dispatch.md`（4 段：卡片与路由/结果交接/follow_up 与交回/路由纪律）、`replies.md`（3 段：purpose 与许可/
  确认/IM 长度与路由）、`admission.md`（7 段：评估入口/不可信数据/规则匹配/方向判定/视觉反馈/
  混合反馈/工单范围）由整段墙文本改为生命周期分段——逐句核对保证内容零丢失（句数=原文+新增标题）。
- **工具定义去重**（Say each fact once）：`orchestrator_reply` 的 IM 词数上限从工具描述移到
  `text` 参数描述（调用点可见的规则放在参数上）；工具描述不再与 replies 提示词重复陈述。
- 提示词总量不变（首回合 token 中性），model-surface 一致性守卫（未注册工具/枚举/词限/资源路径）全绿。

### 自我迭代升级批次（2026-11-15）

- **启动记录带版本**：`startup.json` 新增 `version` 字段（运行中的插件包版本）——版本对照的
  权威锚点；重载后与检出 `package.json` 不一致即报错。
- **新增 [scripts/self-update.mjs](../scripts/self-update.mjs)（自我迭代升级）**：link 安装的
  一步升级闭环——pull（未提交改动时拒绝）→ install → build → 重载提示（官方实践禁止脚本写
  profile 文件，重载由插件管理器或 plugin_manager 完成）→ 等待 startup.json 更新并核对版本 →
  verify-live 全绿。已实测 verify-only 与完整参数解析路径。
- **Excel 任务驱动自举**（接上批次）：仓库自带 `tasks/backlog.csv`（插件自身迭代任务清单）+
  [examples/project-seed.json](../examples/project-seed.json) 种子配置 + 010 §4.3 自举说明；
  插件的后续迭代由自己的标准格式清单驱动（吃自己的狗粮）。

### 开发调试与实机验证批次（2026-11-15）

对照 DSH 官方插件开发实践（plugin-development / verification）更新脚本与文档：

- **新增 [scripts/verify-live.mjs](../scripts/verify-live.mjs)（实机验证）**：把官方实践第 4 步
  「读安装结果 → 验证已安装能力」收敛为一条只读命令——等就绪、核对全部健康条目 ready、
  抽查 queue/prompts/overview 接口、报告落盘 `.artifacts/verify-live-<profile>.json`；
  多实例并存时取最新 startup.json（打印候选），pid 已死的残留记录自动过滤；
  退出码 0/1 便于脚本化。已在桌面实例与开发实例上实测通过。
- **[scripts/dev-web.mjs](../scripts/dev-web.mjs) 就绪诊断**：启动阶段每次变化实时打印
  （`locked`/`failed` 与 detail），超时失败打印启动记录的阶段、详情与异常摘要，不再只报超时。
- **006「开发与调试」按官方实践重写**：两条实机回路明确为「推荐：开发实例」与
  「真实 profile：重挂载 + 热启用」；新增热启用步骤（插件管理器 disable→enable，
  `application: applied` 为生效权威信号，不重启宿主应用、不中断会话）与
  「实机验证（verify-live）」一节；实测陷阱补充 include 锚定规则（预设内 include 按
  profile 目录解析，包内文件引用不到，共享行只能内联）；安装命令的 DSH 版本钉更新为 0.2.2-rc.3。
- **README** 开发节同步热启用与 verify-live 用法。

### 开发调试清理（2026-11-14）

- **巨石测试拆分收尾**（011 §9.2 第 9 项最后一项）：`core-engine.spec.ts`（1614 行 / 113 例）按主题
  拆为 `engine-eval`（评估与扇出、恢复停止、交回与上下文线程，54 例）/ `engine-reports`（报告与结果、
  票据命令，25 例）/ `engine-reviews`（跨版本评估与缺口复核，17 例）/ `engine-reads`（worker 读取判定
  复核，17 例）四个 spec + `fixtures/engine.ts` 共享引擎夹具（内存仓库、桩执行器/评估器、受控时钟）；
  用例逐字保留，零行为变化。
- **删除调试取证目录与工作文档**：`verification/`（10 个日期目录的实测脚本、JSON/JPG 证据与 README）
  与 `.trae/documents/`（7 份 U4–U7 工作文档）整体移出仓库；其中被单测引用的统一直连 SDK 迁为
  [tests/fixtures/direct-connect.ts](tests/fixtures/direct-connect.ts)，`tests/direct-connect.spec.ts`
  改从新位置导入。实测脚本按需放在工作目录、不入库；实测结论保留在 CHANGELOG 各版本节。
- **006「开发与调试」按 DSH 插件开发规范简化**：明确回路只有单测（`pnpm check`）与实机两条、
  先单测后实机；收敛「HMR 热重载」「dsh-debug-mode」两节为「已评估、未采用」；删除已失效的
  Cordis HMR 教程链接与重复的 `dsh web` 命令展示；新增「直连实测（管理 API）」节，指向
  `tests/fixtures/direct-connect.ts` 作为临时实测脚本的复用客户端。
- 009/011 对 `verification/` 目录的引用改为指向 CHANGELOG 各版本节的实测结论；007 测试表同步拆分后的
  engine spec 行。

### 调度可靠性批次（2026-11-14）

- **轮询并发**：一轮检查内的项目轮询改为有界并发池（并发 4），慢项目（大仓库首次 clone）不再阻塞其他项目的轮询与建单；单项目失败不中断同批。单项目串行与互斥语义不变（忙项目推迟、scan/tick 共用执行链）。
- **到期抖动**：下次轮询时间按间隔 ±10% 抖动，避免全部项目在同一时刻集中打远端；启动 `nextPoll` 同样带抖动。
- **git 超时拆分**：部署配置新增 `gitTimeoutMs`（默认 600s，独立于 CLI 的 `commandTimeoutMs` 90s）；项目新增 `execution.gitTimeoutSeconds` 覆盖（0=沿用全局），大仓库首次 clone 按项目放宽。
- **项目级 prepare**：项目新增 `execution.prepare`，在项目仓库检出到工单目录后、会话启动前运行（典型用途安装项目依赖）；全局 `executor.prepare` 只对无仓库工单兜底，避免多项目共享缓存互相污染。面板向导与编辑表单同步暴露 `prepare` 与 `gitTimeoutSeconds`。
- 修复 `worker-sources.spec.ts` 对含空条目的本机 PATH 逐字比较导致的环境性失败。

### 存储与结构（2026-11-14）

- **DDL 漂移检测加固**：生成列定义比对改为规范化（折叠空白、去双引号）后的子串匹配；删除漂移列时先清理所有引用它的索引（如 `queue_unique_active`），不再受 SQLite 重建时 DDL 格式扰动影响。
- **settleOutcome 提取**：「工单终态 → 队列结算」映射收敛为纯函数 `settleOutcome`（返回动作数据），recover/observe/settle 共用唯一出口。
- **http.ts 三拆**：按职责拆为 `http/routes.ts`（路由表与视图组装、`HttpHost`）、`http/schemas.ts`（zod 请求校验）、`http/server.ts`（同源/错误映射/挂载）与 `http/error.ts`（`RouteError` 叶子，断开 routes↔server 环）。
- **依赖分层收口**：`hostOf` 下沉 `infra/host.ts`，infra 对 deployment 只剩类型依赖；executor 不再值级依赖 app 展示层（报告转发正文改由 `executor/format.ts` 的 `workerReportText` 内联最小投影）；新增 `code-repos/port.ts` 统一同步/读取/提交出口。
- **静态架构守卫**（`tests/architecture.spec.ts`，零新依赖）：core 零外部依赖、infra 不依赖业务域、deployment↔infra 无值级环、executor 不依赖 app 展示层、code-repos 消费方经由 port——CI 持续锁定 011 §1 的脚本口径。

### 日常备份（2026-11-14）

- 管理 API 新增 `POST admin/backup`：对运行中的 SQLite 执行 `VACUUM INTO`，写出一致性快照（WAL 已合并，单文件可直接打开校验）。
- 服务脚本新增 `backup` 子命令：服务运行中走快照；停止时冷复制整个状态目录（含 `secrets/`，从 profile patch 自动检测 `stateDir`）；`--keep N`（默认 14）自动清理旧备份。
- 文档：006 新增「日常备份」节（含恢复步骤与 secrets 边界说明），009 §9.2 新增「版本 ↔ schema ↔ 迁移」对照表。

### 飞书知识库回写（2026-11-14）

- 多维表格（bitable）任务的状态字段回写落地：`FeishuTransport` 新增 `post` 双实现（CLI `lark api POST --data` / HTTP Bearer POST），`FeishuWikiApi` 新增 `updateRecord`（bitable 记录更新端点）。
- 驱动 `writeback`：任务键 `feishu-bitable:<node>:<table>:<record>` 直接定位记录并按 `statusColumn` 写状态；docx 任务没有可更新的记录，明确报「不支持回写」而不是猜测目标。
- 009 §13.3 残留项同步更新：飞书回写缺口只剩 docx 正文文档与群消息来源（后者本质无状态可写）。

### 凭据面收紧（2026-11-14）

- 工单分发脚本对 `git-credential` 不再走「唯一来源」兜底：凭据材料只对已登记的工单/工作副本目录（或显式指定来源的准备命令）发放；未登记目录里的 git 拿不到任何凭据，即使只配置了一个来源。`gh`/`glab`/`lark-cli` 保留唯一来源兜底（主会话合法使用）。

### 测试拆分与集成用例（2026-11-14）

- **runtime.spec 拆分**（011 §9.2 第 9 项收尾）：1639 行巨石按主题拆为 `runtime-tickets` / `runtime-sources` / `runtime-sessions` / `runtime-infra` 四个 spec + `fixtures/runtime-host.ts` 共享夹具（活引用 getter 工厂）；83 例逐字保留，零行为变化。
- **调度器与真实引擎集成用例**（`scheduler-runtime.spec.ts`）：内存任务来源驱动 + 真实 Runtime/Store/Effects，覆盖轮询入队 → 建单 → worker 首条消息 → 报告完成 → 队列结算与驱动回写、失败退避产生新工单、停用项目保留排队项。`TaskSourceRegistry` 新增 `register` 支持测试注入驱动。

### 单元测试 Windows 兼容与简化（2026-11-13）

- 修复 `deployment.spec.ts` / `environment.spec.ts` 在 Windows 上因符号链接权限失败的用例：普通符号链接
  在未开开发者模式的 Windows 上抛 `EPERM: operation not permitted`，改为免特权方案——目录链接改用 `junction`，
  验证「外来条目被拒」的文件符号链接用例改用目录等价断言。
- 由此 13 个失败用例全部转绿；`pnpm check` 在 Windows 上达到 77 个测试文件 / 1337 例全绿（tsc + vitest + build）。
- 简化：符号链接相关用例不再依赖开发者模式或管理员权限，任何普通 Windows 用户环境都能跑。

### 统一直连 SDK 与直连实测（2026-11-13）

- 新增统一直连 SDK（现居 [tests/fixtures/direct-connect.ts](tests/fixtures/direct-connect.ts)）：把散落在各实测脚本里的
  「端口发现 + `x-orchestrator-request` 客户端 + 等待就绪 + 证据落盘」收敛为一个被复用模块
  （`DirectConnect`），端口每次请求前重新读取 `startup.json`，正确跟随插件重挂载导致的端口漂移。
- 重构 `run-live` / `run-wizard` / `run-delete` / `run-cleanup` 复用该 SDK，删除约 150 行重复代码；
  热加载探针（`run-hot-reload`）与 `scripts/dsh-superagent.mjs` 保留各自语义（前者按端口参数观测
  重载、后者为无依赖的捆绑版服务脚本，不引入 ts 依赖）。
- 新增 [tests/direct-connect.spec.ts](tests/direct-connect.spec.ts)（8 例）：端口解析、缺端口报错、
  请求头/JSON 体、非 2xx 错误映射、健康失败兜底、`waitReady` 端口漂移跟随、断言/证据辅助。
- 直连真实桌面版实测端口发现、健康/状态、只读端点、`waitReady`、只读 DELETE 404 安全与同源门禁
  （缺请求头与 Host 不符均被 403 拒）；实测打印 `DIRECT_CONNECT_LIVE_OK`，证据入 `result.json`。
- 交付物：统一直连 SDK、SDK 单测、直连实测脚本与证据、重构后的验证脚本、本更新日志。

### 开发调试清理（2026-11-13）

- 删除冗余静态覆盖层 `examples/dev.cordis.patch.yml`：`pnpm dev` 已由
  [scripts/dev-web.mjs](scripts/dev-web.mjs) 从包层 `cordis.patch.yml` 动态生成同一覆盖层
  （`.artifacts/dev.cordis.patch.yml`），实测内容仅差一个结尾空行；该文件未被任何脚本/构建/
  测试引用，且文档声称的「含 dsh-hmr 说明」实际并不存在，避免手动同步负担与陈旧文档。
- `docs/006-deployment.md`「开发与调试」同步更新：等价原始命令改用脚本生成的
  `.artifacts/dev.cordis.patch.yml`，删除对已移除静态示例及 HMR 注释块的引用。
- 端到端实测开发回路：`pnpm build` + `pnpm dev --no-build` 生成覆盖层、启动 `dsh web`、
  健康检查通过并打印面板 URL（`DEV_WEB_READY`）。

## 0.2.0（2026-11-12）

以桌面版 DeepSeek Harness 真实端到端实测为验收（`verification/2026-11-11-wizard/`）。

### 破坏性

- 设置快照改为项目内联仓库与任务来源（`projects.<id>.codeRepo/taskSource` 为对象）；
  旧版字符串引用的设置无法启动，需执行一次重置（面板 Reset 或离线 `reset-state.ts`）。
- 数据库 schema 14：不再迁移，仅打开当前版本；历史迁移链已删除。

### 新增

- 向导式新建项目（四步）：Git 凭据（类型/认证方式随凭据决定）→ 仓库全地址（验证连通 → 拉取分支）→
  任务来源（真实读取校验，飞书群消息支持从机器人已加入群中选择）→ 执行与调度。
- 接口：`POST code-repos/branches`、`POST feishu-im/chats`、队列操作面
  （`POST queue/:id/retry|cancel`、`POST queue/clear`）。
- 项目删除闭环：停止运行中工单（`by=human` 的 `stopped`）、清理该项目全部队列记录与写回副作用。
- Excel 标准格式（010，原 016）：`tasks` 表 + 固定枚举 + 行级错误码 + 模板下载；飞书知识库多文档
  （`roots[]`、bitable、按 `spaceId` 全库唯一）与飞书消息任务来源。

### 修复

- 新建/删除项目触发初始化重跑，部署不再缺少新项目的仓库来源。
- 回写进入持久化副作用队列（退避重试、幂等键），并保留原文件 BOM 与换行风格。
- 失败重试按 attempt 生成新触发器，真正重新执行任务。
- 远端 URL 变化时重建工作副本镜像，不再报 unrelated histories。
- 轮询工作副本跟随项目分支；执行区为 per-ticket `git worktree`。
- 队列唯一性落在 SQLite 部分唯一索引；终态按保留窗口清理；工作区按保留期 GC。
- 队列/工单/线程/决策读取按 schema 校验，损坏记录明确报错；CLI 错误输出统一 `redact()` 脱敏。

### 验证

- 向导全流程（凭据 → 验证 → 分支 → 建项目 → 真实 DSH 会话执行 → 回写）与删除闭环
  （运行中删除）均在桌面版实测通过；1272 个单元/集成测试全绿。

### 任务清单自动初始化（2026-11-12）

- Excel 任务来源的清单文件缺失时**自动创建初始版本**（`ensureTaskFile`）：`.xlsx` 写标准模板
  工作簿、`.csv`/`.tsv` 写全部标准表头行，并提交进工作副本（`chore: initialize the standard
  task list`）。字段验证（`taskFileCreated` 结果码）与首轮轮询均自愈，项目不需要预先手工
  准备清单文件。测试覆盖 csv/xlsx 创建、重复验证不重建、git 提交与后续任务行的领取。

### SSH 凭据 Windows 修复（2026-11-12）

- **修复私钥规范化 bug**：`GitCredentials.material()` 对粘贴/文件读取的私钥做整串 `trim()`，
  会去掉 OpenSSH 要求的尾部换行，导致 `ssh` 报 `invalid format` 拒绝加载（Linux 同样受影响）。
  改为 `normalizePrivateKey()`：去 BOM、CRLF→LF、保证恰好一个尾部换行。单元用例覆盖
  BOM/CRLF/多余尾部换行/无尾部换行四种输入。
- **修复 Windows ACL bug**：`chmod 0o600` 在 Windows 是 no-op，临时私钥文件继承的宽 ACL
  （Authenticated Users 可读）使 OpenSSH 直接拒绝加载。`SecretVault.restrict()` 现在在
  win32 上用 `icacls /inheritance:r /grant:r <user>:F` 收紧（覆盖主密钥、加密材料文件与
  临时私钥文件）；vault.spec 增加 win32-only ACL 断言。
- 实测验证：DemoWebApp 凭据（`C:\Users\…\.ssh\id_rsa`，keyPath 来源）→ verify 身份 ok +
  远端 1 分支；向导仓库步 `code-repos/verify` 四项全绿，分支列表返回 `master`。

### 导航与菜单审查修复（2026-11-12）

- 概览「没有运行中的来源」问题行与按钮改指 **设置 › 飞书凭据 › 消息接入**（原误指项目组）。
- 消息来源状态页：头部「设置」按钮直达消息接入页签；移除与项目页重复的「任务清单」区块
  （每概念一处）；页面标签从「任务来源」更正为「消息来源」，简介注明配置位置。
- 「来源名称」键名陷阱修正：项目向导/项目卡片使用的 `sourceName` 键（文本为「项目名称」）
  重命名为 `projectName`/`projectNameHint`；清理无引用死键（`sourceNamePlaceholder`、
  `sourceRepoKind*`、`sourceTaskHint`、`sourceTaskList*`、`openSettingsOf.deployment`）与
  `FieldSpec.fact.settings` 死分支。
- 安装问题修复提示文案通用化（消息接入页或项目卡片），不再指向已移除的「设置 › 来源」。

### 项目表单收敛（2026-11-12）

- **仓库类型不再是表单字段**：随所选 Git 凭据或仓库地址站点推导并以只读标签展示；仅未绑凭据
  且地址无法识别站点时保留类型选择。
- **Excel 任务来源只剩「清单文件」一个字段**：自定义列映射、工作表选择与 `repo` 配置项全部
  移除——标准格式（`tasks` 表 + 固定表头与枚举）是唯一路径，非标准清单整批拒绝并提示下载模板
  改造；`repo` 原是被调度器注入覆盖的死字段（用户填写的值从不生效），随 `syncRepo()` 改为
  无参项目注入一并删除。`readTaskTable`/`sheetRows` 等兼容读取路径与六个旧记录模型错误码
  （`codeRepoInUse`/`taskSourceExists` 等）随之清理。
- **消息来源迁入设置 → 飞书凭据 → 消息接入 页签**：项目设置页只保留项目；消息来源（消息工单
  入口）与机器人身份同域配置，类型固定为飞书（单一类型不再显示选择器），来源名称文案从「项目
  名称」修正为「来源名称」；来源状态页与安装问题的直达链接随之指向新页签。
- 测试：`panel-source` 全部用例迁移到新入口；Excel 用例改为标准格式路径（含绝对路径拒绝与
  旧表头拒绝）。

### 开发调试（2026-11-12）

- 新增 `pnpm dev`（[scripts/dev-web.mjs](scripts/dev-web.mjs)）：推荐回路一键入口——构建、
  从包层生成自包含覆盖层（预设逐字复制，升级包层无需手工同步）、启动 `dsh web` 并等就绪
  打印面板 URL；dsh CLI 按 `--dsh` > `DSH_CLI` > PATH 解析。端到端实测 `DEV_WEB_READY`。
- 静态参考 [examples/dev.cordis.patch.yml](examples/dev.cordis.patch.yml) 与
  `docs/006-deployment.md`「开发与调试」一节：**Web UI 可视化调试**为默认选择（主插件按
  路径加载 + 开发 stateDir 与生产隔离），桌面版 `dsh plugin add link:` 重挂载为备选。
- 实测陷阱写入文档：`link:` 装入 web profile 触发运行时需求校验崩溃（peer 不随 link 解析）；
  tgz 安装在 Windows 因跨盘符号链接 EPERM；按路径加载不写预设则主会话报
  `Unknown agent preset`。
- 热重载插件 `@deepseek-ai/dsh-hmr` 0.1.6-alpha.2 与 dsh 0.2.2-rc.1 **版本线不匹配**，启动
  被拒；`allow-version` 豁免有崩溃风险，默认不启用。文档与 README 开发节均以该回路为默认
  选择，其余方法降为备选。
- 实测机制并写入文档：桌面版宿主监视 patch（30–90 秒延迟且不稳定）；**patch 条目消失会被
  插件管理器正式化为卸载**（自动改写 profile `package.json`），误删后需 `dsh plugin add link:`
  重装恢复；第三方 dsh-debug-mode（实验阶段）经分析未采用。

### 卸载清理（2026-11-12）

- `scripts/dsh-superagent.mjs clean --yes`：从 DSH profile 移除插件引用（patch 条目、
  package.json 的 bundles/dependencies、node_modules 链接、pnpm-lock importer）并删除状态
  目录、同级锁目录与 `.artifacts` 工件；先备份到 `~/dsh-superagent-backup/clean-<stamp>/`。
- 桌面版等外部实例持锁时先改 patch 触发重组卸载并等锁释放，超时还原 patch 并中止；
  未显式指定 profile 时自动扫描唯一引用插件的 profile。
- 新增 6 个服务脚本用例与 `verification/2026-11-12-cleanup/` 直连桌面版实测
  （清理 → 检出完好断言 → 备份还原 → 插件恢复 ready，`CLEANUP_LIVE_OK`）；
  `docs/006-deployment.md` 新增「卸载与清理」一节。

### 文档清理（2026-11-12）

- 删除六篇已废弃/已消耗文档：原 010（pipeline）、011、012（已并入 009）、014（C 级项并入
  011 评审 §9.2）、015（关闭证据由 011 §9.1 承接）、原 009（身份规则并入 008、启动诊断并入 006）。
- 编号重排为连续：013→009、016→010、017→011；007 与代码注释中的编号引用同步。
- 005 按当前面板重写（页签、设置分组、队列操作面）；006 设置/管理 API/安装检查/试用段
  与实现重新对齐；001/002/008 清除 GitHub/GitLab 事件源残留描述。
- `tests/docs.spec.ts` 新增 007 模块表/测试表重复行检查。
