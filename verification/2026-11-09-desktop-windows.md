# Windows 桌面端运行记录：观察到的结果

日期：2026-11-09，Asia/Shanghai。仓库 `D:\dsh-superagent`，本记录之前的提交：`fb54430`
（`fix: run the bundle on Windows`）。撰写时没有任何内容被推送。

本记录区分**在桌面应用中观察到的**与**未验证的**。每个观察值都可以从旁边给出的命令或文件重新核对。

## 干净启动

记录：`cleanup-20261109-223303.json`（保存在 git 之外，与运行产物一起）。

- 把 `C:\Users\61054\.dsh\sessions` 重命名为 `sessions.cleared-20261109-223303`；`state\superagent` 当时还不存在。
- 删除 `%APPDATA%\@deepseek-ai\dsh-desktop` 下的 `Cache`、`Code Cache`、`GPUCache`、`GPUPersistentCache`、`GrShaderCache`、`Dawn*`、`ShaderCache` 和 `Shared Dictionary`。
- 未改动配置和凭据。

## 启动

- 主进程 `DeepSeek Harness.exe` pid 11716，启动时间 22:37:39；22:37:40 有四个子进程（pid 16224、18608、44148、52576）。用 `Get-Process` 观察。
- 日志 `.artifacts\desktop-20261109-224200.out.log` 第 4 行：`dsh web: http://127.0.0.1:51056/?token=…`。

## 配置与部署检查

桌面 profile `C:\Users\61054\.dsh\profiles\desktop`（原始文件保存在 `.artifacts\desktop-profile-backup`）：

- `dependencies` 增加了 `"dsh-superagent": "link:D:\\dsh-superagent"`，`bundles` 增加了 `"dsh-superagent"`。pnpm 无法解析跨盘符的 `link:`（它生成了 `…\desktop\D:\dsh-superagent`），因此 `node_modules\dsh-superagent` 是指向 `D:\dsh-superagent` 的目录联接。
- `cordis.patch.yml` 增加了插件，`stateDir: C:/Users/61054/.dsh/state/superagent`。

设置 › 来源（GitHub 卡片）填写了仓库 `martinxiao2025/dsh-superagent` 和 CLI `C:\Users\61054\AppData\Local\Programs\GitHub CLI\gh.exe`。保存后运行了部署检查，卡片原样显示以下文本：

```
智能体的 GitHub CLI 读不到它的账号。 gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.
```

该消息是 `gh` 自己的文本，因此检查解析了 `gh.exe`，通过执行器子进程运行它并读取其输出——第 1 步的 Windows 代码路径在真实应用中得到了验证。

策略：在 设置 › 评估 › 能发起工作的 GitHub 账号 下添加了 `martinxiao2025` 并保存。策略版本从 `9fbbf9a0` 变为 `1895d28f`，概览计数从“系统问题 2”变为“系统问题 1”（“没有人能发起工作…”消失）。剩下的问题是上面的部署检查；执行器显示 执行器等待部署检查。

## 一次真实回合、其工具调用和产物

桌面应用中的新会话，模型 DeepSeek-V4.1-Flash（reasoning High），提示词：在 `C:\Users\61054\AppData\Local\Temp\dsh-harness-probe` 下创建 `ok.txt`，内容为 `harness-ok`，并报告路径。

- 会话 `738a4b6d-6961-4766-826d-2fe8d5599bd9`；回合在 3 秒内完成，“1 轮 3 步 · 278 tok/s”，34.4K tokens。
- 轨迹标签页：`工具，write {"file_path": "C:\Users\61054\AppData\Local\Temp\dsh-harness-probe\ok.txt", "content": "harness-ok\n"}`。
- 文件系统检查：`Length=11`，`CreationTime=2026/11/9 22:41:45`，内容为 `harness-ok`。

这证明了桌面端的 harness 层（模型连通性、一个回合、一次工具调用、磁盘上的产物）。它不是插件包回合：没有来源触发器、工单或执行器参与。

## 未验证

- 部署检查通过；执行器离开 执行器等待部署检查。
- 真实的 GitHub 触发器 → 准入 → 工单 → 执行器会话。
- 执行器产物位于 `C:\Users\61054\.dsh\state\superagent` 下。

受阻于智能体账号的交互式 `gh auth login`。`docs/006-deployment.md` 说安装会移除名称包含 TOKEN 的环境变量，因此 `GH_TOKEN` 也不能代替登录。

## 发布产物与桌面复验（2026-11-10）

`pnpm check`（typecheck、61 个测试文件 / 1218 条用例 / 0 跳过、build）通过。`pnpm pack` 生成
`.artifacts/final/dsh-superagent-0.1.0.tgz`，343 579 字节；`tar -xzf` 后包含 `lib/index|client|github-watch|feishu-watch|gitlab-watch`（`.js` 与 `.d.ts`）、共享 chunk、`cordis.patch.yml`、`package.json`、`README.md`、`prompts/`、`skills/`、`locale/`。产物内的 `cordis.patch.yml` 里 `dsh-superagent-feishu` 与 `dsh-superagent-gitlab` 都是 `disabled: true`，与提交状态一致。

桌面应用用同一个构建启动：`Start-Process "…\DeepSeek Harness.exe"`，由一个后台 shell `Wait-Process` 持有，否则命令结束进程即被终止。管理接口需要 `x-orchestrator-request: 1`，且 `Host` 必须是 `127.0.0.1:<端口>` 或 `localhost:<端口>`。

| 端口 | 配置 | `/orchestrator/api/state` | `sources` |
| --- | --- | --- | --- |
| 50558 | 默认 | 200 | 只有 `github` |
| 56309 | 默认 | 200 | 只有 `github` |
| 53011 | profile patch 启用 GitLab | 200 | `github` + `gitlab` |
| 52618 | 默认（最终保留的实例） | 200 | 只有 `github` |
| 64468、51026、53112、53687 | 默认或启用 GitLab | 404 | 无 |

返回 200 时 `setup.problem.code` 为 `repositoryUnset`（GitHub 未填仓库），`github` 卡为 `enabled=true`、`paused`、`setupPending`；53011 上的 `gitlab` 卡同为 `enabled=true`、`paused`、`setupPending`，`setup.gitlabProblem` 为 `null`。

返回 404 时响应体为空（`curl -s -o -`），说明 `/orchestrator` 前缀整体未注册，即 bundle 的**服务端**插件没有挂载；同一个页面里客户端仍显示 Superagent 侧栏，因此挂载失败只在服务端。

同一配置、同一构建、先结束全部 `DeepSeek Harness` 进程再启动的条件下，3 次挂载成功、4 次未挂载。已排除：配置（启用或禁用 GitLab 都出现过两种结果）、等待时间（45–90 秒后仍 404）、端口、残留进程（`Get-Process` 计数为 0 后再启动）、`stateDir` 锁（`state\superagent` 下只有 sqlite 文件，无 lock，也无残留 node 进程），以及编辑 bundle patch 这一变量（改 profile patch 的方式同样出现过 404）。**未定位**。

作为对照，headless 宿主（`dsh --profile superagent`，端口 3082，同样 `link:D:/dsh-superagent`）在启用 GitLab 时稳定挂载：`sources` 返回 `github` 与 `gitlab` 两张卡，均为 `enabled=true`、`paused`、`setupPending`，`setup.problem.code` 为 `repositoryUnset`，`gitlabProblem` 为 `null`。

未验证项与条件：

- 真实 GitLab 租户：本机没有 `glab`，也没有可读项目的账号；离线契约由 `tests/gitlab.spec.ts` 覆盖。条件为 `glab` 1.30 以上，且账号对项目有 Developer 或更高权限。
- 真实飞书租户：条件见上一节的清单。
- 桌面端服务端插件挂载的稳定复现条件：4 次 404 与 2 次 200 用的是同一构建与配置，未能找到触发因素。

## 桌面版直连与热加载（2026-11-11）

上述挂载不稳定的原因已定位：profile 里的目录联接曾被 pnpm 拼成 `…\profiles\desktop\D:\dsh-superagent`（不存在），
用 `New-Item -ItemType Junction -Target 'D:\dsh-superagent'` 重建后稳定加载。桌面应用需用 WMI 启动才常驻。

- Excel 任务来源端到端已在桌面版内跑通：真实调度、git 同步、拆分、建单、DSH 会话执行（`orchestrator_report` 返回
  `ready` / `desktop-live-ok`）、队列结算与 CSV 回写（BOM + CRLF 保留）。证据与步骤见
  `verification/2026-11-11-desktop-live/README.md`。
- 热加载实测：只改构建产物不会生效；编辑 profile 的 `cordis.patch.yml` 触发 profile 重组后约 3 秒插件重载，
  pid 与端口不变，设置与队列条目保留。失败版本不回退旧代码（依据 `@deepseek-ai/dsh-hmr` 文档，未做失败注入）。
  因此改代码后的验证流程是「`pnpm build` → 触发一次 profile 重组」，不需要重启应用。

