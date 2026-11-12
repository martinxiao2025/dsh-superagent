# 006 部署

使用本指南安装、配置和运维 dsh-superagent。它涵盖账号、启动检查、升级和故障排查，建立在 [001 领域模型](001-domain.md) 到 [005 面板](005-panel.md) 之上。

## 运行的内容

- **一个专用的 DeepSeek Harness profile，** 本指南中称为 `superagent`。从 Web profile 模板创建它。它加载本插件包，并在 `127.0.0.1` 上提供面板。让它与你日常工作的 profile 分开：插件会修改进程级的 `PATH` 和 git 设置，其进程需要独立的重启和升级。
- **一个智能体 GitHub 账号。** 智能体以此账号发表评论、推送分支并打开拉取请求，通过仅以该账号登录的 GitHub CLI 进行。
- **可选：** 用于聊天请求的飞书机器人。
- **可选：** 一个 GitLab 账号和项目，通过以该账号登录的 GitLab CLI 读取和评论。

插件配置保存状态目录和机器限制。其他所有内容都使用面板：来源用于仓库和账号，策略用于允许名单，执行用于执行器目录和命令。

### 权限与隔离

插件包为执行器定义 `dsh-superagent-worker`，为主会话定义 `dsh-superagent-router`。它们会出现在 DeepSeek Harness 的预设列表中，但只供 dsh-superagent 使用。不要为个人会话选择它们，也不要禁用它们的配置行。本应用需要它们来创建和恢复会话。

在 Web UI 中打开空白的受管会话时，可能会选中该 profile 的默认预设。dsh-superagent 会在第一个回合之前恢复其角色专用预设。

两个预设都以 `danger-full-access` 以操作者的操作系统用户身份运行，并读取已订阅线程的消息。账号包装脚本默认选择智能体的凭据；它们不隔离进程。执行器可以按路径执行程序，并读取操作者的主目录。若要隔离，请使用仅包含智能体凭据的专用操作系统账号。

## 前置条件

- Node.js 22.19+ 或 24+、pnpm、git 2.32+、tmux
- 项目仓库的访问凭据：优先在面板保存 **Git 凭据**（SSH 私钥或 HTTPS 访问令牌，加密存储）；未选择凭据的项目沿用本机 `gh`（2.48+）/ `glab` 登录态或 SSH key，此时才需要安装对应 CLI。执行工作区是自动创建的 per-ticket `git worktree`，无需手工保留本地克隆；仓库使用 Git LFS 时请安装 `git-lfs`。
- 为 DeepSeek Harness 配置的模型提供方。除非评估或执行设置指定了其他模型，dsh-superagent 使用该 profile 的默认模型。
- 飞书：`lark-cli`（已在 1.0.90 测试）以及带机器人的飞书或 Lark 应用

## 账号

### 智能体 GitHub 账号（CLI 回退，可选）

未在面板保存 Git 凭据的项目沿用本机 CLI 登录态访问仓库。如果走这条路，建议为智能体单独准备账号与 CLI 包装：

1. 为智能体创建一个 GitHub 用户账号，并授予它对仓库的写权限。
2. 为它提供一个仅使用自身凭据的 GitHub CLI：

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   以智能体账号登录；最后一条命令会打印其登录名。dsh-superagent 也以同样方式读取登录名。

### 飞书机器人（可选）

1. 创建一个具有机器人能力的自建应用。授予它接收消息事件、读取和发送群消息、读取群成员的权限，然后发布应用版本。
2. 给机器人一份自己的 `lark-cli` 配置，限制为机器人身份，并创建包装脚本：

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   第一条命令从标准输入读取应用密钥。请使用单独的配置目录：`lark-cli` 每个应用 id 只允许一个 profile，而你的个人配置中可能已经包含该应用的用户登录。
   宿主会拒绝能以用户身份行动的 CLI。它从机器人配置中读取应用 id、飞书/Lark 品牌和机器人 `open_id`。
   两份配置共享应用密钥的钥匙串条目。若要仅移除机器人配置，请删除其目录；不要运行 `lark-cli config remove`，那会影响共享的密钥。
3. 在飞书或 Lark 开发者控制台中，为应用订阅 `im.message.receive_v1`，并通过长连接（WebSocket）投递事件，然后发布应用版本。dsh-superagent 运行 `lark-cli event consume im.message.receive_v1 --as bot`；没有订阅时消费者会退出，飞书卡片会显示 CLI 自己的消息。
4. 把机器人加入它应当接收的每个群。机器人无法读取它未加入的群，面板中的群列表也只显示已加入的群。
5. 在真实租户上验证机器人：
   - 飞书卡片会写明机器人名称，**选择机器人已加入的群** 会列出各群，这也证明读取权限有效。
   - 重启后，飞书条目显示 **正在监听机器人事件**，历史条目在一分钟内变为就绪。
   - 在已配置的群中 @ 机器人会创建工单，其确认会作为该消息话题中的回复出现。
   - 关闭来源会在五秒内暂停事件消费者；重新打开会再次监听。
   - 撤回回复所针对的消息后，该回复会被认定为已消失，而不是反复重试。

   自动化测试用假 CLI 离线覆盖 CLI 契约：`auth status`、`config strict-mode`、`bot/v3/info`、`event consume`（NDJSON、CRLF、格式错误行、退出与重启、停止进程树）、`im +messages-reply`（幂等键、已消失错误码）、`im +chat-list`，以及历史和线程读取。它们无法覆盖的是真实租户：应用权限、事件订阅、机器人所在群成员关系，以及飞书自己的错误码。这些正是上述检查的条件。

### GitLab 项目（可选）

1. 在机器上安装 [GitLab CLI](https://gitlab.com/gitlab-org/cli)（`glab`），版本 1.30 或更高。
2. 以智能体的 GitLab 账号登录 CLI，使用具有 `api` 范围的令牌：

   ```sh
   glab auth login --hostname gitlab.com
   glab api user
   ```

   最后一条命令会打印账号的 `id` 和 `username`；安装也以同样方式读取它们。CLI 环境中的 `GITLAB_TOKEN` 同样可用。

3. 授予该账号对项目的 **Developer** 权限（访问级别 30）或更高，可直接授予或通过其群组授予。Reporter 权限可以读取但不能评论，因此安装会拒绝它。
4. 未保存 Git 凭据的 GitLab 项目沿用本机 `glab` 登录态（或机器配置中的 `gitlabCli` 指向的包装脚本）；自建实例通过 `GITLAB_HOST` 访问。项目表单只填仓库全地址，保存时真实探测远端。
5. 在真实项目上验证：
   - 卡片会写明账号，历史条目显示就绪并带有 `N issues, M merge requests`。
   - 在新 Issue 或合并请求中 @ 智能体，会在轮询间隔内（默认 60 秒）创建工单。
   - 提到智能体的评论会被接收；开启 **接收项目中的评论** 时，其他评论也会被接收，但仍受策略准入表约束。
   - 回复会作为 Issue 或合并请求上的评论出现，重试前被删除的评论会被认定为已消失。
   - 关闭来源会暂停轮询；重新打开会恢复。

   自动化测试用假的 `glab` 离线覆盖 CLI 契约。它们无法覆盖的是真实 GitLab 实例：令牌范围、项目权限以及 GitLab 自己的错误码。

   GitLab 是来源记录的一种类型；未实现流水线/CI 和内联差异讨论。

## 安装

在还没有 `superagent` profile 的机器上运行一次以下代码块：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

上面固定的版本是公开的；其他版本必须满足 `package.json` 中的 `engines.dsh`。

第四条命令从 DeepSeek Harness Web 模板创建 `~/.dsh/profiles/superagent`。第五条安装本插件包。设置 `DSH_HOME` 可以迁移默认的 `~/.dsh` 目录。

只在全新安装时运行创建 profile 的命令。如果 profile 已存在，该命令会替换它并删除其 `cordis.patch.yml`，包括机器配置。升级时不要使用它。

### 从打包产物安装

`pnpm pack` 生成 `dsh-superagent-<version>.tgz`。把该文件装进 profile：

```sh
pnpm build
pnpm pack
dsh plugin --profile superagent add /path/to/dsh-superagent-0.2.0.tgz
```

安装会解包到 profile 的 `node_modules`，运行时不依赖检出目录。升级已有安装时重复最后一条命令并重启进程。

## 机器配置

把 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml`，替换该文件，并替换每个 `<placeholder>`。`webserver` 条目设置面板端口；`dsh-superagent` 条目提供 `stateDir`。

来源不是插件条目：消息来源（当前为飞书）随主插件加载，来源记录由面板的 **新增来源**、启用开关和删除操作管理。`cordis.patch.yml` 里没有、也不需要 `dsh-superagent-github`、`dsh-superagent-feishu` 或 `dsh-superagent-gitlab` 条目；不要改已安装包自带的 `cordis.patch.yml`，那里的改动要重新安装包才会生效。

| 键 | 必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁、`worker-bin` 中的命令垫片、智能体的 git 配置，以及默认情况下 `work` 中的工单目录。升级前请备份 |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | 否 | 保存的提示词配置的最大大小，以及一次评估在什么时间内读取多少个线程页 |

首次启动后，在 **设置 → 部署** 或 DeepSeek Harness 插件管理器中编辑机器限制。更改无需重启即可生效。`stateDir` 无法在那里更改。无效值或未知配置键会阻止启动；日志会指明该键。

## 开发与调试

官方文档（[第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)、[打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)、Cordis 教程[组合与热重载](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/06-composition-and-hmr)）没有内置「调试模式」开关；官方调试面是 **Web UI + `--patch` 开发覆盖层**。**开发迭代一律优先用推荐回路**；备选方法只在推荐回路不适用的特定场景使用。

### 推荐回路：Web UI 可视化调试（默认选择）

迭代只有两步：改代码 → `pnpm build`，然后（首次或重启时）一键启动开发实例：

```sh
pnpm dev
```

[scripts/dev-web.mjs](../scripts/dev-web.mjs) 会构建、从包层 `cordis.patch.yml` 生成自包含覆盖层（`.artifacts/dev.cordis.patch.yml`——预设逐字复制，升级包层后无需手工同步）、启动 `dsh web` 并等插件就绪后打印面板 URL。dsh CLI 的解析顺序是 `--dsh` 参数 > `DSH_CLI` 环境变量 > PATH（桌面版自带 CLI 位于 `<安装目录>\resources\runtime\cli\bin\dsh.cmd`）；`--no-build` 跳过构建，`--port` 换端口，Ctrl+C 结束实例。

等价的原始命令（脚本即它的封装）：

```sh
dsh web --patch examples/dev.cordis.patch.yml --no-open
```

- 面板（概览/项目/触发/评估/执行/设置）就是可视化调试面；改完代码 `pnpm build` 后重启即可生效。
- 开发实例的 `stateDir` 隔离在检出内的 `.dsh-dev-state`，不与桌面版实例争生产状态目录的锁，可长期与生产并行。
- 检出内的 [examples/dev.cordis.patch.yml](../examples/dev.cordis.patch.yml) 是同一覆盖层的静态参考（含 dsh-hmr 说明）；换机器时脚本无需改动，静态示例需改其中的绝对路径。
- 排查插件为什么没加载/没生效：`dsh --profile web --dump-config --patch .artifacts/dev.cordis.patch.yml` 看合成后的层。
- 实测陷阱（覆盖层设计已避开）：把插件以 `link:` 装进 web profile 会让运行时的需求校验崩溃（`undefined.startsWith`，peer 不随 link 解析）；tgz 安装在 Windows 上因跨盘符号链接权限失败（EPERM）；覆盖层只写主插件不写预设会在主会话组合时报 `Unknown agent preset`。

### 备选：桌面版重挂载回路

需要在**真实 profile**（真实凭据、真实仓库）上验证时使用：`pnpm build` 后重新执行安装命令，插件管理器会重挂载新产物（实测）：

```sh
dsh plugin --profile <名称> add link:<本检出的绝对路径>
```

也可用应用的插件管理器界面重载。注意宿主对 patch 文件的变更有约 30–90 秒延迟（0.2.2-rc.1 实测），且**条目消失会被插件管理器正式化为卸载**（自动改写 profile 的 `package.json`，见「卸载与清理」）——不要用删条目来试探重载。

### 备选：HMR 热重载插件（版本线匹配时）

官方 `@deepseek-ai/dsh-hmr` 监视 `root` 目录，插件文件变化即卸载旧实例（effect 回卷）并加载新版本；源码级热重载要求 tsx 运行时。**版本线必须与运行时匹配**：dsh-hmr 0.1.6-alpha.2 要求 0.1.6-alpha 线的 `dsh-app-boot`/`dsh-cmdline`，在 dsh 0.2.2-rc.1 上启动被拒绝，除非 `dsh plugin allow-version` 显式豁免（官方警告可能导致崩溃或数据丢失，日常使用的 profile 不建议豁免）。配置示例见 [examples/dev.cordis.patch.yml](../examples/dev.cordis.patch.yml) 中的注释块。

### 备选：`dsh-debug-mode`（第三方，未采用）

社区插件 [svcgv/dsh-debug-mode](https://github.com/svcgv/dsh-debug-mode) 提供 Normal/Plan/Debug 模式切换、浏览器埋点（带行号的 probe 事件）与后端 CDP/DAP 断点。分析结论：非官方、实验阶段（浏览器会话内埋点尚未闭环、Python 后端的停止/恢复流程未实现）、需要相邻的 harness 检出与含 API key 的 `config.ini`，插件目录还标注了兼容性存疑。运行时诊断需求由本插件自带的启动诊断（`startup.json`、`GET health` 的 `phase/detail`）与 `--dump-config` 覆盖，故不引入。

## 启动与停止

```sh
scripts/dsh-superagent.mjs start
scripts/dsh-superagent.mjs status
```

`start` 在 tmux 会话 `dsh-superagent`（或其他 profile 的 `dsh-<profile>`）中运行 `dsh --profile superagent`。它最多等待一分钟，让运行时变为就绪或报告安装要求。首次运行时，它会打印缺失的安装信息。它拒绝重复实例，包括在本脚本之外启动的实例。

`stop` 和 `restart` 请求优雅关闭，并最多等待执行器五分钟。它们从不强制终止进程，也不碰其他 tmux 会话。

`status` 打印进程 id、健康状况和安装问题。对其他 profile 或端口，使用 `--profile` 和 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL`。

`status`、`start` 和 `restart` 以以下四种退出码之一退出：

| 退出码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 它未运行、运行了两份、没有响应，或其运行时报告错误；重启可能修复 |
| 2 | 它在运行，但运行时之外的某个部分（例如来源或策略同步 `sync:<source id>`）报告错误；重启无法修复 |
| 3 | 它在运行并等待安装；重启无法修复 |

仍在启动的来源算作正常运行。安装无法检查的飞书机器人也是如此。

`status` 在 `errors` 下返回失败的部分及其详情，在 `setup` 下返回安装要求。`start` 和 `restart` 会把这些以行文本打印出来；如果服务始终未启动，它们以 1 退出。只有有意执行的 `stop` 会暂停自动恢复。

每个 profile 在 `.artifacts/` 下保存日志和控制文件：

- 启动日志：`dsh-superagent-<profile>-<date>-<time>-<pid>.log`，其中 pid 属于脚本。保留最新的 20 个。
- 控制文件：`control/profiles/<profile>/`，包含停止标记、锁和进程 id。

打开日志中打印的 URL，然后在侧边栏中选择 **Superagent**。

### 每小时检查

在你日常使用的 DeepSeek Harness profile 中创建每小时检查，而不是在 `superagent` 中。它必须在智能体服务停止时仍继续运行。在该 profile 中让一个智能体用下面的提示词创建每小时计划，并填入检出路径：

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` 会保留有意执行的停止。只有 `stop` 会写入标记；`start` 会清除它。`restart` 不写标记，因此检查可以恢复关闭超时的重启。

## 设置

在轮询或工作开始之前，安装必须成功。概览会列出缺失的要求，并链接到对应设置。设置更改会重新运行安装。如果你在应用之外修复了某些内容（例如 CLI 登录），请选择 **重新检查**。

1. **凭据。** 先在 **设置 → Git 凭据** 保存仓库访问材料（SSH 私钥或 HTTPS 访问令牌；材料加密存储，列表只显示掩码与指纹；可测试、轮换，被项目引用时不可删除）。需要飞书消息或知识库时，在 **设置 → 飞书凭据** 保存应用身份与消息接入配置。
2. **项目。** 在 **设置 → 项目 → 新建项目** 走四步向导：Git 凭据（类型与认证方式随凭据决定）→ 仓库全地址（验证连通并拉取分支）→ 任务来源（仓库内 Excel/CSV/TSV 清单、飞书知识库或飞书群消息，严格三选一；真实读取校验）→ 执行与调度（分支、轮询间隔、启动即跑）。仓库与任务来源内联在项目记录里，没有独立的选择项。
3. **策略。** 两条示例规则可以编辑或删除。在 **各来源** 下，添加可以发起工作的飞书用户；名单中有人之前，任何请求都不能成为工单。可以选择一个群在启动时和 **立即同步** 时同步名单。
4. **执行。** 目录根和准备命令。每个工单的执行目录是自动创建的 per-ticket `git worktree`（从项目仓库的轮询工作副本检出，跟随项目分支），准备命令在该工作区内运行。把个人 CLI（例如登录你自己账号的 CLI）列为被阻止的命令。
5. **提示词。** 设置团队段落：提交作者和自动合并条件。

### 管理 API

面板使用一个本地 HTTP API，智能体也可以调用。`SETUP.md` 用它保存设置，服务脚本读取 `GET state`。

向 `http://127.0.0.1:<port>/orchestrator/api/` 发送请求，并带 `x-orchestrator-request: 1`。主机必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。缺少请求头或 `Origin` 来自其他站点会收到 403。

API 保存具有面板的权限。与通过主会话工具进行的保存不同，它们可以更改执行环境和安装账号字段。

智能体可以依赖以下路由和字段。`src/app/api.ts` 中的其他路由服务于面板，并随面板变化。

| 请求 | 答复 |
| --- | --- |
| `GET state` | 每个页面读取的内容：`setup`，含 `problem` 和 `feishuProblem`，各自为 `null` 或带 `place`、`code`、`values` 和 `detail` 的安装问题；安装解析后的 `accounts`；`health`，每个部分一个条目（见下文），含 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail` 和 `at`；`load`，即执行器会话 `running`、工单 `queued` 和 `maxWorkers`；`paused`；以及 `masterId` |
| `GET settings` | `blocks`：`policy`、`eval` 和 `executor`，各自含 `value` 和 `revision`；`sources`（飞书消息来源记录）与 `projects`，各自含 `id`、`kind`、`installed`、其块的 `value`、`revision`、其类型的表单，以及有安装问题时的 `problem`；`policyVersion`；以及 `environment`，即执行环境的 `root` 和 `variables` |
| `GET sources` | 每个消息来源的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、其各部分 `health`、安装 `problem`、过去一天的 `stats`、该日它 `filtered` 的触发器，以及该日它 `dropped` 的消息（最新丢弃在前，每条含 `channel`、`preview`、属于工单时的 `ticket`（`id` 和 `title`）、存储中存在时的 `thread`，以及 `dropped.at` 和 `dropped.reason`、`channelGone` 或 `channelIgnored`） |
| `POST sources`，带 `{"kind": "feishu", "id": …, "config": {…}}` | 新增消息来源记录：`200` 与 `{ "id": …, "revision": …, "restarting": true }`；`id` 省略时按 `kind`、`kind-2`… 生成；校验失败 `400` 与 `issues` |
| `POST sources/verify`、`POST sources/<id>/labels` | 字段级预检（不写设置、不重启）与群名刷新 |
| `DELETE sources/<id>` | 删除来源记录：`200` 与 `{ "removed": true, "restarting": true }`；有未结束工单 `409` 与可读原因；记录不存在 `400`（`sourceNotInstalled`） |
| `POST code-repos/verify` | 候选仓库配置的字段级预检；可选带 `gitCredential` 用凭据真实探测远端 |
| `POST code-repos/branches` | 凭据 + 候选仓库配置 → 分支列表与默认分支（向导的分支选择） |
| `POST task-sources/verify` | 任务来源字段级预检（真实读取清单或知识库，返回条数） |
| `GET task-format/template` | 标准工作簿模板：`filename` 与 base64 `content` |
| `POST projects`、`DELETE projects/<id>` | 新建项目（与向导同一套校验，失败不落库）；删除项目先停止运行中工单（`by=human` 的 `stopped`）并清理该项目全部队列记录与写回副作用 |
| `GET queue` | 队列快照：条目（状态、尝试、`dueAt`、原因）、`used / maxWorkers`，以及 `projects[]` 的 `nextPollAt`、`lastError` 与 `deferred` |
| `POST queue/<id>/retry`、`POST queue/<id>/cancel`、`POST queue/clear?project=<id>` | 队列操作面：单条重试或取消、清空排队（运行中的任务不受影响） |
| `GET/POST/PUT/DELETE git-credentials`（另有 `POST git-credentials/verify`、`POST git-credentials/<id>/rotate`） | Git 凭据 CRUD；材料只进加密存储，响应只含掩码、指纹与可用性 |
| `GET/POST/PUT/DELETE feishu-credentials`（另有 `verify`、`rotate`） | 飞书凭据 CRUD，同上 |
| `POST feishu-im/chats` | 凭据 → 机器人已加入的群列表（群消息来源的群 ID 选择） |
| `GET health` | 启动阶段、监听地址、状态目录与逐记录健康摘要；运行时就绪前也返回 `200` |
| `PUT settings/<block>`，带 `{"value": …, "revision": n}` | 保存一个块：`saved`、该块的新 `revision`、`policy_changed` 和 `restarting`。`value` 是整个块，与 `GET settings` 中的形式一致；缺失的键取默认值 |
| `POST executor/pause`，带 `{"paused": true}` 或 `false` | 暂停或恢复处理：`paused` |
| `POST setup/check` | 通过重启 dsh-superagent 重新运行安装：`restarting: true`。没有可修复项时拒绝 |
| `POST policy-sync/<source id>` | 立即同步该来源的允许名单：`policy`，即保存的来源部分 |
| `GET prompts`、`PUT prompts`，带 `{"config", "baseRevision"}` | 读取提示词配置：`current`（含 `revision` 和 `config`）、`defaults`、`sections`（团队段落，按会话读取顺序）、`skillName`（团队技能名称的模式）、`builtin`（团队技能不能使用的名称）和 `skillPrefix`（会话加载技能名称时使用的前缀）。或保存它：新的 `revision` |
| `POST tickets/<id>/retry`、`POST tickets/<id>/stop` | 重试或停止工单，与面板操作相同 |
| `POST admin/reset`，带 `{"confirm": "RESET"}` | 破坏性重置：先备份 `stateDir` 再清空（见 009 §9.2）；请求体必须显式带确认词 |

健康条目按职责分组：

| 条目 | 报告内容 |
| --- | --- |
| `runtime` | 应用本身 |
| `models` | 等待模型预算重试的会话 |
| `evals` | 过去一小时内没有后续判断或忽略的未完成评估 |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply`, `writeback` | [003 执行](003-execution.md) 中描述的已存储工作；delivery 计数等待中的工作，reply 涵盖渠道消息，writeback 涵盖任务终态回写 |
| `worker` | 执行器会话事件处理；首次失败后出现 |
| `<记录 ID>`、`<记录 ID>:<名称>` | 来源轮询、事件和历史恢复，按记录区分（例如 `feishu-1`、`feishu-1:history`） |
| `sync:<source id>` | 允许名单同步 |

拒绝会带状态码和 `error`，其英文文本：

- 400：无效值（`issues`，各自含 `path`）、账号检查失败（`setup`）、固定拒绝（`code` 和 `values`），或请求体不是 JSON 或过大。
- 404：不存在的内容。
- 409：过时的修订号或被引用的资源（如凭据）。
- 500：其他任何情况。

各块：

- `source:<记录 ID>`：飞书消息来源记录 `{"enabled": true, "config": {…}}`，记录 ID 由创建时生成或指定。`config` 由飞书适配器 schema 定义：`instanceUrl`、`cli`、`chats`（形式为 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`，或 `"all"`）、`directMessages`，以及 `otherChats`（`"none"` 或 `"mentions"`）。
- `project:<记录 ID>`：项目记录，内联仓库（`codeRepo`：类型、仓库、分支、Git 凭据引用）与任务来源（`taskSource`：Excel/知识库/群消息三选一）、调度（`schedule`）、执行（`execution`）与状态策略（`taskPolicy`）。
- `policy`：`{"rules": […], "sources": {"feishu-1": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出其消息可以成为推断候选的机器人。`admission` 行以群 id、飞书的 `other` 或 `direct` 为键；未设置的单元格取默认值（见 [002 授权](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 和 `blockedCommands`。处理暂停是独立的设置 `paused`，由 `POST executor/pause` 设置。

更改仓库、任务来源或凭据会先运行对应的安装检查。检查失败返回 400，详情在 `setup` 中。成功的账号更改，或安装待定时进行的任何保存，返回 `restarting: true`。应用重启期间 API 暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
curl -s -X POST -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/git-credentials/verify \
  -d '{"name": "widgets", "kind": "https", "provider": "github", "token": "ghp_…"}'
```

## 安装检查

安装使用 DeepSeek Harness 的子进程服务，与执行器 shell 相同。它会移除名称包含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

安装逐条验证：飞书消息来源记录的机器人身份与 CLI；每个项目的仓库访问——有 Git 凭据时用凭据材料真实 `ls-remote` 探测（SSH 用临时密钥文件，HTTPS 用按命令注入的 extraHeader），未选择凭据时沿用本机 SSH key 或 `gh`/`glab` 登录；任务来源的真实读取（清单条数或知识库节点）。某条记录检查失败只给该记录标记 `problem` 并暂停它的轮询，不影响其他记录，也不改写已保存的启用状态。

安装写入的进程环境：

- **命令垫片** 位于 `<stateDir>/worker-bin`，在 `PATH` 最前面：`gh`、`glab` 和 `lark-cli` 按工单的来源记录选择该记录的 CLI 与账号；被阻止的命令会失败。垫片在运行目标之前会从 `PATH` 中移除自己的目录。
- **git 配置** 位于 `<stateDir>/worker-gitconfig`：替换操作者的全局和系统 git 配置。它为项目仓库的托管站点注册凭据助手（走 `gh`/`glab` 的 `auth git-credential` 协议，按工单记录分发），并定义 Git LFS 过滤器。有仓库使用 SSH 认证时对应主机不改写 SSH 地址，由本机或凭据的 SSH key 访问。HTTP 代理等个人 git 设置不生效。这里不设置提交身份（`useConfigOnly = true`），git 从不提示凭据，并会移除 `GH_TOKEN` 和 `GITHUB_TOKEN`。

`worker-bin` 或 `worker-gitconfig` 中不是由 dsh-superagent 写入的文件会阻止安装。位于 git 仓库内、且该仓库自身配置添加了凭据的工单目录会使工单失败。

## 试用

两条路径各自验证一半能力：

- **消息工单**：在已配置的飞书群里 @ 机器人（发件人需在允许名单上）。在一个轮询间隔内，概览应显示一个工单；智能体会确认请求，在自己的会话与目录中工作，并在原话题中交付。
- **项目任务**：按向导建一个项目（Git 凭据 → 仓库 → Excel 任务清单 → 执行与调度），把清单里一行 `status` 置为 `todo`。到下一个轮询点，项目详情的队列应出现该任务；智能体领取执行后，清单中的状态会被回写为完成或失败（回写保留原文件的 BOM 与换行风格）。

## 卸载与清理

`scripts/dsh-superagent.mjs clean` 从 DSH 配置文件移除插件并删除其全部状态与工件，先备份后删除：

```sh
scripts/dsh-superagent.mjs clean --yes [--profile NAME] [--dsh-home DIR] [--state-dir DIR] [--lock-wait 90] [--no-backup]
```

- **范围**：profile `cordis.patch.yml` 的 `dsh-superagent`（及 worker/router 预设）条目、`package.json` 的 `dsh.profile.bundles` 与 `dependencies` 引用、`node_modules/dsh-superagent`（link 安装只删目录连接本身，检出目录不受影响）、`pnpm-lock.yaml` 的 importer 条目（形状不匹配时保留并在报告中提示 `pnpm install` 修剪）、状态目录及其同级 `.lock` 锁目录、`.artifacts/` 下该 profile 的日志与控制文件。
- **备份**：默认写入 `~/dsh-superagent-backup/clean-<时间戳>/`（`state/` 全量 + 被修改文件原文）；`--no-backup` 跳过。重装时把 `profile/` 下的文件逐字复制回去，并重建 `node_modules/dsh-superagent` 目录连接（junction 不需要管理员权限）。
- **profile 定位**：未显式传 `--profile` 时自动扫描 DSH home（`DSH_HOME` 或 `~/.dsh`）下引用了插件的 profile；恰有一个则采用，多个则要求显式指定。
- **运行中的实例**：本脚本托管的服务先优雅停止；桌面版等外部实例持有状态锁时，先编辑 patch 并等待宿主重组卸载、锁释放。桌面版宿主监视 profile 配置，但**有约 30–90 秒延迟**（0.2.2-rc.1 实测），因此默认等待 240 秒（`--lock-wait` 调整）；超时会**还原 patch 并中止**，不动任何状态，并提示改走「关闭应用」或官方卸载命令 `dsh plugin --profile <名称> remove dsh-superagent`（它移除依赖与对应层，但不清状态目录——状态仍需本命令清理）。`startup.json` 的 pid 已死且锁超过 30 秒未刷新时按崩溃残留的过期锁直接清除。
- **不要手工删 patch 条目来卸载**：宿主对配置变化的反应是重启插件 fiber，插件在缺 `stateDir` 配置时启动失败，可能连带拖垮宿主的 runtime 进程（实测，恢复需重启应用）。且条目消失会被插件管理器**正式化为卸载**——自动把 `dsh-superagent` 从 profile `package.json` 的 `bundles` 与 `dependencies` 移除（操作日志见应用 crash 日志的 plugin operations 段与 `~/.dsh/plugins`），之后仅把条目写回 patch 不会重新装载。误删后的恢复是重新安装：`dsh plugin --profile <名称> add link:<本检出的绝对路径>`，再重启应用。卸载一律走 `clean`。
- **不自动处理**（报告会列出）：日常 profile 里的每小时检查提示词、`~/.local/bin/gh-agent`、`~/.config/gh-agent`、`~/.local/bin/lark-bot`、`~/.lark-cli-dsh-superagent`、`~/dsh-superagent-backup/` 下的历史备份与 pnpm store。
- **注意**：仍引用 `dsh-superagent-worker`/`dsh-superagent-router` 预设的 DSH 会话在插件移除后恢复会报 `agent-preset/not-found`；先结束这些会话再清理。

## 升级

1. 等到没有执行器正处在回合中间。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/dsh-superagent.mjs restart` 并检查其状态。

重启会结束运行中的派工，并带恢复备注启动替代派工。团队文本和被覆盖的提示词部分会保留；没有覆盖的部分跟随新默认值。升级后审阅标记为 **默认内容已更新** 的部分。

被较新版本迁移过的数据库无法被旧版本打开。因此回滚需要升级前的备份。升级 DeepSeek Harness 本身之后，重启运行中的实例，以便面板加载匹配的产物。

### 智能体预设

执行器和路由预设会在 5 秒后把 shell 命令转入后台。会话没有其预设就无法加载。在其会话使用期间，请保留 `cordis.patch.yml` 中的 `dsh-superagent-worker` 和 `dsh-superagent-router` 行；否则恢复会以 `agent-preset/not-found` 失败。

## 故障排查

安装问题会以面板语言显示在概览上，并链接到修复处；日志和 API 显示下面的英文文本。

| 现象 | 原因与修复 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 未选择 Git 凭据的项目需要本机 `gh` 登录；或在项目的仓库步选择一个已保存的 Git 凭据 |
| `The agent GitHub CLI was not found.` | 设置包装脚本的绝对路径，或 `PATH` 上的命令名 |
| `The agent GitHub CLI cannot read its account` | 用 `auth login` 登录该包装脚本 |
| `@… cannot read …` 或 `@… cannot push to …` | 授予智能体账号或凭据对仓库的访问权限 |
| `The GitHub Source names no repository.` | 项目表单的仓库全地址缺失或无法解析；填写 `https://…/owner/name.git` 形式的地址 |
| 工单以 `The prepare command failed: …` 失败 | 输出会指明原因，例如依赖安装失败；修复命令，然后重试工单 |
| `git does not read the github.com credential configuration dsh-superagent writes` | 安装 git 2.32 或更高版本 |
| 工单以 `The git configuration of the repository in … sets …` 失败 | 从克隆的 `.git/config` 中移除所指的凭据或 `http.*.extraheader` 设置 |
| `… was not written by dsh-superagent` | 把所指文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或选择另一个 `stateDir` |
| `The agent GitLab CLI is not set.` / `was not found.` | 未选择凭据的 GitLab 项目需要 `glab`（或机器配置的 `gitlabCli` 指向的包装脚本） |
| `The agent GitLab CLI cannot read its account.` | 以智能体身份运行 `glab auth login --hostname gitlab.com`，或设置 `GITLAB_TOKEN` |
| `@… cannot read … on GitLab.` | 把项目地址设为 `group/project` 对应的完整 URL，并授予账号对该项目的访问权限 |
| `@… needs Developer access to … on GitLab.` | 把账号提升到 Developer（30）或更高；Reporter 无法评论 |
| `The agent GitLab CLI did not return …` | 手动检查 `glab api projects/<group%2Fproject>`；代理或主机名不匹配可能隐藏项目 |
| `The bot lark-cli allows user identities` | 把飞书来源指向仅机器人配置，如上面的飞书机器人一节 |
| `The bot lark-cli does not work.` 或 `The bot identity of app … is …` | 检查配置中的应用 id 和密钥 |
| `The Feishu bot is not a member of the chat.` | 在群设置中把机器人加入该群；下次尝试会成功 |
| `Feishu event consumer exited (…, ready=false): …` | 应用未通过长连接订阅 `im.message.receive_v1`，或其机器人配置缺少消息权限；冒号后的文本是 lark-cli 自己的消息 |
| `Feishu event consumer did not become ready within 45 seconds` | lark-cli 无法打开长连接；以操作者身份手动运行 `lark-cli event consume im.message.receive_v1 --as bot` 查看其消息，并检查网络或代理 |
| 飞书读取或回复以 `99991…` 错误码或 `Access denied … scopes` 失败 | 在开发者控制台中授予消息所指的权限，然后发布应用版本 |
| `status` 以 2 退出 | 某个部分报告错误，重启无法修复：`errors` 会列出每个部分及其详情（见管理 API）；每个部分恢复正常后会清除自己的条目 |
| `status` 以 3 退出 | 安装等待中：`setup` 说明缺少什么，概览链接到修复它的设置 |
| `status` 以 1 退出 | 服务未运行、运行了两份、没有响应，或其运行时报告错误；输出和最新日志会说明是哪一种 |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …` 或 `… could not run: …` | CLI 失败但没有打印原因；以操作者用户身份手动运行所指程序查看其自己的消息 |
| 面板提示 dsh-superagent 没有响应 | 它正在重启，或因其配置未能启动；DeepSeek Harness 日志会指明原因 |
| 面板或 API 返回 `503` `startupPending` | 管理路由已挂载但运行时未就绪：响应与 `<stateDir>/startup.json` 写明阶段；`locked` 表示另一个实例仍持有锁，等它退出或 30 秒锁过期 |
| `/orchestrator/api/health` 返回空体 404 | 管理路由未挂载：重启 DeepSeek Harness，并查看 `<stateDir>/startup.json` 与 `startup.prev.json` 记录的最后阶段 |
| health 返回 `200` 但 `ok: false` | 插件已挂载但未就绪，`phase` 与 `detail` 说明原因；`failed` 时 `error` 带异常摘要 |
| `dsh-superagent configuration has keys it does not use`（日志） | 移除所指的键；消息会说明每个值现在位于何处 |
| 日志说插件与运行中的 dsh 不兼容 | 安装处于 `engines.dsh` 范围内的 DeepSeek Harness 版本 |
| 升级 DeepSeek Harness 后面板显示“Failed to load plugins” | 重启运行中的实例 |
| @ 之后没有任何反应 | 检查作者在来源的允许名单上、来源已开启、处理未暂停 |
| 主会话启动即失败，日志提到 `tools.restrict` 与 `bash` | 主会话的工具限制只能命名宿主实际提供的 shell；Windows 上的 DSH 只提供 `pwsh`，限制 `bash` 会在创建或恢复主会话时抛错（2026-11-10 实测定位，现仅限制实际存在的 shell） |
