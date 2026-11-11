# 014 代码裁剪清单（审计产出）

> 状态：审计清单，供后续阶段执行。本轮**不删任何代码**、不提交。
> 依据：本仓库 `src/` 131 个 TS/TSX 文件的静态 import 图、844 个导出符号的引用计数、`tests/` 用例抽样、文档与实现对照。
> 目标设计见 [013-authoritative-project-design.md](013-authoritative-project-design.md)。生产差距见 `015-production-readiness-gaps.md`。

## 0. 审计方法与总体结论

1. 用脚本解析 `src/` 与 `tests/` 的静态 import，构建依赖图，统计入度与运行时环。
2. 统计全部 `export` 符号在其他文件中的出现次数，筛出零引用候选（128/844，约占 15%）。
3. 逐项核对设置、调度、重置入口、客户端表单与测试，确认「是否真的无引用」。
4. 抽样命令名、路径、域名、权限位，确认环境假设。

结论：

- **没有整文件孤儿**：131 个源文件都至少被另一个源文件 import，因此不存在「整文件安全删除」的候选。零引用的 128 个符号中，绝大多数是「在同文件内使用、export 多余」或「仅类型、仅测试」。
- **运行时存在 2 组强连通分量（SCC，仅统计非类型 import；类型边更多）**，集中在 `core ↔ app` 与 `deployment ↔ infra/environment`、`app/runtime ↔ app/*` 一带；不是 13 条独立循环链路。
- **真正的删除收益来自「阶段化退场」**：`codeRepos` / `taskSources` 两套记录被项目内联取代后，整块模块才能删；现在删会连带破坏设置、调度与面板。
- 因此本清单按「安全删除（现在可做） / 需确认（依赖版本或决策） / 重构保留（先替换再删）」分级。

## 1. A 级：安全删除

满足条件：删除后行为不变，`typecheck` + 目标测试即可验证，不涉及数据与用户可见文案。

| # | 文件与位置 | 内容 | 理由 | 影响面 | 删除后验证 |
| --- | --- | --- | --- | --- | --- |
| A1 | [task-sources.tsx:12-21](../src/client/task-sources.tsx#L12-L21) | 重复定义的 `VerifyRow` | 与 [source.tsx:20-31](../src/client/source.tsx#L20-L31) 同构，样式与语义已经分叉（`task-sources.tsx` 版本不带 `scope`） | 仅任务来源卡片 | 抽到共享组件后删除重复定义；跑 `tests/panel-settings.spec.ts`（若覆盖）与 `pnpm typecheck` |
| A2 | [dsh.ts:223](../src/executor/dsh.ts#L223) | `export function projectOfTicket` 去掉 `export` | 只在同文件 [dsh.ts:259](../src/executor/dsh.ts#L259) 使用，属于多余导出 | 无 | `pnpm typecheck`（外部无引用） |
| A3 | [execution-environment.ts:11](../src/app/execution-environment.ts#L11) | `EXECUTOR_VARIABLES` 去掉 `export` | 同文件 70、84 行使用 | 无 | `pnpm typecheck` |
| A4 | [code-repos/kind.ts:8-18](../src/code-repos/kind.ts#L8-L18) | `CodeRepoKind` / `CodeRepoRecord` 的类型导出 | 零外部引用；记录类型随 P2 退场 | 仅类型 | `pnpm typecheck` |
| A5 | [queue/model.ts:9](../src/queue/model.ts#L9) | `QueueEntrySchema` 的 `export` | 只在同文件推 `QueueEntry` 类型；读取路径并不校验（见 015） | 仅类型 | `pnpm typecheck` |
| A6 | [sources/github.ts](../src/sources/github.ts)、[sources/gitlab.ts](../src/sources/gitlab.ts) | `GithubConfig` / `GitlabConfig` 类型导出 | 零引用；类型由 `githubType` / `gitlabType` 承载 | 仅类型 | `pnpm typecheck` |
| A7 | [projects/kind.ts](../src/projects/kind.ts) | `ProjectIdSchema` 导出 | 零引用（ID 校验在设置层完成） | 仅类型/运行时校验点 | `pnpm typecheck` + 设置保存用例 |
| A8 | [feishu-doc.ts:83](../src/task-sources/feishu-doc.ts#L83) | `checklistTasks` 去掉 `export` | 只被同文件调用 | 无 | `tests/task-sources*.spec.ts` |

> A 级不做「为了删而删」：只删确实多余的 `export` 与重复实现，不改逻辑。批量执行前建议先接 `knip`/`ts-prune` 复核一次，避免手工误判。

## 2. B 级：需确认后删除

满足条件：删除会改变行为、数据结构或与旧数据的兼容性，必须先完成对应阶段或拿到决策。

| # | 目标 | 文件与位置 | 理由 | 影响面 | 删除后验证 |
| --- | --- | --- | --- | --- | --- |
| B1 | 设置中的 `codeRepos` / `taskSources` 映射与 API | [policy.ts](../src/policy.ts)、[settings.ts:206-207](../src/app/settings.ts#L206-L207)、[http.ts:216-243](../src/app/http.ts#L216-L243) | 项目内联后不再需要独立记录 | 服务端设置、面板两个页面、重置后的空库 | 重置后新库启动成功；`settingsView` 无这两个键；面板无入口 |
| B2 | `checkRepoBinding` 补偿校验 | [settings.ts:352-370](../src/app/settings.ts#L352-L370) | 结构上仓库已唯一，校验无意义 | 保存路径与两条错误文案 | 删除后两个保存路径仍拒绝非法仓库；错误码表清理 |
| B3 | `taskSource.config.repo` / `config.source` | [excel.ts:26-38](../src/task-sources/excel.ts#L26-L38)、[feishu-wiki.ts:18-27](../src/task-sources/feishu-wiki.ts#L18-L27) | 仓库固定为项目仓库；飞书凭据改引用 | 任务来源 schema、校验、读取 | Excel 从项目仓库读；知识库用 `feishuCredential`；新库不含这两个字段 |
| B4 | 设置视图下发原始配置 | [views/settings.ts:44-63](../src/app/views/settings.ts#L44-L63) | 凭据独立后不能把 Secret 发到前端；改为凭据掩码摘要 | 面板全部设置页 | 响应体不含 `sshKey`/`token`/`appSecret`；面板仍能渲染 |
| B5 | 全部历史迁移分支 | [migration.ts:91-134](../src/app/migration.ts#L91-L134) | 本方案不做迁移，历史分支只服务旧库 | 启动流程、旧库报错路径 | 删除后旧库启动必须明确报错并提示 `reset`；空库启动建表成功 |
| B6 | `src/sources/github.ts` / `gitlab.ts` 作为 SourceKind | [code-repos/types.ts](../src/code-repos/types.ts) 引用 | 仓库类型不属于「消息来源」 | `deployment.ts`、`setup.ts`、`locales`、面板 | 迁到 `code-repos/` 后删除来源侧注册；git 凭据测试与仓库校验通过 |
| B7 | 遗留 `projectWorkers` 相关设置与 UI | 以 `rg -n "projectWorkers" src tests` 结果为准 | D3 已规定全局上限为唯一硬上限 | 策略、面板、测试 | 扫描无引用；执行器并发用例通过 |
| B8 | 失败/环境依赖测试 | `tests/deployment.spec.ts`、`tests/environment.spec.ts` | 依赖符号链接，Windows 下直接 `EPERM`（本机已复现），CI 不可重复 | 测试稳定性 | 改为临时目录 + 跳过策略或平台矩阵；本地与 CI 均绿 |

> B 级必须「先替换、后删除」：每一项都要在「重置后的空库 + 从零建项目」流程验证通过后再执行删除，不依赖任何旧数据。

## 3. C 级：重构保留（先替换，再删除）

这些模块**当前不能删**：它们承担真实职责，只是边界或实现重复。正确顺序是先收敛契约，再删旧实现。

| # | 文件 | 重复/问题 | 保留理由 | 收敛方式 | 最终删除点 |
| --- | --- | --- | --- | --- | --- |
| C1 | [feishu-doc.ts](../src/task-sources/feishu-doc.ts)、[feishu-wiki.ts](../src/task-sources/feishu-wiki.ts) | `feishuToken`、`tableRows`、`checklistTasks` 与 wiki 驱动的读取逻辑重叠 | 一个负责「按 token 读文档」，一个负责「驱动 + 校验」 | 读取原语下沉到 `feishu-doc.ts`，`feishu-wiki.ts` 只保留驱动与 `verify` | 保留两个文件，不合并成巨型模块 |
| C2 | [code-repos/sync.ts](../src/code-repos/sync.ts)、[work.ts](../src/code-repos/work.ts)、[read.ts](../src/code-repos/read.ts) | 都涉及仓库访问，边界靠命名约定 | 分别负责远端探测/克隆、工作副本、文件读取 | 定义 `RepoPort`（probe / ensure / read）由三者实现 | 三文件保留，删除跨文件重复的路径与远端解析 |
| C3 | [core/engine.ts](../src/core/engine.ts)、[app/cards.ts](../src/app/cards.ts)、[app/views/*](../src/app/views) | `core ↔ app` 运行时环 | 引擎需要视图/卡片做投递 | 把跨层契约抽到 `core/contracts.ts`（纯类型），app 只实现 | 环消除后再决定是否拆 `cards.ts` |
| C4 | [deployment.ts](../src/deployment.ts)、[infra/environment.ts](../src/infra/environment.ts) | GitHub / GitLab / 飞书三类解析混在一个 185 行模块，且与 infra 成环 | 被设置、启动、执行多处调用 | 按凭据类型拆 `deployment/git.ts`、`deployment/feishu.ts`，infra 只保留环境探测 | 拆分完成后 `deployment.ts` 只做聚合 |
| C5 | [sources/github.ts](../src/sources/github.ts)、[sources/gitlab.ts](../src/sources/gitlab.ts) | 名字在 `sources/`，实际是代码仓库类型 | 被 `code-repos/types.ts`、`deployment.ts` 引用 | 搬移到 `src/code-repos/types/` 并更新 007 模块表 | 搬移后删除来源目录下的同名文件 |
| C6 | [client/code-repos.tsx](../src/client/code-repos.tsx)、[client/task-sources.tsx](../src/client/task-sources.tsx) | P2 后页面消失，但表单字段要进项目表单 | 当前仍是唯一编辑入口 | 先把仓库组、任务来源组抽成项目表单子组件 | 抽完并验收后删除两个页面与路由 |
| C7 | [app/migration.ts](../src/app/migration.ts) | 历史迁移分支与基线建表混在一处 | 新库仍需要「建表 + 写基线版本」 | 删除全部版本升级分支，只保留基线建表 | 基线入口保留，历史分支全删 |
| C8 | [views/settings.ts](../src/app/views/settings.ts) | 聚合下发多类记录 | 设置页唯一数据源 | 拆成 `settings/projects.ts`、`settings/credentials.ts` | 拆完后删除旧聚合字段 |

## 4. 执行顺序与统一验证

1. 先做 A 级（无风险），同批更新 `tests/docs.spec.ts` 涉及的模块表（若文件未增删则无需改）。
2. 再做 C 级的接口收敛，保证 P2 期间项目表单可独立工作。
3. 重置基线落地、空库启动验证通过后，执行 B 级删除。
4. 每批删除后统一执行：

```
pnpm typecheck
pnpm vitest run tests/docs.spec.ts tests/settings.spec.ts tests/scheduler.spec.ts tests/projects.spec.ts
pnpm build
rg -n "codeRepos|taskSources|checkRepoBinding|projectWorkers" src tests
```

5. 删除后若 `tests/docs.spec.ts` 报「模块表与实际文件不一致」或「编号文档断号」，说明 007 或文档索引未同步，应按测试提示补齐。

## 5. 明确不建议删除的部分

| 项 | 原因 |
| --- | --- |
| `src/secrets/`（待新建） | 是 Git / 飞书凭据唯一允许共用的基础设施，删掉会导致两套实现各自加密 |
| `src/queue/model.ts` 的状态机 | 队列语义依赖它；问题在「读取不校验」，不是模型多余 |
| `src/app/scheduler.ts` | 目标形态的骨架已具备，缺的是语义与可观测，重写成本高于增量修改 |
| `src/code-repos/sync.ts` 的 `redactCredentials` | 当前唯一脱敏实现，应在全局扩展而不是删除 |
| `tests/windows-compat.spec.ts` | 是唯一覆盖 `PATHEXT`、`.cmd` 包装、spawn 环境的用例，需保留并扩展 |
