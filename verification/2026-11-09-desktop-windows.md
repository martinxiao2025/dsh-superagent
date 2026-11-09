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
