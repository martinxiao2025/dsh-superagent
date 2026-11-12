# 015 生产就绪差距清单（审计产出）

> 状态：审计清单，按优先级排列。本轮只写文档，不改代码、不提交。
> 设计目标见 [013-authoritative-project-design.md](013-authoritative-project-design.md)，删除计划见 [014-code-pruning-inventory.md](014-code-pruning-inventory.md)。
> 判定标准：可观测性、错误恢复、幂等、权限边界、数据一致性、备份回滚、凭据安全、跨平台可重复。

## 0. 总体判断

当前实现是「功能可用、运维不可用」的状态：主链路（来源 → 工单 → 执行 → 队列）能跑通，但一旦出现停用、崩溃、写回失败或凭据轮换，缺少可见性与恢复手段。P0 集中在校密与数据可信，P1 集中在队列与写回的闭环，P2 集中在跨平台与测试可重复。

### 0.1 复核状态（2026-11-11）

以下条目已在当前代码中关闭，原表保留用于追溯；其余条目仍以原文结论为准，本日未逐项复核。

- P0-1：设置视图只下发记录、版本与字段定义，不再原样返回秘密字段（[views/settings.ts](../src/app/views/settings.ts#L30-L69)）。
- P0-5：重置先备份 `stateDir`，分步删除失败可回滚（[reset.ts](../src/app/reset.ts#L49-L100)）。
- P1-3：停用保留排队项且不派工；队列操作面补齐 `POST queue/:id/retry`、`queue/:id/cancel`、`queue/clear`。
- P1-4：`queue_unique_active` 唯一索引落在 SQLite（[store.ts](../src/app/store.ts#L46-L85)）。
- P1-5：队列快照与项目详情提供 `lastError` / `nextPollAt`，面板显示「下次轮询」与最近错误。

### 0.2 复核状态（2026-11-12）

以下条目在 011/012 两轮实施后关闭或部分关闭；权威剩余清单见 `017-architecture-review.md` 第 9 节。

- P0-2：统一 `redact()` 落在 [infra/text.ts](../src/infra/text.ts)，命令层错误出口（`commandError`）统一调用；覆盖 URL 内嵌凭据、Authorization、Bearer、`token=` 与私钥块。
- P0-3：`src/secrets/` 已建（加密存储、掩码回显、指纹、轮换），Git/飞书凭据走独立表与探测。
- P0-4：queue 按完整 schema、ticket/thread/decision 按关键字段形状校验，损坏记录明确报错（[store.ts](../src/app/store.ts)）；迁移链已删除（41319e0）。
- P1-1：写回进入持久化 `Effects`（退避重试、幂等键、健康度），项目删除时取消未投递的写回。
- P1-2：写回幂等键 `key('writeback', entry.id, status, attempt)`；保留 BOM/CRLF 的写入避免无关 diff。
- P1-6：执行目录物化为 per-ticket `git worktree`（[workspace.ts](../src/code-repos/workspace.ts)），轮询副本跟随项目分支。
- P1-7：崩溃恢复覆盖队列条目重建；终态按保留窗口 prune，工作区按保留期 GC。
- P2-1：Git/飞书凭据探测真实运行（[probe.ts](../src/git-credentials/probe.ts)），错误可区分；仓库/知识库 verify 真实读取并返回条数。
- P2-2：知识库按 `spaceId` 全库唯一归属（e81f79e）。
- P2-3：加密存储落地；Windows ACL/DPAPI 细节仍待收尾（见 017 §9）。
- P2-5：`lastError`/`nextPollAt` 进快照与详情；结构化日志与指标仍缺（见 017 §9）。
- P2-7：013 增补实施状态附录、CHANGELOG 与 0.2.0 版本；005/009 的页签描述仍待标注过期。

## 1. P0：上线前必须解决

| # | 问题 | 证据 | 影响 | 建议动作 | 验收 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | 设置视图原样下发配置 | `settingsView` 直接返回 `config`，含 `sshKey` 路径（[views/settings.ts:44-63](../src/app/views/settings.ts#L44-L63)） | 一旦允许粘贴私钥或 App Secret，秘密会进入浏览器、快照与代理日志 | 凭据独立存储后，设置视图只下发掩码摘要与指纹；配置文件永不承载秘密 | 抓取 `/api/settings` 响应，断言不含 `sshKey`/`token`/`appSecret`；快照文件同理 |
| P0-2 | 脱敏只覆盖一处 | 仅 `code-repos/sync.ts` 的 `redactCredentials`（[sync.ts:17](../src/code-repos/sync.ts#L17)、[sync.ts:56](../src/code-repos/sync.ts#L56)） | Git URL 内嵌凭据、错误对象、命令输出可能原样进日志与工单 | 提供全局 `redact()`（URL、Authorization、`token=`、私钥块），在命令层与 HTTP 错误出口统一调用 | 构造带凭据的失败命令，断言日志/工单/响应中无原文 |
| P0-3 | 无加密凭据存储 | 现有 `sshKey` 只存路径，仓库里没有密钥库模块 | 新方案要求粘贴私钥/Secret，裸存会直接违反安全基线 | 新建 `src/secrets/`：加密写入、掩码回显、指纹、轮换 | 凭据文件不可读明文；换机后解密失败有明确错误 |
| P0-4 | 读取不做 schema 校验 | 所有实体读取是 `JSON.parse(...) as T`（[store.ts:133](../src/app/store.ts#L133)、[store.ts:258](../src/app/store.ts#L258)）；`QueueEntrySchema` 只在同文件推类型（[model.ts:9](../src/queue/model.ts#L9)） | 字段损坏会静默传播到调度与执行，表现为「状态看起来正常但行为异常」 | 队列与设置读取走对应 schema（`safeParse`），失败进入隔离区并告警，不静默强转 | 注入一条损坏的队列记录，启动后进入隔离并可在界面看到，不阻塞其他项目 |
| P0-5 | 重置无备份与失败保护 | 当前没有重置入口，也没有清空前的快照步骤；`stateDir` 是唯一数据源 | 清空后旧状态不可恢复，误操作代价高 | 重置前自动打包 `stateDir` 到用户可删目录并输出路径；分步删除失败可回滚 | 重置中断后数据回到重置前；备份可独立还原 |
| P0-6 | 权限边界不清 | 设置与凭据接口只有同源检查（[http.ts](../src/app/http.ts) 的 `sameOrigin`），无角色区分 | 面板一旦被同源页面利用（XSS/内嵌），可读取或改写凭据配置 | 明确单用户假设并写入文档；或引入管理口令与操作审计 | 明确结论 + 越权用例（若有口令） |

## 2. P1：影响可靠性，需在首个生产周期内解决

| # | 问题 | 证据 | 影响 | 建议动作 | 验收 |
| --- | --- | --- | --- | --- | --- |
| P1-1 | 写回「发起即忘」 | `writeback` 仅 `.catch` 记录（[scheduler.ts:306-321](../src/app/scheduler.ts#L306-L321)） | 外部清单与本地状态长期不一致，且无法补写 | 写回进入持久化重试队列，记录尝试次数与最后错误；提供手动重试入口 | 断开外部写入后，条目进入重试并可手动成功 |
| P1-2 | 写回无幂等键 | 写回路径按任务编号直接改状态，没有「已写」标记 | 重试或重复派工会重复改写，覆盖人工修改 | 引入 `writeback:<taskKey>:<status>:<revision>` 幂等键与最后写入时间 | 同一任务重放两次，外部清单只变更一次 |
| P1-3 | 停用语义未闭环 | `poll` 与 `dispatch` 检查 `enabled`（[scheduler.ts:83](../src/app/scheduler.ts#L83)、[scheduler.ts:250](../src/app/scheduler.ts#L250)），但不处理已排队条目，界面只显示一个标签 | 用户以为「停了」，实际仍有排队；或以为会清空，实际保留 | 按 013 第 4.3 节定案：保留 `queued`、显示计数、单独提供「停止当前任务」 | 停用后不派工、计数可见、恢复后继续；用例覆盖 |
| P1-4 | 队列唯一性只在内存逻辑 | `queue` 表只有 `id` 主键与 `seq` 索引（[store.ts:88-93](../src/app/store.ts#L88-L93)） | 崩溃恢复或并发触发可能产生同任务双条目 | 增加 `(project, taskKey, state)` 部分唯一索引或入队前事务内查重 | 并发入队同一任务只保留一条 |
| P1-5 | 严重错误的可见性不足 | `scheduler.errors` 不进入快照（[scheduler.ts:42](../src/app/scheduler.ts#L42)、[scheduler.ts:132-144](../src/app/scheduler.ts#L132-L144)） | 轮询/写回失败只能翻日志，项目详情看不到 | 快照暴露 `lastError`、`nextPollAt`、`lastWriteback`；项目详情展示 | 人为让轮询失败，详情页 10 秒内可见 |
| P1-6 | 执行目录不物化仓库 | 附录 A 的实测：执行目录与仓库工作副本不一致 | 任务在错误代码上执行，结果不可信 | 派工前校验工作副本存在、远端一致、HEAD 与分支匹配，不一致则同步或拒绝 | 删除工作副本后派工，系统自动重建或给出明确失败 |
| P1-7 | 恢复只覆盖「starting」 | 恢复逻辑按有无工单重排（[scheduler.ts:170-181](../src/app/scheduler.ts#L170-L181)） | `running` 期间进程崩溃可能留下悬挂会话与目录 | 记录会话与工单的绑定，启动时收敛 `running` 条目并清理孤儿目录 | 强杀进程后重启，队列与工单状态一致，无孤儿会话 |

## 3. P2：影响体验与可维护性

| # | 问题 | 证据 | 影响 | 建议动作 | 验收 |
| --- | --- | --- | --- | --- | --- |
| P2-1 | 凭据测试不是真实探测 | 现有 verify 只做配置/CLI 存在性检查；无「凭据 × 仓库」「凭据 × 知识库」组合校验 | 用户以为可用，派工时才失败 | 实现 013 第 5、7 节的两个独立 verify 与错误码 | 错误可区分：凭据无效 / 无权限 / 仓库不存在 / 知识库不可读 |
| P2-2 | 知识库唯一性未实现 | 当前任务来源是共享记录，无 `spaceId` 约束 | 两个项目可绑同一知识库，任务重复 | 建唯一索引 + 归属校验 + 未绑定保持停用 | 绑定冲突被拒；重置后未绑定知识库的项目无法启用 |
| P2-3 | Windows 权限位无效 | `mkdir 0o700`、`chmod 0o600`（[store.ts:68-69](../src/app/store.ts#L68-L69)）在 Windows 上不生效 | 凭据与数据库文件对其他本地用户可读 | 依赖目录 ACL 或 DPAPI 加密；文档写明单用户前提 | Windows 上凭据文件无法被普通读取；有说明 |
| P2-4 | 命令层环境假设 | 90s 固定超时（[commands.ts:10-30](../src/infra/commands.ts#L10-L30)）、`cmd.exe /c` 包装、默认域名 `github.com` / `gitlab.com`（[deployment.ts:164-185](../src/deployment.ts#L164-L185)）、`gh`/`glab` 默认 CLI（[deployment.ts:86-99](../src/deployment.ts#L86-L99)） | 内网 GitLab、自建域名、慢网络下不可用 | 超时、CLI 名、域名全部可配置并有默认值说明；失败给出可操作提示 | 自定义域名与 CLI 的场景通过；超时可调 |
| P2-5 | 日志与指标缺失 | 无结构化日志、无请求 ID、无队列指标；health 只覆盖部分实体 | 无法判断「为什么没跑」 | 引入结构化事件（project、queue、ticket、credential），暴露最小指标：排队数、运行数、失败率、写回积压 | 面板「系统 → 诊断」可见上述指标与最近错误 |
| P2-6 | 测试无法在 CI 重复 | `tests/deployment.spec.ts`、`tests/environment.spec.ts` 依赖符号链接，Windows 下 `EPERM`（本机复现） | CI 与开发机结果不一致，容易漏回归 | 改用临时目录与跳过策略，或在 CI 用 Linux；补队列串行、停用、凭据加密用例 | 两平台全绿；新增用例覆盖 P1-3/P1-4/P0-3 |
| P2-7 | 文档漂移 | [005-panel.md](005-panel.md) 页签与设置分组过期；[009-source-records.md](009-source-records.md) 仍把 Git 当来源；[010-pipeline.md](010-pipeline.md) 描述已删除的 pipeline | 新成员按旧文档实现，产生二次返工 | 保留历史但标注过期；以 013 为准；007 模块表强制同步 | `tests/docs.spec.ts` 通过；过期文档顶部有状态说明 |

## 4. 差距与待拍板的关系

以下差距的解法依赖用户决策，本文不给默认结论：

| 差距 | 依赖的待拍板项（013 第 10 节） |
| --- | --- |
| P0-6 权限边界 | 是否为多用户/多角色部署 |
| P1-1 / P1-2 写回重试与幂等 | 写回失败是否重试、是否可以覆盖人工修改 |
| P1-3 停用语义 | 停用后排队项保留还是清空 |
| P1-5 / P2-5 可观测性范围 | 是否接受新增诊断页与指标存储 |
| P2-1 凭据测试范围 | Git 凭据类型、是否允许 `agent` 模式；飞书凭据是否支持跨项目复用 |
| P2-2 知识库唯一性 | 知识库粒度为 `spaceId` 还是节点 |
| P2-6 测试平台策略 | CI 是否提供 Linux 运行环境 |

## 5. 建议的上线门槛

满足以下全部条件才视为「生产就绪」：

1. P0 全部关闭，且有对应自动化用例或检查脚本。
2. 队列在「停用、强杀、写回失败、凭据轮换」四种场景下都能自洽恢复。
3. 设置与凭据响应经抓包确认不含秘密；日志经抽样确认已脱敏。
4. 重置在带真实数据的临时 `stateDir` 上演练两次（成功一次、人为中断一次），备份可还原。
5. 两平台测试全绿，`tests/docs.spec.ts` 与 007 模块表一致。
