# U4 实施计划：GitHub 适配器多实例、实例地址与命名空间

## Context

来源已改为「用户数据记录」模型（`Settings.sources = Record<记录ID, SourceInstance>`），记录 ID 是来源身份。U3 已完成按记录解析部署与凭据，但 GitHub 适配器内部仍沿用单实例假设：

- 线程键硬编码 `github:<number>`、`github:ci:<branch>`；
- 触发器 ID 前缀硬编码 `github-*`，`threads[].source`/`actor.source` 固定为 `'github'`；
- KV 键（`github-since`、`github-cursor:<n>`、`github-stream:<id>`、`github-branch-ci`、`github-ci:<n>`）全局共享；
- 页面链接与 API 地址硬编码 `github.com` / `api.github.com`；
- `SourceKind.find(query)` 无记录参数，搜索无法落到具体记录；
- 执行器会话的 `host.github` 固定取第一条 GitHub 记录。

结果：同时存在两条 GitHub 记录（例如 github.com 与 GH Enterprise）时，线程、触发器、游标、CI 指纹会互相踩踏，企业实例的链接和 `gh` 调用会打到 github.com。U4 只修这些，不进入 U5（GitLab/飞书命名空间）。

## 方案

统一使用 `src/sources/identity.ts` 已有的 `threadKey(record, local)`、`triggerKey(record, local, ...parts)` 与 `KV` 的 `family` 多段键。记录 ID 为 `github` 时，产物与现状字节一致（`github:42`、`github-issue:5`），因此默认单记录行为不变。

### 1. `src/sources/github-trigger.ts`

- `githubChannel(record: string, number, url?)`：`source` 与 `thread` 用记录 ID（`threadKey(record, String(number))`）。
- `githubPage(instanceUrl, repository, number, pr = false)`：`webBaseOf(instanceUrl, 'https://github.com')` 去尾部 `/` 后拼 `/<repository>/(pull|issues)/<n>`。
- `githubAddress(url, repository, instanceUrl = '')`：改为解析 URL 后按前缀匹配：
  - Web：`<webBase>/<owner>/<repo>/(issues|pull)/<n>[/][#...]`；
  - API：`<apiBase>/repos/<owner>/<repo>/(issues|pulls)/<n>`，其中 `apiBase` 为 `https://api.github.com`（空实例）或 `<instanceUrl>/api/v3`；
  - 主机比较忽略大小写，仓库继续用 `sameName`；`#discussion_r<id>` 仍解析为 `discussion`；
  - 实例地址与 URL 主机不匹配时返回 `undefined`（默认实例不认企业 URL，反之亦然）。
- `commentTrigger`/`issueTrigger`/`pullTrigger`/`branchCiTrigger`/`ciTrigger`/`author` 第一个参数改为 `record: string`：`source: record`、`threads: [{ source: record, id }]`，触发器 ID 改用 `triggerKey(record, 'comment'|'issue'|'ci', ...)`（其余分段保持不变）。

### 2. `src/sources/github.ts`

- 所有 `githubChannel`/触发器调用传 `ctx.id`。
- 线程键：`threadKey(ctx.id, String(number))`、`threadKey(ctx.id, `ci:${branch}`)`。
- KV 全部按记录分段：`KV.github.since(ctx.id)`、`.retries(ctx.id)`、`.cursor(ctx.id, number)`、`.stream(ctx.id, stream)`、`.branchCi(ctx.id)`、`.ci(ctx.id, number)`。
- `pollThreads` 改传 `ctx.id`（订阅线程按记录隔离）。
- `pollBranchCi` 的 commit 链接改用 `githubPage`/`webBaseOf` 与记录实例地址。
- `facts`/`values` 用 `source.id` 判断触发器是否属于本条记录（不再比较字面量 `'github'`）。
- `find(instance, query)`：从 `instance.config` 取 `repository`、`instanceUrl`；支持 `#12`/`12` 与完整 Web/API URL；返回 `threadKey(instance.id, number)`。
- `health` 仍声明 `['github']`（`healthNames` 会生成 `<记录ID>`），不变。

### 3. `src/sources/kind.ts` 与 `src/sources/registry.ts`

- `SourceKind.find?(instance: SourceInstance, query)`。
- `ChannelLinks` 增加 `github?: ResolvedGithubSource`（保留 `repository` 会被删除）。
- `SourceRegistry.find(query)` 改为遍历 `this.instances()`，逐条调用已安装种类的 `find(instance, query)`；未安装/无记录的适配器不产出线程。

### 4. `src/sources/github-channel.ts`

- `sendGithub` 调用 `githubAddress(url, github.repository, github.instanceUrl)`。
- `githubLink(address, links)` 从 `links.github` 取实例与仓库：URL 缺省时用 `githubPage`，评审线程判断也带实例地址；缺少部署信息时 URL 为空。
- `github-pull.ts` 的 `pullEndNotices` 已按线程前缀解析记录；页面链接改用记录的 `instanceUrl`/`repository`，并把「非 GitHub 频道」判断改为 `sources[channel.source]?.kind !== 'github'`（不再写死 `'github'`）。

### 5. `src/sources/github-pull.ts`

- `pullNumber(thread, record?)`：拆第一段为 source、其余为 local，仅当 local 全为数字时返回数字；传 `record` 时要求前缀相等。
- `pullsOf(ticket, open, record?)`；`claimPull`/`observePull`/`closePull`/`pollTicketPulls` 传 `ctx.id`，绑定/关闭线程的 `{ source }` 改为 `ctx.id`，关注线程查找用 `threadKey(ctx.id, ...)`；来源判断用 `origin.source === ctx.id`。
- 卡片用的 `pullOf(ticket)` 保持「任意记录的数字线程」这一宽松语义。

### 6. `src/infra/commands.ts`

- `run` 的环境在 GitHub 记录配置了 `instanceUrl` 时注入 `GH_HOST=hostOf(instanceUrl, '')`（企业实例的 `gh` 调用路由）；默认实例不注入，保持现状。

### 7. `src/app/runtime.ts`

- `links()` 按频道记录把解析出的 GitHub 来源放入 `{ github: source }`。
- `toolHost.github` 改为按工单来源记录解析：`ExecutorToolsHost` 增加 `githubFor(source: string): SourceContext | undefined`；`executorTools` 用 `ticket.origin.source` 取上下文（`claimPull`/`readPull` 不再固定第一条记录）。
- 执行器工具的 `readResource` 传 `{ ...host.resources, commands: host.resources.commands.scope(ticket.origin.source) }`，使 `github/` 读取使用工单所属记录的仓库与实例；`resources.ts` 的 `feishu/` 路由同时改为 `commands.scope(trigger.source)`（跨记录跟随时读对账号）。

### 8. `src/kv.ts`

把 `KV.github` 的键族改为记录分段（类型不变，仅多一个 `record: string` 名称段）：

```ts
github: { since: family<string, [record: string]>('github-since:'), retries: family<Record<string, Retry>, [record: string]>('github-retry:'),
  cursor: family<string, [record: string, number: number]>('github-cursor:'),
  stream: family<{...}, [record: string, stream: string]>('github-stream:'),
  branchCi: family<{...}, [record: string]>('github-branch-ci:'),
  ci: family<{...}, [record: string, number: number]>('github-ci:') }
```

产物：`github-since:github`、`github-cursor:github:7`、`github-stream:github:issues`、`github-ci:github:42`。同步更新注释。

## 契约变化（测试需改）

- `githubChannel(record, number, url?)`、触发器构造函数首参 `record`。
- `ChannelLinks.repository` → `ChannelLinks.github`。
- `SourceKind.find(instance, query)`；`registry.find` 只搜索已有记录（无记录时返回空）。
- `KV.github.*` 多一个记录参数；键值带记录段。
- `ExecutorToolsHost.github` → `githubFor(source)`。

## 测试计划

更新现有用例的调用签名与 KV 键：
- `tests/commands.spec.ts`：`githubChannel('github', 8)`；`links` 改 `{ github: testGithub(...) }`。
- `tests/sources.spec.ts`：触发器构造函数补 `'github'`；`store.get('github-cursor:7')` → `KV.github.cursor('github', 7)`。
- `tests/runtime.spec.ts`：`githubChannel('github', 7)`；`'github-since'` → `'github-since:github'`。
- `tests/registry.spec.ts`：`find` 需要记录，补 github 记录配置（`repository`/`instanceUrl`）；断言线程带记录前缀。
- `tests/fixtures/panel-server.ts`：`githubChannel('github', 42)`。

新增用例（净增覆盖，不删旧断言）：
1. `githubAddress`/`githubPage` 企业实例：Web/API/评审深链均识别，错误主机被拒绝；默认实例不认企业 URL。
2. `githubLink` 用记录实例与仓库生成企业页面；缺 `links.github` 时 URL 为空。
3. 两条 GitHub 记录隔离：`githubChannel('github-b', 7)` 的 `source`/`thread`、`commentTrigger('github-b', ...)` 的 ID 前缀与线程、`KV.github.cursor('github-b', 9)` 与默认记录互不影响；用第二条记录的 `SourceContext` 轮询一个订阅线程，断言接收到的触发器 `threads[0].source === 'github-b'`，且默认记录的游标键未被写入。
4. `Commands` 在企业实例记录下运行时环境包含 `GH_HOST`，默认实例不包含。
5. `registry.find` 在企业实例记录下把企业 URL 映射到该记录的线程，github.com URL 不落到该记录。

## 验证

```
pnpm typecheck
pnpm test        # 全量、0 跳过、0 失败
pnpm build
```
然后 `git add` 相关文件 → 提交（沿用 `refactor:` 风格）→ 推送 `main`。

## 范围边界（本轮不做，汇报中说明）

- 执行环境变量仍是全局名（`DSH_SUPERAGENT_GITHUB_*`），多记录时同名变量会互相覆盖；需要产品口径（工单只看来源记录还是全部记录）后再定，不在 U4。
- 资源路由 `github/issues/<n>` 不带记录段；主会话读取多记录时仍无法区分记录。执行器已按工单记录限定，主会话路由命名留待后续单元。
- worker 的 `gh` 垫片仍指向第一条记录的 CLI；按记录选择 CLI/账号需与执行环境单元一起处理。
- GitLab/飞书的 KV 与线程命名空间属 U5。
