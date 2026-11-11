# 009 来源记录

本文说明 dsh-superagent 的来源模型：来源是用户数据，不是插件开关。它取代早期「每种类型一个来源、通过在 profile 的 `cordis.patch.yml` 中启用插件来开启」的模型。本文只描述新模型，不保留旧模型说明。

## 为什么

早期模型把来源类型（GitHub、GitLab、飞书）直接当作配置键，每种类型只能有一个实例，GitLab 与飞书还要改配置文件才能启用。这与实际使用冲突：

- 一个团队可能同时接入多个 GitHub Enterprise 实例、多个自建 GitLab、多个飞书机器人；
- 来源的增删启停属于日常操作，应当由面板完成，而不是编辑 profile；
- 单个来源配置错误不应拖垮其他来源。

因此来源改为记录列表：每条记录独立配置、独立轮询、独立健康状态；面板与管理 API 是唯一操作入口。

## 记录模型

`Settings.sources` 是以记录 ID 为键的对象：

```json
{
  "github": {
    "kind": "github",
    "name": "核心仓",
    "enabled": true,
    "config": {
      "instanceUrl": "",
      "cli": "gh",
      "repository": "owner/repo",
      "streams": ["issues", "pulls"],
      "authors": []
    }
  },
  "gl-internal": {
    "kind": "gitlab",
    "name": "内部 GitLab",
    "enabled": true,
    "config": {
      "instanceUrl": "https://gitlab.example.com",
      "cli": "glab-internal",
      "project": "group/project",
      "labels": []
    }
  }
}
```

字段：

| 字段 | 说明 |
| --- | --- |
| 记录 ID（对象键） | `^[a-z][a-z0-9-]*$`，全仓唯一；创建时由服务端生成（`kind`、`kind-2`…）或校验客户端提供的值 |
| `kind` | 适配器类型：`github` / `gitlab` / `feishu`；新增类型只需新增适配器 |
| `name` | 必填的项目显示名称（1–80 字符），只影响界面标题，不参与身份；旧设置缺少该字段时在加载阶段用记录 ID 补齐 |
| `enabled` | 启用状态；停用后不轮询、不接收新触发器，已有工单不受影响 |
| `config.instanceUrl` | 实例地址；留空表示官方站点。GitHub Enterprise 与自建 GitLab 必填 |
| `config.cli` | 凭据引用：已登录的 CLI 包装或命令名；登录态由 CLI 自身保存，不写入设置 |
| `config.repository` / `project` | 仓库或项目标识 |
| `config.auth` | 代码仓库认证方式：`https`（默认，使用该记录的 CLI 凭据）或 `ssh`（使用本机 SSH key，不运行 `gh`/`glab`） |
| `config.remote` | 可选自定义远端地址；`https://`、`ssh://` 或 `user@host:path`，不得内嵌账号密码。留空时按 `auth` 推导 |
| `config.sshKey` | `auth = ssh` 时的私钥路径（绝对路径或 `~/...`）；留空使用本机默认 key 与 SSH 配置 |
| `config` 其余字段 | 轮询与过滤参数，由各适配器 schema 定义并在面板渲染 |

新增来源不要求任何默认记录；首次使用由面板创建，必须填写项目名称。所有记录地位相同，没有「主记录」。

GitHub / GitLab 记录只作为代码仓库，提供代码数据而不提供任务；系统任务只来自任务来源（Excel 文件、飞书知识库，见 `docs/011-projects-and-scheduling.md`）。

## 记录 ID 即来源身份

| 位置 | 规则 |
| --- | --- |
| `trigger.source`、`channel.source` | 记录 ID |
| `policy.sources` 键 | 记录 ID |
| 线程键 | `<记录ID>:<类型内后缀>`，例如 `github-2:issue:12`、`gl-internal:mr:7` |
| 触发器去重 ID | `key('<记录ID>-issue', 编号)`，天然按记录隔离 |
| KV 键 | `github-stream:<记录ID>:<stream>`、`gitlab-cursor:<记录ID>:<stream>`、`source-labels:<记录ID>` |
| 健康项 | 首个声明名使用 `<记录ID>`，其余 `<记录ID>:<名称>`，例如 `gl-internal:history` |
| 环境变量 | `DSH_SUPERAGENT_SOURCE` 为记录 ID；记录自己的变量沿用适配器声明的名称，值按记录解析，工单只注入其来源记录的变量 |

所有身份拼接集中在 `src/sources/identity.ts`，禁止在适配器里散落字符串拼接。

## 适配器与注册表

内置适配器在 `src/index.ts` 注册，随主插件加载，不再有 `github-watch` / `feishu-watch` / `gitlab-watch` 插件条目。每个适配器导出：

```ts
interface SourceAdapter {
  kind: SourceKind
  watch(host: SourceHost): Promise<void>
}
```

`SourceRegistry` 保留按类型注册一次的结构：`register(kind)`、`instances(settings)`、`instance(id)`、`kindOf(id)`、`send`、`link`、`threadContext`、`healthEntries`。新增类型只需：

1. 新增适配器文件并导出 `SourceAdapter`；
2. 在 `src/index.ts` 的内置适配器清单中登记；
3. 如有新字段，在适配器 schema 中声明，面板会自动渲染。

核心流程（轮询调度、触发器入队、策略、出站、健康）不需要改动。

## 多实例运行

每个适配器持有若干记录，逐条记录维护：

- 独立游标（KV 命名空间按记录隔离）；
- 独立健康项与失败计数；
- 独立下次轮询时间；
- 独立的解析结果与命令作用域（记录自己的 CLI 与实例地址）。

启用、停用、删除立即生效；一条记录失败只暂停该记录，并在面板显示可读原因，其他记录继续运行。

## 校验、错误与删除

- 记录级校验失败不改写 `enabled`，不静默禁用；失败原因写入该记录 `problem`，包含字段路径与中文说明。
- 管理 API 错误形状：`{ "error": "…", "issues": [{ "path": "config.repository", "message": "…" }] }`，覆盖重复 ID、未知类型、非法 ID、缺少必填、实例地址非法、凭据不可用。
- 删除记录：有未结束工单（open/claimed/running）时返回 `409` 并说明数量；删除成功后释放健康项、停止该记录轮询、清理策略部分，保留历史线程与消息记录。

## 凭据与实例地址

凭据沿用现有机制：`config.cli` 指向已登录的 `gh`、`glab` 或 `lark-cli` 包装/命令。不新增明文凭据存储。

实例地址通过环境变量传给 CLI：

- GitHub Enterprise：`GH_HOST=<instanceUrl 主机名>`；
- 自建 GitLab：`GITLAB_HOST=<instanceUrl 主机名>`；
- 官方站点：不设置，沿用 CLI 默认值。

需要独立身份的实例，为它准备一个独立的 CLI 包装（例如设置独立 `GH_CONFIG_DIR`），并把 `config.cli` 指向该包装。

## 管理 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/orchestrator/api/settings` | 来源记录卡片与 `kinds` 类型目录 |
| `PUT` | `/orchestrator/api/settings/source:<id>` | 更新 `{ name, enabled, config }`，含启停与项目名称 |
| `GET` | `/orchestrator/api/sources` | 运行状态与健康 |
| `POST` | `/orchestrator/api/sources` | 创建记录，body `{ kind, id?, name, config? }`，返回 `{ id, revision, restarting }` |
| `POST` | `/orchestrator/api/sources/verify` | 字段级预检；body `{ kind, id?, name?, config?, field? }`（`field` 默认 `all`），返回 `{ checks }`；名称按必填校验，真实运行 CLI、读取任务清单或知识库，不写设置、不重启 |
| `DELETE` | `/orchestrator/api/sources/:id` | 删除记录，返回 `{ removed, restarting }`；有未结束工单时 `409`；记录不存在时 `400`（`sourceNotInstalled`） |
| `GET` | `/orchestrator/api/health` | 插件注册阶段、初始化状态、监听地址与记录健康摘要 |

所有管理路由要求 `x-orchestrator-request: 1`，并校验 Host 与同源。

## 启动诊断与 404

桌面版曾出现 `/orchestrator` 前缀整体未注册（空体 404）。现在：

- 管理路由在 `Runtime` 创建之前就注册（`src/app/admin-mount.ts`），初始化任何步骤失败都不会卸载它。
- 请求时校验 Host 白名单（`127.0.0.1`、`localhost`、`[::1]` 与实际端口），非回环或非同源请求返回 `403`；注册不再依赖 `webServer.host`。
- 锁竞争不再立即失败：`acquireStateLock` 最多等待 35 秒（覆盖强杀后 30 秒的锁过期窗口），超时以 `ELOCKED` 结束并进入 `locked` 阶段。
- 运行时就绪前的接口约定：`GET /orchestrator/api/health` 返回 `200`，带 `phase`、`detail`、`error` 与 `stateDir`；其余接口返回 `503`，body 为 `{ error, code: "startupPending", phase, detail, stateDir }`，不再返回空体。
- 启动记录 `stateDir/startup.json` 包含时间戳、pid、监听 host/port、阶段（`starting`、`http-registered`、`locked`、`store-open`、`ready`、`failed`）、说明与异常（name/message/stack）；上一份保留为 `startup.prev.json`。
- 面板把 503 `startupPending` 显示为本地化的启动诊断，指向阶段、原因与 `stateDir`。
- 2026-11-10 定位到第二个启动失败原因：主会话的工具限制命名了 `bash`，而 Windows 上的 DSH 只提供 `pwsh`，`tools.restrict` 在创建或恢复主会话时抛错；现在只限制宿主实际提供的 shell，`noWait` 对 `bash` 与 `pwsh` 同口径。

排查步骤见 [006 部署](006-deployment.md) 的故障排查一节。

## 不迁移旧配置

本次是全新模型：不读取、不转换旧的单来源配置。升级后需要在面板重新添加来源。旧线程、旧策略与旧 KV 数据不属于新模型，不做兼容。

## 交付清单

状态与逐条证据见 `verification/2026-11-10-u8-delivery.md`；真实租户、面板点击等未验证项及其原因也在该记录第 5 节。

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 记录模型与字段校验 | 已交付 | `tests/settings.spec.ts`、`tests/policy.spec.ts` |
| 同类型多记录、独立轮询与健康 | 已交付 | `tests/registry.spec.ts`、`tests/views.spec.ts` |
| 面板增删改启停 | 已交付 | `tests/http.spec.ts`、`tests/panel-source.spec.tsx`、桌面产物实测 POST/DELETE |
| 可读校验错误、不静默禁用 | 已交付 | `tests/settings.spec.ts`、`tests/registry.spec.ts` |
| 旧模型与兼容分支清除 | 已交付 | 全仓检索、文档与示例配置校准 |
| 适配器注册表与新增类型流程 | 已交付 | `src/sources/adapters.ts`、`tests/registry.spec.ts` |
| 凭据与实例地址 | 已交付（真实租户未验证） | `tests/deployment.spec.ts`、`tests/resources.spec.ts` |
| 404 加固与可诊断性 | 已交付 | `tests/startup.spec.ts`、`tests/index.spec.ts`、`verification/2026-11-10-desktop-404.md` |
| 全量测试、构建、桌面安装 | 已交付 | `pnpm check`、`verification/2026-11-10-u8-delivery.md` |
