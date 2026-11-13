# 更新日志

## Unreleased

### 单元测试 Windows 兼容与简化（2026-11-13）

- 修复 `deployment.spec.ts` / `environment.spec.ts` 在 Windows 上因符号链接权限失败的用例：普通符号链接
  在未开开发者模式的 Windows 上抛 `EPERM: operation not permitted`，改为免特权方案——目录链接改用 `junction`，
  验证「外来条目被拒」的文件符号链接用例改用目录等价断言。
- 由此 13 个失败用例全部转绿；`pnpm check` 在 Windows 上达到 77 个测试文件 / 1337 例全绿（tsc + vitest + build）。
- 简化：符号链接相关用例不再依赖开发者模式或管理员权限，任何普通 Windows 用户环境都能跑。

### 统一直连 SDK 与直连实测（2026-11-13）

- 新增 [verification/direct-connect.ts](verification/direct-connect.ts)：把散落在各 verification 脚本里的
  「端口发现 + `x-orchestrator-request` 客户端 + 等待就绪 + 证据落盘」收敛为一个被复用模块
  （`DirectConnect`），端口每次请求前重新读取 `startup.json`，正确跟随插件重挂载导致的端口漂移。
- 重构 `run-live` / `run-wizard` / `run-delete` / `run-cleanup` 复用该 SDK，删除约 150 行重复代码；
  热加载探针（`run-hot-reload`）与 `scripts/dsh-superagent.mjs` 保留各自语义（前者按端口参数观测
  重载、后者为无依赖的捆绑版服务脚本，不引入 ts 依赖）。
- 新增 [tests/direct-connect.spec.ts](tests/direct-connect.spec.ts)（8 例）：端口解析、缺端口报错、
  请求头/JSON 体、非 2xx 错误映射、健康失败兜底、`waitReady` 端口漂移跟随、断言/证据辅助。
- 新增 [verification/2026-11-13-direct-connect](verification/2026-11-13-direct-connect/)：用统一 SDK 直连真实
  桌面版实测端口发现、健康/状态、只读端点、`waitReady`、只读 DELETE 404 安全与同源门禁
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
