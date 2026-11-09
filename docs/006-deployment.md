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
- GitHub CLI（`gh`）2.48 或更高版本。来源的 CLI 字段必须指向 `gh`、`lark-cli` 或 `glab` 包装脚本；宿主依赖它们的子命令和输出格式。
- github.com 上的一个仓库；不支持 GitHub Enterprise Server。要为每个工单创建检出，请保留一个本地克隆，让准备命令可以从中添加 worktree。如果该仓库使用 Git LFS，请安装 `git-lfs`。
- 为 DeepSeek Harness 配置的模型提供方。除非评估或执行设置指定了其他模型，dsh-superagent 使用该 profile 的默认模型。
- 飞书：`lark-cli`（已在 1.0.90 测试）以及带机器人的飞书或 Lark 应用
- GitLab：`glab`（在项目上具有 Developer 或更高权限）

## 账号

### 智能体 GitHub 账号

1. 为智能体创建一个 GitHub 用户账号，并授予它对仓库的写权限。GitHub App 不能作为智能体，因为 dsh-superagent 会读取该账号的通知。
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
4. 在 GitLab 来源卡片上，把 `project` 设为 `group/project`（支持 `group/subgroup/project` 等多级命名空间），把 `cli` 保持为 `glab` 或给出包装脚本的绝对路径，然后打开来源。保存会检查账号和项目，然后重启 dsh-superagent。
5. 在真实项目上验证：
   - 卡片会写明账号，历史条目显示就绪并带有 `N issues, M merge requests`。
   - 在新 Issue 或合并请求中 @ 智能体，会在轮询间隔内（默认 60 秒）创建工单。
   - 提到智能体的评论会被接收；开启 **接收项目中的评论** 时，其他评论也会被接收，但仍受策略准入表约束。
   - 回复会作为 Issue 或合并请求上的评论出现，重试前被删除的评论会被认定为已消失。
   - 关闭来源会暂停轮询；重新打开会恢复。

   自动化测试用假的 `glab` 离线覆盖 CLI 契约。它们无法覆盖的是真实 GitLab 实例：令牌范围、项目权限以及 GitLab 自己的错误码。

   GitLab 只是来源；部署仍然面向 GitHub 仓库。未实现流水线/CI 和内联差异讨论。

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

## 机器配置

把 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制到 `~/.dsh/profiles/superagent/cordis.patch.yml`，替换该文件，并替换每个 `<placeholder>`。如果使用飞书或 GitLab，还要在那里把对应的 `dsh-superagent-feishu`、`dsh-superagent-gitlab` 条目的 `disabled` 改为 `false`（桌面应用改 `~/.dsh/profiles/desktop/cordis.patch.yml`）。`webserver` 条目设置面板端口。

可选来源只在 profile 的 `cordis.patch.yml` 里启用；不要改已安装包自带的 `cordis.patch.yml`，那里的改动要重新安装包才会生效。

| 键 | 必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁、`worker-bin` 中的命令垫片、智能体的 git 配置，以及默认情况下 `work` 中的工单目录。升级前请备份 |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | 否 | 保存的提示词配置的最大大小，以及一次评估在什么时间内读取多少个线程页 |

首次启动后，在 **设置 → 部署** 或 DeepSeek Harness 插件管理器中编辑机器限制。更改无需重启即可生效。`stateDir` 无法在那里更改。无效值或未知配置键会阻止启动；日志会指明该键。

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

1. **来源。** 设置 GitHub 仓库（`owner/name`）和智能体 CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常通过智能体账号的通知到达。提到该账号的新 Issue 或评论会在下次轮询时到达；通过编辑已有 Issue 正文添加的 @ 不会。请改为发布新评论。对于飞书，设置机器人 CLI、群、每个群的接收全部或仅 @ 模式，以及是否接收私信。
2. **策略。** 两条示例规则可以编辑或删除。在 **各来源** 下，添加可以发起工作的 GitHub 账号和飞书用户；名单中有人之前，任何请求都不能成为工单。对于飞书，可以选择一个群在启动时和 **立即同步** 时同步名单。
3. **执行。** 目录根和准备命令。要给每个工单一个仓库检出：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   把个人 CLI（例如登录你自己账号的 CLI）列为被阻止的命令。
4. **提示词。** 设置团队段落：GitHub 披露行、评审机器人、提交作者和自动合并条件。

### 管理 API

面板使用一个本地 HTTP API，智能体也可以调用。`SETUP.md` 用它保存设置，服务脚本读取 `GET state`。

向 `http://127.0.0.1:<port>/orchestrator/api/` 发送请求，并带 `x-orchestrator-request: 1`。主机必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。缺少请求头或 `Origin` 来自其他站点会收到 403。

API 保存具有面板的权限。与通过主会话工具进行的保存不同，它们可以更改执行环境和安装账号字段。

智能体可以依赖以下路由和字段。`src/app/api.ts` 中的其他路由服务于面板，并随面板变化。

| 请求 | 答复 |
| --- | --- |
| `GET state` | 每个页面读取的内容：`setup`，含 `problem` 和 `feishuProblem`，各自为 `null` 或带 `place`、`code`、`values` 和 `detail` 的安装问题；安装解析后的 `accounts`；`health`，每个部分一个条目（见下文），含 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail` 和 `at`；`load`，即执行器会话 `running`、工单 `queued` 和 `maxWorkers`；`paused`；以及 `masterId` |
| `GET settings` | `blocks`：`policy`、`eval` 和 `executor`，各自含 `value` 和 `revision`；`sources`：来源实例，各自含 `id`、`kind`、`installed`、其块的 `value`（`{"enabled": …, "config": {…}}`）、`revision`、其类型的表单，以及有安装问题时的 `problem`；`policyVersion`；以及 `environment`，即执行环境的 `root` 和 `variables` |
| `GET sources` | 每个来源的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、其各部分 `health`、安装 `problem`、过去一天的 `stats`、该日它 `filtered` 的触发器，以及该日它 `dropped` 的消息（最新丢弃在前，每条含 `channel`、`preview`、属于工单时的 `ticket`（`id` 和 `title`）、存储中存在时的 `thread`，以及 `dropped.at` 和 `dropped.reason`、`channelGone` 或 `channelIgnored`） |
| `PUT settings/<block>`，带 `{"value": …, "revision": n}` | 保存一个块：`saved`、该块的新 `revision`、`policy_changed` 和 `restarting`。`value` 是整个块，与 `GET settings` 中的形式一致；缺失的键取默认值 |
| `POST executor/pause`，带 `{"paused": true}` 或 `false` | 暂停或恢复处理：`paused` |
| `POST setup/check` | 通过重启 dsh-superagent 重新运行安装：`restarting: true`。没有可修复项时拒绝 |
| `POST policy-sync/<source id>` | 立即同步该来源的允许名单：`policy`，即保存的来源部分 |
| `GET prompts`、`PUT prompts`，带 `{"config", "baseRevision"}` | 读取提示词配置：`current`（含 `revision` 和 `config`）、`defaults`、`sections`（团队段落，按会话读取顺序）、`skillName`（团队技能名称的模式）、`builtin`（团队技能不能使用的名称）和 `skillPrefix`（会话加载技能名称时使用的前缀）。或保存它：新的 `revision` |
| `POST tickets/<id>/retry`、`POST tickets/<id>/stop` | 重试或停止工单，与面板操作相同 |

健康条目按职责分组：

| 条目 | 报告内容 |
| --- | --- |
| `runtime` | 应用本身 |
| `models` | 等待模型预算重试的会话 |
| `evals` | 过去一小时内没有后续判断或忽略的未完成评估 |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | [003 执行](003-execution.md) 中描述的已存储工作；delivery 计数等待中的工作，reply 涵盖渠道消息 |
| `worker` | 执行器会话事件处理；首次失败后出现 |
| `github`, `feishu`, `history` | 来源轮询、事件和历史恢复 |
| `sync:<source id>` | 允许名单同步 |

拒绝会带状态码和 `error`，其英文文本：

- 400：无效值（`issues`，各自含 `path`）、账号检查失败（`setup`）、固定拒绝（`code` 和 `values`），或请求体不是 JSON 或过大。
- 404：不存在的内容。
- 409：过时的修订号。
- 500：其他任何情况。

各块：

- `source:github`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 的配置有 `repository` 和 `cli`，以及开关 `observeIssues`、`observePulls`、`observeComments` 和 `observeCi`，默认关闭，用于接收仓库中的每个新 Issue、新拉取请求和评论，以及默认分支的 CI；飞书的配置有 `cli`、`chats`（形式为 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`，或 `"all"`）、`directMessages`，以及 `otherChats`（`"none"` 或 `"mentions"`）。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出其消息可以成为推断候选的机器人。`admission` 行以群 id、飞书的 `other` 或 `direct`，以及 GitHub 的 `issues`、`pulls`、`comments` 或 `ci` 为键；未设置的单元格取默认值（见 [002 授权](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 和 `blockedCommands`。处理暂停是独立的设置 `paused`，由 `POST executor/pause` 设置。

更改仓库或 CLI 会先运行对应的安装检查。检查失败返回 400，详情在 `setup` 中。成功的账号更改，或安装待定时进行的任何保存，返回 `restarting: true`。应用重启期间 API 暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## 安装检查

安装使用 DeepSeek Harness 的子进程服务，与执行器 shell 相同。它会移除名称包含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

安装会验证 GitHub 仓库和智能体的推送权限，写入执行器环境，并检查 git 对 github.com 只使用智能体凭据。飞书安装失败只禁用飞书来源；GitLab 安装失败只禁用 GitLab 来源。

安装写入的进程环境：

- **命令垫片** 位于 `<stateDir>/worker-bin`，在 `PATH` 最前面：`gh` 运行智能体的 CLI；`lark-cli` 运行机器人的 CLI；被阻止的命令会失败。垫片在运行目标之前会从 `PATH` 中移除自己的目录。
- **git 配置** 位于 `<stateDir>/worker-gitconfig`：替换操作者的全局和系统 git 配置。它选择智能体 CLI 作为 github.com 的凭据助手，把 GitHub SSH 地址改写为 HTTPS，并定义 Git LFS 过滤器。HTTP 代理等个人 git 设置不生效。这里不设置提交身份，git 从不提示凭据，并会移除 `GH_TOKEN` 和 `GITHUB_TOKEN`。

`worker-bin` 或 `worker-gitconfig` 中不是由 dsh-superagent 写入的文件会阻止安装。位于 git 仓库内、且该仓库自身配置添加了凭据的工单目录会使工单失败。

## 试用

从允许名单上的 GitHub 账号，打开一个 Issue 或发布包含 `@<agent login> <request>` 的评论。在一个轮询间隔内（默认一分钟），概览应显示一个工单。智能体会确认请求，在自己的会话和目录中工作，并在原对话中交付。对于飞书，在已配置的群中 @ 机器人。对于 GitLab，在已配置项目的 Issue 或合并请求中 @ 智能体用户名。

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
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片上设置智能体的 CLI |
| `The agent GitHub CLI was not found.` | 设置包装脚本的绝对路径，或 `PATH` 上的命令名 |
| `The agent GitHub CLI cannot read its account` | 用 `auth login` 登录该包装脚本 |
| `@… cannot read …` 或 `@… cannot push to …` | 授予智能体账号对仓库的写权限 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片上设置仓库 `owner/name` |
| 工单以 `The prepare command failed: …` 失败 | 输出会指明原因，例如错误的克隆路径；修复命令，然后重试工单 |
| `git does not read the github.com credential configuration dsh-superagent writes` | 安装 git 2.32 或更高版本 |
| 工单以 `The git configuration of the repository in … sets …` 失败 | 从克隆的 `.git/config` 中移除所指的凭据或 `http.*.extraheader` 设置 |
| `… was not written by dsh-superagent` | 把所指文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或选择另一个 `stateDir` |
| `The agent GitLab CLI is not set.` / `was not found.` | 在 GitLab 卡片上设置 `glab` 或其绝对路径 |
| `The agent GitLab CLI cannot read its account.` | 以智能体身份运行 `glab auth login --hostname gitlab.com`，或设置 `GITLAB_TOKEN` |
| `@… cannot read … on GitLab.` | 把 `project` 设为 `group/project`，并授予账号对该项目的访问权限 |
| `@… needs Developer access to … on GitLab.` | 把账号提升到 Developer（30）或更高；Reporter 无法评论 |
| `The agent GitLab CLI did not return …` | 手动检查 `glab api projects/<group%2Fproject>`；代理或主机名不匹配可能隐藏项目 |
| 收不到 GitLab 评论 | 检查来源已开启、作者在允许名单上，并且评论 @ 了智能体（除非开启了 **接收项目中的评论**）。系统评论和智能体自己的评论会被忽略 |
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
| `dsh-superagent configuration has keys it does not use`（日志） | 移除所指的键；消息会说明每个值现在位于何处 |
| 日志说插件与运行中的 dsh 不兼容 | 安装处于 `engines.dsh` 范围内的 DeepSeek Harness 版本 |
| 升级 DeepSeek Harness 后面板显示“Failed to load plugins” | 重启运行中的实例 |
| @ 之后没有任何反应 | 检查作者在来源的允许名单上、来源已开启、处理未暂停。在 GitHub 上，通过编辑 Issue 正文添加的 @ 不会被接收；请在评论中 @ 智能体 |
