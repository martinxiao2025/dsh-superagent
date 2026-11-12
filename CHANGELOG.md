# 更新日志

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
