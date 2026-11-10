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
| `enabled` | 启用状态；停用后不轮询、不接收新触发器，已有工单不受影响 |
| `config.instanceUrl` | 实例地址；留空表示官方站点。GitHub Enterprise 与自建 GitLab 必填 |
| `config.cli` | 凭据引用：已登录的 CLI 包装或命令名；登录态由 CLI 自身保存，不写入设置 |
| `config.repository` / `project` | 仓库或项目标识 |
| `config` 其余字段 | 轮询与过滤参数，由各适配器 schema 定义并在面板渲染 |

新增来源不要求任何默认记录；首次使用由面板创建。所有记录地位相同，没有「主记录」。

## 记录 ID 即来源身份

| 位置 | 规则 |
| --- | --- |
| `trigger.source`、`channel.source` | 记录 ID |
| `policy.sources` 键 | 记录 ID |
| 线程键 | `<记录ID>:<类型内后缀>`，例如 `github-2:issue:12`、`gl-internal:mr:7` |
| 触发器去重 ID | `key('<记录ID>-issue', 编号)`，天然按记录隔离 |
| KV 键 | `github-stream:<记录ID>:<stream>`、`gitlab-cursor:<记录ID>:<stream>`、`source-labels:<记录ID>` |
| 健康项 | 首个声明名使用 `<记录ID>`，其余 `<记录ID>:<名称>`，例如 `gl-internal:history` |
| 环境变量 | `DSH_SUPERAGENT_SOURCE_<ID>_<FIELD>`（ID 大写、`-` 转 `_`），另有 `DSH_SUPERAGENT_SOURCE_ID` 与 `DSH_SUPERAGENT_SOURCE_KIND` |

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
| `PUT` | `/orchestrator/api/settings/source:<id>` | 更新 `{ enabled, config }`，含启停 |
| `GET` | `/orchestrator/api/sources` | 运行状态与健康 |
| `POST` | `/orchestrator/api/sources` | 创建记录，body `{ kind, id?, config? }` |
| `DELETE` | `/orchestrator/api/sources/:id` | 删除记录；有未结束工单时 `409` |
| `GET` | `/orchestrator/api/health` | 插件注册阶段、初始化状态、监听地址与记录健康摘要 |

所有管理路由要求 `x-orchestrator-request: 1`，并校验 Host 与同源。

## 启动诊断与 404

桌面版曾出现 `/orchestrator` 前缀整体未注册（空体 404）。新实现：

- HTTP 注册不再依赖 `webServer.host === '127.0.0.1'`；请求时校验 Host 白名单，非回环请求返回 `403`。
- 初始化任何步骤失败都不再让插件注册回滚；失败写入结构化日志、`stateDir/startup.json` 与健康接口。
- 启动记录包含：时间戳、pid、监听端口与 host、构建版本、阶段（`locked`、`store-open`、`http-registered`、`ready`、`failed`）、错误码与错误栈；上一份保留为 `startup.prev.json`。
- 面板在收到空体 404 时显示诊断提示，指向 `stateDir` 与启动记录位置。

排查步骤见 [006 部署](006-deployment.md) 的故障排查一节。

## 不迁移旧配置

本次是全新模型：不读取、不转换旧的单来源配置。升级后需要在面板重新添加来源。旧线程、旧策略与旧 KV 数据不属于新模型，不做兼容。

## 交付清单

| 项 | 状态标记方式 |
| --- | --- |
| 记录模型与字段校验 | schema 单测 |
| 同类型多记录、独立轮询与健康 | 注册表与适配器测试 |
| 面板增删改启停 | HTTP 与面板测试 |
| 可读校验错误、不静默禁用 | 反向用例 |
| 旧模型与兼容分支清除 | 全仓检索与文档审查 |
| 适配器注册表与新增类型流程 | 类型目录与注册测试 |
| 凭据与实例地址 | 部署解析测试、链接测试 |
| 404 加固与可诊断性 | 单元测试、桌面连续启动观测 |
| 全量测试、构建、桌面验证 | `pnpm check`、`verification/` 记录 |
