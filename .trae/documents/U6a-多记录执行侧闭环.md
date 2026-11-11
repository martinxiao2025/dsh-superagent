# U6a：多记录执行侧闭环

## Context

来源模型已按「记录」落地：`Settings.sources = Record<记录ID, {kind, enabled, config}>`，记录 ID 即来源身份。U5 完成后，GitLab / 飞书 / GitHub 都支持同一类型多条记录。

但执行侧仍是单记录假设：

- `src/infra/environment.ts` 的 `writeEnvironment` 用 `firstSource(...)` 把 `gh` / `glab` / `lark-cli` 垫片固定到第一条记录；同一 host 的 git 凭据助手也只保留第一条记录。
- `src/app/execution-environment.ts` 的 `environmentOf` 把所有已启用记录的变量一起输出，`Object.fromEntries` 时同名键后者覆盖前者。

于是两条 GitHub 记录并存时，worker 实际只能用第一个账号。U6a 要把执行侧闭环到「工单只认其来源记录」，并删除「第一条记录」回退与全局同名覆盖。**本单元不涉及资源路由（U6b）。**

已确认的约束：

- worker agent 会话的 shell 环境来自宿主 `process.env`，DSH 会剥离 `DSH_*` 前缀与 `KEY|PASSWORD|SECRET|TOKEN` 形态变量（`node_modules/@deepseek-ai/dsh-subprocess/lib/index.js` L32-L56），**无法按会话注入环境变量**；`subprocess.spawn` 的显式 `env` 在剥离后叠加（prepare 命令已依赖这一点拿到 `DSH_SUPERAGENT_DIR`）。
- worker 会话 cwd = 工单目录；prepare 命令 cwd = 工单目录的父目录；主会话 cwd = `stateDir`。
- 因此 CLI 分发只能用文件上下文：**按工单目录登记记录，垫片从 cwd 逐级向上查找**；prepare 阶段用显式环境变量补充。

## 设计

### 1. 执行环境只注入工单来源记录

`src/app/execution-environment.ts`：

- `EXECUTOR_VARIABLES` 增加工单作用域变量 `DSH_SUPERAGENT_SOURCE`（说明：这个工单的来源记录 ID）。
- `environmentOf` 增加参数区分「文档视图」与「工单视图」：
  - 有 `ticket` 且有 `trigger`：只输出 `id === trigger.source` 的记录变量，并注入 `DSH_SUPERAGENT_SOURCE = trigger.source`。
  - 有 `ticket` 但无 `trigger`：不输出任何来源记录变量（不回退到全量叠加）。
  - 无 `ticket`（主会话预览、设置页/文档展示）：保持全量声明。
- 结果：同一工单不再出现同名变量互相覆盖；其他记录的变量（含账号、仓库、编号）不会进入该工单的执行环境与系统提示词。

### 2. 按记录选择 CLI：`worker-sources.json` + 常驻调度器

新增 `src/infra/worker-sources.ts`，职责：

- `<stateDir>/worker-sources.json`：`{ clis: { [记录ID]: { kind, cli } }, tickets: { [绝对目录]: 记录ID } }`。
- 单一写队列（按 `stateDir` 串起来）保证 `writeEnvironment` 与工单登记不会 read-modify-write 互相覆盖；临时文件 + `rename` 原子落盘。
- `recordTicketSource(stateDir, directory, recordId)`：登记工单目录 → 来源记录。
- `writeWorkerRecords(stateDir, records)`：重写 `clis`；保留 `tickets`，并清掉记录已不存在的悬空 ticket。
- 导出 `workerDispatch(stateDir)` 路径与调度器源码常量。

新增/生成 `<stateDir>/worker-dispatch.mjs`（由 `writeEnvironment` 用现有 `own()` 写入，带 MARKER，只用 Node 内置模块）：

- 命令 → 种类：`gh`→github，`glab`→gitlab，`lark-cli`→feishu，`git-credential`→github|gitlab。
- 记录选择顺序（**没有「第一条记录」回退**）：
  1. 环境变量 `DSH_SUPERAGENT_SOURCE`（prepare 命令的显式 env）且种类匹配；
  2. 从 `process.cwd()` 逐级向上匹配 `tickets`（目录键用 `resolve` + Windows 小写 + 去尾分隔符归一）；
  3. 该种类恰好一条记录 → 用它（无歧义，不是「第一条」）；
  4. 否则失败：0 条报 `<命令> is unavailable: this installation has no <Kind> Source.`；多条报 `<命令> cannot choose a Source record: this installation has N <Kind> Sources (id1, id2); run it inside a ticket directory so it uses the ticket's Source record.`
- 执行真实 CLI 前把 `worker-bin` 从 `PATH` 移除（与现有 `sameDirectory` 同口径：`resolve` + Windows 小写比较），避免包装脚本按名字调用 `gh` 时回到垫片。
- Windows：cli 为 `.cmd`/`.bat` 时经 `ComSpec` 启动（与 `spawnCommand` 同口径）。
- `git-credential` 模式：不读取、不消费 stdin，`stdio: 'inherit'` 直接把 git 的凭据协议交给真实 CLI，执行 `<cli> auth git-credential`。

### 3. 垫片与 git 凭据助手

`src/infra/environment.ts`：

- 删除 `writeEnvironment` 里对 `firstSource` 的使用；`gh`、`lark-cli` 始终生成垫片，`glab` 仅在有 GitLab 记录时生成。
- 垫片正文改为调度：POSIX `exec '<process.execPath>' '<worker-dispatch.mjs>' gh "$@"`；Windows batch `"<process.execPath>" "<dispatch>" gh %*`。原先的 PATH 清洗批处理/`sh` 逻辑移入调度器（垫片不再需要）。
- 被阻止命令的提示改为与记录无关：`<name> is blocked in this installation; use gh, which acts on the ticket's Source record.`；无 GitHub 记录时为 `no GitHub Source is configured`。
- `worker-gitconfig`：对每个有 GitHub/GitLab 记录的 host 写 `[credential "https://<host>"] helper = "<node> <dispatch> git-credential"`（同一 host 双账号也按工单目录路由）；`github.com` 的 `insteadOf` 规则改为「存在 github.com 记录」时写入。
- `credentialHelper(stateDir)` 改为返回调度器 helper 字符串（替代现在的 `credentialHelper(cli)`）；`verifyEnvironment` 对每个 git host 核对 `[file:workerGitConfig, credentialHelper(stateDir), '']`。

### 4. 登记工单来源

`src/executor/dsh.ts` 的 `launch`：

- 取 `sourceTrigger(host, ticket)` 后、`prepareDirectory` 之前调用 `recordTicketSource(this.host.machine.stateDir, workspace, source.source)`。
- prepare 的环境变量已包含 `DSH_SUPERAGENT_SOURCE`（来自第 1 步），调度器在 prepare 阶段据此选择记录。

## 测试改造与新增

真实执行型（不能只断言文本）：

- `tests/environment.spec.ts` 新增：两条 GitHub 记录，`cli` 分别为打印 `account-a` / `account-b` 的假 CLI；登记两个工单目录后，真实启动 `worker-bin/gh`（`cwd` 各自目录、`PATH` 含 `worker-bin`）断言输出各自账号；在工单子目录运行也命中同一账号；`DSH_SUPERAGENT_SOURCE` 显式覆盖；两条记录但无映射必须失败并列出两条记录 ID。
- 同一文件新增 git 凭据端到端：`GIT_CONFIG_GLOBAL=workerGitConfig`、`cwd` 为各自工单目录，`git credential fill` 从 stdin 喂 `protocol=https` / `host=github.com`，断言各自 username。
- 新增 `tests/execution-environment.spec.ts`：两条同名变量记录，工单视图只含来源记录的值；无 trigger 时不含来源记录变量；文档视图仍全量。

既有断言同步：

- `tests/runtime.spec.ts`：垫片文本断言改为「调用调度器」+ `worker-sources.json` 记录映射；`ticketEnvironment` / prepare env 断言改为只含来源记录变量；gitconfig helper 期望改为 `credentialHelper(stateDir)`。
- `tests/model-surface.spec.ts`、`tests/fixtures/host.ts`：git 凭据 mock 同步新 helper 字符串。
- `tests/windows-compat.spec.ts`：`.cmd` 垫片改为调度器调用，仍断言运行结果与 PATH 中不含 `worker-bin`；Windows 下 `.cmd` 假 CLI 经 `ComSpec` 启动。
- 不放宽断言、不抬超时、不删用例、不跳过。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
```

真实执行核对项：两条 GitHub 记录并存时，两个工单目录各自执行 `worker-bin/gh`，分别得到 `account-a` / `account-b`；`git credential fill` 在各自目录返回各自账号。

### 边界（必须如实写入汇报）

本机只有一份真实 `gh` 凭据，无法用两个真实 GitHub 账号做在线验证。替代验证是：真实启动调度器与垫片进程，用两个**各自独立、携带不同身份的 CLI**（假 CLI / 包装脚本）证明「记录选择 + 进程执行」链路正确；git 侧用真实 `git credential fill` 证明凭据助手按目录路由。汇报中明确说明这一点，不声称已完成双 GitHub 账号在线实测。

## 交付清单对照（完成后更新方案文档）

- 多记录执行侧：本单元完成并验证。
- 资源路由记录段：U6b，本回合不做。
