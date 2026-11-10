# U9 / U10 取证记录（2026-11-10）

本目录记录两件事的实机证据：

- **U9**：把**真实 tgz 包**装进桌面版 profile，注入演示工单，重启桌面版并对执行页重新截图；取证后清理演示数据并还原环境。
- **U10**：核查 GitHub CLI（`gh`）究竟是「未安装 / 不在 PATH / 未登录」，并把可修复的一项修好。

所有结论都来自本机实跑输出，命令与输出一并记录如下。凡未实测的都标为「未验证」。

---

## 一、U9 用真实 tgz 重新取证 UI

### 1. 安装形态

用 `dsh-u9-install.ps1` 的 `install` 阶段完成：先停桌面版，删除工作区 Junction，再用 `pnpm add file:<tgz>` 离线安装，最后启动桌面版。

| 项目 | 值 |
| --- | --- |
| tgz 路径 | `D:\dsh-superagent\.artifacts\u6-u8\dsh-superagent-0.1.0.tgz` |
| tgz 大小 | 362637 字节 |
| tgz SHA256 | `4AB0361CB6530C8F385390F09C125D7A7B99AA51C7DD0D968D0CC9718077A73A` |
| 安装命令 | `pnpm --dir C:\Users\61054\.dsh\profiles\desktop add "file:D:/dsh-superagent/.artifacts/u6-u8/dsh-superagent-0.1.0.tgz" --offline --ignore-scripts` |
| 命令退出码 | 0 |
| 安装后的形态 | **普通目录**：`LinkType` 为空、`Target` 为空（不是 Junction、不是软链接） |
| 版本 | `0.1.0` |
| profile 依赖写回 | `file:D:/dsh-superagent/.artifacts/u6-u8/dsh-superagent-0.1.0.tgz` |
| `node_modules/dsh-superagent/lib/index.js` SHA256 | `DA41500219CECD5DE06A854FF37B2356287983416131B61CDAFEC924EC7FBCB3` |
| 与工作区 `lib/index.js` 是否一致 | **一致**（同一个哈希 `DA4150…BCB3`） |

即：这次界面不是从工作区目录链接进去的，而是由打包产物解出来的普通目录；且产物里的 `lib/index.js` 与工作区构建逐字节相同（同一份构建）。

完整机器可读记录见 `runtime.json`（含 `pnpm add` 的完整输出、原 Junction 的 `target` 与原始 `package.json`）。

### 2. 演示工单与截图

安装完成后通过 `../2026-11-10-u6-u8/inject-demo-tickets.mjs prepare` 往真实状态库注入 5 张工单，然后重启桌面版，直接读真实接口 `GET /orchestrator/api/tickets?state=open&limit=50`：

| 分组 | 张数 | 工单目录 |
| --- | --- | --- |
| `Demo.ProjectOnline` | 2 | `…\.dsh\state\superagent\work\Demo.ProjectOnline\demo-ui-01`、`demo-ui-02` |
| `ledger-app` | 2 | `…\work\ledger-app\demo-ui-03`、`demo-ui-04` |
| 未分配（无 `execution`） | 1 | `null`（没有目录） |

截图 `execution-panel.jpg` 取自**桌面版窗口自身**（已在窗口内打开 管理面板 › 执行），画面中依次可见：

- `Demo.ProjectOnline 2`（2 张：修复登录页在深色模式下的对比度、补充订单导出的单元测试）
- `ledger-app 2`（2 张：把结算服务的重试逻辑收敛到一处、升级依赖并修复类型报错）
- `尚未分配项目 1`（1 张：整理 0.2 版本的发布说明）

接口数据与界面显示一致：分组标题、计数、未分配分组都正确。

> 说明：面板首次截图走的是外部浏览器自动化，视口高度只有 600px，第三组被裁在折叠线以下；随后外部浏览器渲染器被节流，截图不可用，因此最终改用桌面版窗口截图（`PrintWindow`）取证，这张图完整包含三组。

### 3. 清理与还原

`dsh-u9-install.ps1 restore` 的实际结果见 `restore.json`：

| 步骤 | 结果 |
| --- | --- |
| 删除演示工单 | `deleted: 5` |
| 用备份 `package.json.before` 覆盖后 `pnpm install --offline --ignore-scripts` | 退出码 0 |
| 重建 Junction | `LinkType = Junction`，`Target = D:\dsh-superagent` |
| 还原后依赖写法 | `link:D:\dsh-superagent` |
| 还原后 `lib/index.js` 哈希 | `DA4150…BCB3`（与工作区一致） |
| 重启后健康接口 | `phase: ready`（端口 61704） |
| 清理后开放工单数 | **0**（`tickets-after-cleanup.json`） |

收尾时又用 `explorer.exe` 拉起桌面版，确认环境可用：`linkType=Junction`、`target=D:\dsh-superagent`、依赖 `link:D:\dsh-superagent`。

---

## 二、U10 GitHub CLI 可用性核查并打通

### 1. 三态结论

| 状态 | 事实 | 结论 |
| --- | --- | --- |
| 是否安装 | `C:\Users\61054\AppData\Local\Programs\GitHub CLI\gh.exe` 存在且可执行，`gh --version` 输出 `gh version 2.103.3 (2026-10-26)` | **已安装** |
| 是否在 PATH | 变更前 `Get-Command gh` 为空；变更后 `where.exe gh` 命中上面的路径 | **原本不在 PATH，已修复** |
| 是否登录 | `gh auth status` 退出码 1，输出 `You are not logged into any GitHub hosts. To log in, run: gh auth login` | **未登录** |

所以不是「gh 不可用」，而是「已安装、不在 PATH（现已加入）、尚未登录」。

### 2. PATH 变更前后

写入的是**用户级** PATH，注册表值类型保持 `ExpandString` 未被破坏。

- 变更后（当前值）：
  `c:\SoftWare\Trae CN\bin;…;D:\WorkSpace\dev-agent-workbench\src\DevAgent.Workbench\bin\Debug\net10.0;C:\Users\61054\AppData\Local\Programs\GitHub CLI`
  （共 673 字符，末尾新增 `C:\Users\61054\AppData\Local\Programs\GitHub CLI`）
- 变更前：同上但**没有**结尾这一段，共 624 字符。完整原值见 `gh-environment.json` 的 `path.userBefore`。
- 已广播 `WM_SETTINGCHANGE`（`SendMessageTimeout(HWND_BROADCAST, 0x1A, …, "Environment", …)`），让已运行的资源管理器/新进程刷新环境。

### 3. 新进程与桌面版是否都能解析到

**新进程**（用注册表的机器级 + 用户级 PATH 重建环境后执行）：

```
where.exe gh  → C:\Users\61054\AppData\Local\Programs\GitHub CLI\gh.exe
gh --version  → gh version 2.103.3 (2026-10-26)
```

**桌面版**：命令行能解析不等于桌面版进程能解析，因此用产品自身的检查做了两次对照（建一个临时 GitHub 来源 `u10-gh-check`，`cli` 填 `gh`，读 `GET /orchestrator/api/sources` 的 `problem`）：

| 时机 | `problem.code` | 说明 |
| --- | --- | --- |
| 改 PATH 前启动的旧进程 | `agentCliMissing`，`gh is not an executable file on PATH` | 旧进程继承的是改 PATH 之前的环境 |
| 改 PATH 后用注册表路径重启桌面版 | `agentCliSignedOut`，`gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.` | **已能找到并执行 gh**，只差登录 |

探针来源用完已删除（`DELETE /sources/u10-gh-check` → `{"removed":true,"restarting":true}`，随后 `GET sources` 返回 `[]`）。完整前后对照见 `gh-environment.json` 的 `desktopProbe`。

桌面版重启方式记录在 `dsh-u10-start.ps1`：用注册表重建 `$env:Path` 后启动 exe，启动结果在 `app-start.json`（`pathHasGithubCli: true`、`whereGh`、`ghVersion` 均正常）。

### 4. 登录需要你自己执行

未登录这一步**没有替你做**（不做交互式授权）。请在你自己的终端里执行下面任一条，然后按提示在浏览器里完成授权：

```powershell
# HTTPS 协议，最省事；浏览器授权（推荐）
gh auth login --hostname github.com --git-protocol https --web

# 想用 SSH 推代码（需已有 SSH 密钥）
gh auth login --hostname github.com --git-protocol ssh --web

# 手动粘贴 Personal Access Token（适合无浏览器环境）
gh auth login --hostname github.com --git-protocol https --with-token

# 企业版 GitHub Enterprise Server，把主机名换成你的
gh auth login --hostname github.example.com --git-protocol https --web
```

- 账号类型选 **GitHub.com**；协议选 **HTTPS**（除非你已配好 SSH 密钥）。
- 授权完成后用 `gh auth status` 自查，应显示 `Logged in to github.com account <你的账号>`。

**之后要不要重启桌面版？** 不需要重启桌面版，也不需要重启 dsh-superagent 进程：`gh auth login` 把凭据写进系统凭据存储/`~/.config/gh`，已在运行的进程下次调用 `gh` 即可读到。请在 管理面板 里点 **「重新检查」**（设置 › 来源的 GitHub 卡片，或概览里的问题条目），它会重启 dsh-superagent 并重新校验来源；此时原来的 `agentCliSignedOut` 应当消失。

---

## 三、未验证项

- `gh auth login` 的实际登录流程**未验证**（按约定不代做交互式授权）；登录后 GitHub 来源能否通过部署检查、能否推送到仓库，**均未验证**。
- 截图只有一张窗口图（`execution-panel.jpg`）。外部浏览器整页截图因渲染器节流未取到；三组数据另有接口 JSON（`runtime.json` 的 `tickets`）与页面快照作为交叉验证。

## 四、文件清单

| 文件 | 内容 |
| --- | --- |
| `dsh-u9-install.ps1` | U9 安装 / 还原两个阶段的可复跑脚本 |
| `runtime.json` | 安装形态、哈希比对、注入结果、启动地址、接口分组数据 |
| `tickets.json` / `tickets-after-cleanup.json` | 安装后 / 清理后的开放工单接口原文 |
| `execution-panel.jpg` | 桌面版执行页窗口截图（三组齐全） |
| `restore.json` | 清理与还原结果 |
| `package.json.before` | 还原用的原始 profile `package.json` |
| `dsh-u10-start.ps1` / `app-start.json` | 用注册表 PATH 重启桌面版的脚本与结果（`where gh`、`gh --version`） |
| `gh-environment.json` | gh 路径/版本/登录态、PATH 前后值、桌面版探针前后对照、探针清理 |
