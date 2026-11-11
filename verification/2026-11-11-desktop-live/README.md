# 桌面版直连验证与热加载实测（2026-11-11）

本目录记录两件事：桌面版 DeepSeek Harness 里的**真实**端到端执行，以及它对已链接插件的**热加载**行为。
两项都基于本机实测，证据在 `result.json` 与 `result-hot-reload.json`。

## 环境

- 桌面版 0.2.2-rc.1，`C:\Users\61054\AppData\Local\Programs\DeepSeek Harness`，内置 CLI 不进 PATH。
- 插件以目录联接挂到桌面 profile：`C:\Users\61054\.dsh\profiles\desktop\node_modules\dsh-superagent` → `D:\dsh-superagent`。
- 状态目录 `C:\Users\61054\.dsh\state\superagent`；就绪后 `startup.json` 给出管理接口端口。
- 管理接口只监听回环地址，请求必须带 `x-orchestrator-request: 1`，`Host` 必须是 `127.0.0.1:<端口>`。
- 桌面应用需用 WMI 启动才常驻（`Start-Process` 的子进程会随命令结束被杀）：
  `([wmiclass]'Win32_Process').Create('"…\DeepSeek Harness.exe"')`。

## 端到端验证（`run-live.ts`）

本机访问不了 github.com，而部署解析只接受 `https://`、`http://`、`ssh://` 或 `user@host:` 形式的远端，
本地磁盘路径会被拒绝。因此验证脚本在进程内起一个**只读静态 HTTP 服务**，用 git 的 dumb 协议托管一个临时裸库，
代码仓库记录使用 `auth: 'ssh'`（该模式不解析 GitHub 账号，也不运行 `gh`），并把 `remote` 指向这个本地服务。
这不是假执行器：调度、同步、拆分、建单、DSH 会话执行、状态回写全部是桌面版里的真实实现，
只有 git 远端换成了本机 HTTP 服务。

流程与结果（`result.json` 的 `phases`）：

1. 等待插件 ready，清理上一次验证的项目、任务来源、代码仓库与工作副本。
2. 初始化临时裸库，提交带 BOM + CRLF 的 `tasks/backlog.csv`，起 HTTP 服务。
3. 通过 `POST /code-repos` + `PUT /settings/codeRepo:<id>` 建仓库；保存设置会触发插件重挂载，
   脚本按新的 `startup.json` 重新取端口并等 ready。
4. 通过 `POST /task-sources`、`POST /projects` 建 Excel 任务来源与项目（两者读取实时设置，不再重启）。
5. 15 秒调度轮询完成真实同步、拆分与建单，队列条目进入 `running`。
6. 桌面版用真实 DSH 会话执行工单，会话调用 `orchestrator_report` 报告 `state=ready`、`summary=desktop-live-ok`。
7. 工单 `ended.by = "executor"`、`outcome = "completed"`，队列条目结算为 `succeeded`。
8. 回写副作用把状态写回 CSV，`done`，BOM 与 CRLF 均保留。
9. 停止项目轮询（远端服务随脚本退出，避免每分钟连接失败）。

关键证据（`result.json`）：

- `ticket`：工单 ID、`ended`、`assignments[].report`（`ready` / `desktop-live-ok`）。
- `ticket.workspace`：真实执行工作区，位于 `…\state\superagent\work\桌面直连验证\<工单 ID>`。
- `writeback`：回写后的 CSV 路径、`bom: true`、`crlf: true` 与全文。
- 工单 ID 由触发器键派生，脚本每次使用唯一任务 ID（`LIVE-<时间戳>`），避免命中上一次已结束的工单而跳过真实执行。

### 重跑

```powershell
# 前置：桌面版已加载插件，state\superagent\startup.json 为 ready
node --experimental-transform-types verification/2026-11-11-desktop-live/run-live.ts
```

脚本可重复运行：开头会删除 `live-*` 三个记录与对应工作副本。

## 热加载实测（`run-hot-reload.ts`）

用行为级标记判断：把 `lib/index.js` 里健康探针的就绪描述替换成带唯一标记的文本，
再看 `GET /orchestrator/api/health` 的 `detail` 是否出现该标记。`startup.json` 的 `at` 用于判断插件是否重挂载。

| 操作 | 观察 |
| --- | --- |
| 只改 `lib/index.js`，等 20 秒 | 详情不变（`seen: false`）：**没有文件监听式自动重载** |
| 追加一行注释到 profile 的 `cordis.patch.yml`（触发 profile 重组） | 3.0 秒后详情出现标记；`startup.json.at` 更新；pid 与端口不变 |
| 恢复产物并再次触发重组 | 3.1 秒后标记消失，恢复原行为 |

结论：

- 重载粒度是**插件（bundle 的 Loader 条目）**：插件被重新求值并重启，宿主进程、端口与状态目录锁都不变。
- 代码变更不会自己生效，需要一次 **profile 重组**触发；桌面版的 `hmr` 是 `root: []`，不监听源码/产物文件。
  profile patch 编辑、插件管理操作都会触发重组。
- 重载前后持久化状态不丢：`projects`、`taskSources`、`codeRepos` 各 1 条，队列条目 1 条，前后一致
  （`result-hot-reload.json` 的 `baselineState` 与 `final.state`）。内存中的调度计时器会重建，状态来自状态库。
- 失败回退：官方 `@deepseek-ai/dsh-hmr` 的 README 明确说明，导入或启动失败的替换版本保持未激活，
  **不会恢复旧版本**。本次未做失败注入（会在恢复前把桌面版插件置于不可用状态），该条以文档为准，未实测。
- profile 配置变更（如 `bundles`、`stateDir` 补丁）同样在该次重组中生效；需要重启的是宿主模块/原生依赖变更、
  包目录被移动，或加载器报告 `restart-required`（例如不支持 HMR 的 headless 宿主）。

### 后续验证流程

1. 改源码 → `pnpm build`（产物在 `lib/`）。
2. 触发一次 profile 重组（编辑 `cordis.patch.yml` 的注释或使用插件管理操作），不必重启应用。
3. 等 3 秒左右看 `startup.json.at` 与健康探针行为是否更新；异常时先恢复产物再触发一次重组。
4. 只有依赖树/原生模块/宿主版本变化，或重组后仍报 `restart-required` 时才重启桌面应用。

## 未覆盖

- 失败注入（替换版本导入失败）下的回退行为：仅引用官方文档，未实测。
- 飞书知识库任务来源：仍未验证，本目录不包含它的验证。
- 真实公网 GitHub 远端：本机网络不可达，改用本机 HTTP 服务替代远端。
