# U5：GitLab / 飞书适配器多实例与命名空间

## Context

来源已重构为「记录」：`Settings.sources = Record<记录ID, { kind, enabled, config }>`，记录 ID 即来源身份，不做旧数据迁移。
U4 已完成 GitHub 的多实例化：线程/触发器/KV 键按记录命名，实例地址贯穿链接、API 与执行环境（`GH_HOST`），`find` 按记录返回、PR 归属按记录、执行器按工单来源解析。

U5 把同一套模型落到 GitLab 与飞书：两条 GitLab 记录、两条飞书记录并存时，线程、触发器、KV 游标、健康条目、搜索与执行环境必须互不影响；自建 GitLab 的实例地址要贯穿网页链接与 `GITLAB_HOST`。
沿用 U4 的既有工具，不新造抽象：`src/sources/identity.ts` 的 `threadKey(record, local)`、`triggerKey(record, local, ...parts)`；`src/kv.ts` 的键族加 `record` 名称段；`SourceKind.find(instance, query)`。

**本回合只做 U5，不进入 U6。** 交付前必须收掉的两项（多记录执行侧闭环、资源路由按记录区分）写入方案文档，排为独立单元 U6a / U6b，并在交付清单逐条对照。

## 设计口径

- 记录 ID = `ctx.id` / `source.id` / `instance.id` / `trigger.source`。
- 线程本地段保持现有形状：GitLab `issue:<iid>` / `mr:<iid>`；飞书 `<chatId>:<root|messageId>`。完整线程键由 `threadKey(record, local)` 生成，默认记录下与旧格式一致（`gitlab:issue:12`、`feishu:oc_x:om_y`）。
- 触发器 ID 用 `triggerKey(record, local, ...)`：GitLab `note` / `issue` / `mr` 与旧 `key('gitlab-note'|'gitlab-issue'|'gitlab-mr', ...)` 在默认记录下完全一致；飞书用 `key(record, messageId)`，默认记录下与旧 `key('feishu', messageId)` 一致。
- KV 键族统一加 `record` 名称段（U4 已确立的例外，升级后重建游标）：
  - `gitlab-cursor:<record>:<stream>`、`gitlab-notes:<record>:<issue|mr>:<iid>`
  - `feishu-chats:<record>`、`feishu-history:<record>:<chat>`、`feishu-history-threads:<record>:<chat>`
  - `feishu-thread-seen:<threadKey>` / `feishu-thread-initialized:<threadKey>` 保持不变（线程键已含记录）。
- `source-labels:<record>` 已按记录命名，飞书标签改用 `ctx.id`。
- 健康条目继续用本地名 `feishu` / `history`，由 `healthNames(record, ...)` 统一加前缀，`ctx.report` 不改。

## 改动清单

### GitLab

1. `src/sources/gitlab-trigger.ts`
   - `gitlabChannel(record, iid, isPr, url?)`：`source: record`，`thread: threadKey(record, gitlabThread(...))`。
   - `author(record, user, agent)`：`actor.source = record`。
   - `noteTrigger(record, note, ref, agent)` / `issueTrigger(record, item, agent)` / `pullTrigger(record, item, agent)`：`source: record`、`threads[0].source = record`、ID 改 `triggerKey(record, 'note'|'issue'|'mr', ...)`。
2. `src/sources/gitlab.ts`
   - `find(instance, query)` 用 `threadKey(instance.id, gitlabThread(...))` 生成线程；`values` 判据改 `trigger?.threads[0]?.source === source?.id`。
   - 轮询：`KV.gitlab.cursor(ctx.id, stream)`、`KV.gitlab.notes(ctx.id, gitlabThread(...))`、`round.read.add(threadKey(ctx.id, ...))`、`ctx.threads.subscribed(ctx.id)`、`pollEach(ctx, ctx.id, ...)`、`nameThread` 用 `threadKey(ctx.id, ...)`、`ctx.receive(...Trigger(ctx.id, ...))`。
3. `src/sources/gitlab-channel.ts`
   - 链接缺省地址按记录实例拼接：`webBaseOf(links.gitlab?.instanceUrl ?? '', GITLAB_WEB)` + `/{project}/-/{issues|merge_requests}/{n}`（复用 `webBaseOf`）。
4. `src/infra/commands.ts`
   - `hostEnvironment()` 增加 GitLab 分支：有 `instanceUrl` 时注入 `GITLAB_HOST`（复用 `hostOf`），与 GitHub 的 `GH_HOST` 并列。

### 飞书

5. `src/sources/feishu-trigger.ts`
   - `feishuChannel(record, chatId, messageId, direct?)`、`feishuTriggerId(record, messageId) = key(record, messageId)`。
   - `feishuTrigger(record, input, botId, botAppId)`：触发器/线程/actor 的 `source` 用 `record`。
   - `feishuParent` / `feishuRef` 用 `trigger.source` 作为记录；`feishuRef` 的存在性判据改为「meta 有 chatId + messageId」，不再比较固定 `SOURCE`。
6. `src/sources/feishu.ts`
   - `repliesTo` 用 `feishuTriggerId(trigger.source, parentId)`；`values` 判据改 `trigger?.threads[0]?.source === source?.id`。
7. `src/sources/feishu-loops.ts`
   - 所有 `KV.sources.labels(SOURCE)` → `KV.sources.labels(ctx.id)`；`KV.feishu.chats/history/topics` 传 `ctx.id`；`feishuTrigger(ctx.id, ...)`；`ctx.threads.subscribed(ctx.id)`；`pollEach(ctx, ctx.id, ...)`。
8. `src/sources/feishu-channel.ts`
   - `feishuLink` 的 `triggerId` 用 `feishuTriggerId(links.feishu?.id ?? SOURCE, address.messageId)`。
9. `src/app/links.ts` / `src/app/runtime.ts` / `src/app/resources.ts`
   - `feishuSettings(host.sources, trigger.source)`；`feishuPageSize(source?: string)` 按记录取分页大小，`feishu/` 资源路由传 `source.source`；`trigger/` 路由用 `feishuTriggerId(found.source, parentId)` 找回父触发器。

### KV 与迁移

10. `src/kv.ts`：`KV.gitlab`、`KV.feishu` 三个键族加 `record` 段（见上）。
11. `src/app/migration.ts`：模式 10→11 的飞书迁移只读旧键名（无记录段），用迁移内部的旧键常量读取/回写，避免与运行时新键混淆；测试同步为旧键字面量。

## 测试

- 更新既有调用点：`tests/gitlab.spec.ts`、`tests/sources.spec.ts`（飞书）、`tests/runtime.spec.ts`、`tests/registry.spec.ts`、`tests/commands.spec.ts`、`tests/migration.spec.ts`、`tests/fixtures/host.ts`、`tests/fixtures/deployment.ts` 等，补记录参数与新 KV 键。
- 新增用例：
  1. 两条 GitLab 记录：`#12` 搜索产物为 `gitlab:issue:12` 与 `gitlab-a:issue:12`；note 触发器 ID/线程/KV 键互不冲突。
  2. 两条飞书记录：同一 `chatId/messageId` 在两记录下触发器 ID、线程键、`feishu-history`/`chats` 键相互隔离；`repliesTo` 只认本记录。
  3. 自建 GitLab：`gitlabLink` 用实例地址生成网页链接，`Commands.hostEnvironment()` 注入 `GITLAB_HOST`（默认 gitlab.com 不注入）。
  4. 飞书分页大小与链接超时按记录读取。

## 验证

```
pnpm typecheck
pnpm test      # 全量，0 跳过，基线 1221 条
pnpm build
```

## 交付前必做（写入方案文档与交付清单，逐条对照）

- **U6a 多记录执行侧闭环**：`gh` 垫片按工单来源记录选择 CLI 与账号；执行环境变量按工单来源记录注入，删除全局同名覆盖与「第一条记录」回退。完成后核对：两条 GitHub 记录并存时，工单在其来源账号下执行。
- **U6b 资源路由按记录区分**：`github/issues/<n>` 等资源路径带记录段（或等价机制），主会话多记录时可区分；飞书/GitLab 同类资源路径同口径。完成后核对：两条同名编号记录可分别读取。

两项都必须在交付清单中标记为「已完成并验证」，不得以「已声明范围边界」代替交付。

## 交付

改完自测通过后以 `refactor:` 风格提交并推送，停下汇报 U5 改动、验证数字与 U6a/U6b 排期。
