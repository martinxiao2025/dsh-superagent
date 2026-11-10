# U1–U5 验证记录（2026-11-10）

本目录记录「Excel 工单来源幂等与多项目目录」五个单元的验证证据。所有结论以本目录的 JSON 与命令输出为准；本机不具备的条件直接标注“未验证”。

## 环境

- 仓库：`D:\dsh-superagent`（分支 `main`）
- 打包产物：`.artifacts/u1-u5/dsh-superagent-0.1.0.tgz`（361 232 字节，构建哈希 `E354BF4B…B3FE2FA`，与工作区 `lib/index.js` 一致）
- 桌面版：`C:\Users\61054\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`
- 桌面 profile：`C:\Users\61054\.dsh\profiles\desktop`（验证前为 `link:D:\dsh-superagent` 的 Junction）
- 验证脚本：[dsh-verify-install.ps1](dsh-verify-install.ps1)（`pwsh -NoProfile -File` 运行）

## 单元结论

| 单元 | 内容 | 验证方式 | 结论 |
| --- | --- | --- | --- |
| U1 | `id` 列必填、重复编号整批拒绝、缺列/空表/空标题显式报错、删除 `skipped` 死状态 | `tests/pipeline.spec.ts` 新增 5 条导入契约用例 + 2 条运行器用例 | 通过 |
| U2 | 工单目录改为 `<executionRoot>/<项目名称>`，Windows 非法名/保留名/同名冲突确定性处理 | `tests/execution-environment.spec.ts` 新增 4 条目录名用例；`tests/runtime*.spec.ts` 按新契约对齐 | 通过 |
| U3 | 多项目状态隔离排查（KV 键、健康项、锁、并发） | 代码审查 + `tests/pipeline.spec.ts` 的按记录键用例 | 见「U3 说明」 |
| U4 | 执行页按项目分组、项目数徽标 | `tests/panel-execution.spec.tsx` DOM 断言；桌面版截图 | 分组已由 DOM 用例验证；**桌面版实机截图未取得**（原因见下） |
| U5 | `docs/010-pipeline.md` 校准、全量门禁、打包、桌面安装 | `pnpm check`、本目录 `install-result.json` | 通过（流水的端到端联调未验证） |

## 桌面安装验证（真实 tgz）

证据：[install-result.json](install-result.json)、[health.json](health.json)、[create.json](create.json)、[delete.json](delete.json)、[delete-missing.json](delete-missing.json)

- `pnpm add file:...tgz` 退出码 0；安装后 `node_modules/dsh-superagent` 不再是链接（`linkType` 为空），版本 `0.1.0`；
- 安装产物 `lib/index.js` 的 SHA256 与工作区构建一致（`hashMatchesWorkspace: true`）；
- 桌面版启动后健康接口 `phase=ready`，端口由脚本自动发现；
- 真实新增来源 `u1u5-check`（`github`）→ 记录进入设置与运行时状态；真实删除返回 200，之后设置与运行时状态都不再包含它；再次删除返回 400（`sourceNotInstalled` 语义）；
- 结束前恢复原 `link:D:\dsh-superagent` 安装，恢复后为 Junction，`hash` 与工作区一致。

## 流水线端到端：未验证

脚本准备了两个本地仓库（`demo-project`、`ledger-app`）与两份 CSV（`tasks-demo.csv`、`tasks-ledger.csv`），并在打包后的桌面版里真实创建了两条 `github` 代码来源与两条 `pipeline` 记录。结果：

- 记录创建成功（`codeStatus/pipelineStatus` 均为 200，运行时重建后 `kinds` 为 `feishu/github/gitlab/pipeline`）；
- 但 `github` 来源健康为 `pollFailures`：`The GitHub Source has no working CLI`；
- `pipeline` 因此停在 `paused`：`代码来源记录不存在或不是 GitHub / GitLab`（`codeKinds()` 只认已成功解析的来源），本轮 **0 个工单**（见 [tickets.json](tickets.json) 与 [health-after-pipeline.json](health-after-pipeline.json)）。

原因：本机没有可用的 `gh` CLI（不在 PATH、未登录）。因此「Excel → 工单 → 按项目命名的目录」这条链路在桌面版没有跑通，标注为**未验证**，需要用具备 GitHub CLI 登录态的环境复跑同一脚本。

## U4 说明

执行页按项目分组由 `tests/panel-execution.spec.tsx` 新增用例断言（两个项目 + 一个未分配工单，标题与计数逐项比对）。桌面版截图未取得：分组需要有工单数据，而本机无法产出工单（同上，无 `gh` CLI），空列表下没有可展示的分组。样式改动本身不构成完成证据，故此处不宣称桌面端已验证。

## U3 说明

排查结论（代码事实）：

| 状态 | 作用域 | 依据 |
| --- | --- | --- |
| `pipeline-state:<记录>`、`pipeline-items:<记录>` | 按来源记录 | `src/kv.ts` |
| 健康项 `pipeline`、`pipeline:code`、`pipeline:tasks` | 按来源记录命名 | `src/sources/identity.ts` |
| 飞书已读 cursors | 按线程键（含记录 ID） | `src/kv.ts` |
| 状态目录锁 | 进程级（单实例） | `src/app/startup.ts` |
| `executor.maxWorkers` | 全局槽位 | `src/executor/dsh.ts` |

- 前四项不跨项目串味；状态目录锁是“一个进程一个状态目录”的有意约束。
- `maxWorkers` 仍是全局槽位，未做按项目配额：超出槽位的工单排队，但一个项目理论上可以占满全部槽位。这属于未实现的需求项，不宣称已完成。
- 曾尝试「同一项目目录串行执行」以避免多工单共享检出互相覆盖，但该改动会把同一项目的流水线并发压到 1，并与现有 `maxWorkers`/并发契约冲突（8 条用例失败），因此回退，保留现有并发语义；共享项目目录的并发写风险记录在此。

## 门禁

`pnpm check`（`tsc --noEmit && vitest run && tsdown build`）在提交前全绿；本记录中的测试数字以当次输出为准，本次未跳过、未放宽任何用例。`tests/runtime.spec.ts` 与 `tests/runtime-concurrency.spec.ts` 的调整属于**契约变化**：工单目录从按工单改为按项目后，准备命令只在项目工作区不存在时运行，用例在验证准备命令前显式删除项目目录以构造“新工作区”。
