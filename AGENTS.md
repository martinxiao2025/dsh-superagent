# AGENTS.md

给在本仓库工作的编码智能体（以及想快速上手的人）的工作约定。先读 [README.md](README.md) 了解项目定位，再读 [docs/007-architecture.md](docs/007-architecture.md) 的模块表与测试表——那是代码的活索引。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm check` | typecheck + test + build，提交前的完整门禁 |
| `pnpm typecheck` / `pnpm test` / `pnpm build` | 单独运行某一环；测试约 1400 例，全绿才算过 |
| `pnpm dev` | Web UI 可视化调试回路：构建 → 开发覆盖层 → `dsh web`（状态目录隔离在 `.dsh-dev-state`） |
| `node scripts/verify-live.mjs` | 对真实实例的只读实机核验 |
| `node scripts/self-update.mjs` | link 安装的一步升级闭环（pull → install → build → 等版本核对） |
| `pnpm release <version>` | 发布门禁：check + CHANGELOG 版本节核对 + 打版本与 git 标签；不推送、不发 npm |

环境：Node `^22.19.0 || >=24`，pnpm 11.7（`packageManager` 已固定）。dsh CLI 不在 PATH 时用 `--dsh <路径>` 或 `DSH_CLI` 指定。

## 架构速览

分层自下而上，方向由 `tests/architecture.spec.ts` 静态锁定：

```
零依赖叶子（deployment-types / execution-paths / limits / fields / kv / admission）
  ↑        ↑
core（领域引擎：Trigger/Thread/Eval/Ticket/Assignment/Mandate；零外部依赖、无 I/O）
  ↑
sources（消息来源适配器，当前仅飞书）   task-sources（任务清单驱动：excel / feishu-wiki / feishu-im）
  ↑                                              ↑
executor（每工单一个持久 DSH 会话 + per-ticket worktree）   app/queue（持久化队列）
  ↑        ↑
app（Runtime 组合根：调度器、HTTP 面板后端 /orchestrator/api、评估器、主会话工具）
  ↑
client（React 管理面板，zh/en 双语）
```

两条数据流汇合在 core 与 executor：

- **消息线**：飞书轮询 → Trigger → `core/intake` → LLM 评估（`app/assessment`）→ 策略门禁（`policy/gate`）→ 工单。
- **任务线**：项目轮询任务来源 → 拆解工作项 → QueueEntry 入队 → 调度出队建单 → 终态回写清单。

设计契约见 [docs/009-project-design.md](docs/009-project-design.md)；行为规则（授权、评估、结束判定）的权威表述在 docs/001–003。

## 测试守卫的硬规则

这些测试不是覆盖率摆设，是结构约束——改动前先读对应测试：

- **`tests/docs.spec.ts`**：docs/ 编号文档从 000 连续编号；编号文档只能链接**更早**的编号文档；README/SETUP/编号文档里的本地链接必须可解析；**`docs/007-architecture.md` 的「模块」与「测试」两张表必须与 `src/`、`tests/` 的实际文件一一对应（不重不漏）——新增、删除或改名任何 src/tests 文件时必须同步这两张表**。
- **`tests/architecture.spec.ts`**：core 不导入自身之外的任何内容；sources 不从 app 导入；executor 不值级依赖 app（唯一例外是零依赖叶子 `app/later.ts`）；infra 只从 `deployment-types.ts` 取部署类型；code-repos 的消费方经由 `code-repos/port.ts`。
- **`tests/model-surface.spec.ts`**：模型读到的一切（工具、提示词、技能、输入）按角色大小预算约束检查。改面向模型的文本（`prompts/`、`skills/`、工具描述）后必须跑它。
- **`tests/class-docs.spec.ts`**：`src` 中每个类之前都要有 JSDoc 块。

## 文档纪律

- **每篇单一职责**，编号即阅读顺序；不为同一主题留两份表述：行为规则的权威在 001–003，007 只索引到类与文件，009 是项目交付域的设计权威。
- **CHANGELOG 是已完成工作的唯一台账**：每个批次加一条（Unreleased 下），带结论摘要与验证证据（测试数、`pnpm check`）。
- **待办只进 [tasks/backlog.csv](tasks/backlog.csv)**：010 标准格式（表头与状态枚举 `todo`/`in_progress`/`blocked`/`done`/`cancelled`）；不在文档里另开"剩余任务清单"。
- **方案文档收官即删**：评审记录、重构方案在收官后删除，结论并入 CHANGELOG 与正文，原文见 git 历史。
- **schema 变更**要更新 009 §8.2 的「版本 ↔ schema ↔ 迁移」对照表与 CHANGELOG。

## 语言与提交

- 文档、注释、CHANGELOG、任务清单一律中文；代码标识符与错误码英文。
- 提交信息沿用现有惯例：`feat:` / `fix:` / `refactor:` / `docs:` / `chore:` 加批次描述（见 `git log`），一个批次一个提交。
- 不要提交构建产物（`lib/`）、开发状态目录（`.dsh-dev-state/`）或实测产物。
