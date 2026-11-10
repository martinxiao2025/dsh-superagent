# U6–U8 验证记录（2026-11-10）

本目录记录「工单子目录、按项目配额、执行页分组实机取证」三项的验证证据。截图与 JSON 均来自本机真实桌面版（junction 安装指向工作区），不是开发服务器。

## 环境

- 仓库：`D:\dsh-superagent`（分支 `main`）
- 工作区构建：`lib/index.js` SHA256 `DA41500219CECD5DE06A854FF37B2356287983416131B61CDAFEC924EC7FBCB3`
- 桌面版：`C:\Users\61054\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`
- 桌面 profile：`C:\Users\61054\.dsh\profiles\desktop`（`node_modules/dsh-superagent` 为指向 `D:\dsh-superagent` 的 Junction）
- 状态目录：`C:\Users\61054\.dsh\state\superagent`

## U6 工单子目录（已实现）

- 执行目录改为 `<executionRoot>/<项目名称>/<工单ID>`；项目层保留分组与归属，每张工单在项目目录下有自己的子目录。
- 同项目两张工单并发写入各自子目录，内容互不覆盖：`tests/runtime-concurrency.spec.ts` 的「ticket workspace directories」用例直接并发写 `artifact.txt` 并逐一断言内容。
- 来源记录的项目名相同但记录不同仍分成两个项目目录：`alpha`/`beta` 两条记录都指向 `app` 时得到 `app-alpha`、`app-beta`。
- 工单 ID 含非法字符时与项目名同口径清洗（含 Windows 保留名），清洗改变 ID 时追加 12 位哈希，空结果退回 `ticket-<哈希>`；结果只由 ID 决定，重试/重启落到同一目录。
- `executor.prepare` 仅在该工单子目录不存在时运行，工作目录为所属项目目录；同一工单重试复用已准备目录。
- 不迁移旧目录；旧工单没有 `project` 字段时，执行页分组退回执行目录最后一段。
- `docs/010-pipeline.md` 的「工单目录」小节已同步为新规则。

## U7 按项目配额（已实现）

- 新增 `executor.projectWorkers`（`0`–`16`，默认 `0`）。默认自动值：`max(1, ceil(maxWorkers / 2))`；默认 3 个全局槽位时单项目最多 2 个，至少留一个给其他项目。
- 配置正整数时按 `min(projectWorkers, maxWorkers)` 生效；未配置（旧设置）与显式填 `0` 行为一致，文档已写明。
- 人工跟进唤醒不受项目配额限制（与既有「人工跟进多一个全局槽位」一致）；调整设置立即生效，无需重启。
- 覆盖用例：`WorkerSlots` 自动上限/显式上限/全局封顶单元测试；运行时集成测试验证同项目第二张工单排队、调大上限后启动。
- `docs/010-pipeline.md` 新增「按项目配额」，`docs/006`/`docs/007` 同步。

## U8 执行页分组实机取证（已取得）

做法：停止桌面版 → 通过 [inject-demo-tickets.mjs](inject-demo-tickets.mjs) 向真实状态库写入 5 张演示工单（两个项目各 2 张 + 1 张未分配）→ 用 [dsh-u8-state.ps1](dsh-u8-state.ps1) 重启桌面版并记录端口/token → 打开真实面板截图 → 清理演示数据并重启桌面版。

接口证据：[runtime.json](runtime.json) 记录 `tickets?state=open` 返回 5 张，按项目分组为 `Demo.ProjectOnline: 2`、`ledger-app: 2`、未分配 `1`；[cleanup.json](cleanup.json) 记录清理后开放工单为 0。

截图证据：

| 文件 | 内容 |
| --- | --- |
| [execution-groups-full.jpg](execution-groups-full.jpg) | 全页截图：`Demo.ProjectOnline 2`、`ledger-app 2`、`尚未分配项目 1` 三个分组标题、计数与各自工单同屏可见 |
| [execution-groups.jpg](execution-groups.jpg) | 首屏截图：项目分组标题与计数、工单行排版 |

观测记录：

- 分组标题前有文件夹图标，标题右侧是项目计数徽标；同一项目的工单收在同一个 `section.dt-project` 下。
- 未分配工单归入「尚未分配项目」分组，计数为 1。
- 中文标题、相对时间（如「27 分钟前」）显示正常，无乱码。
- 截图来自桌面版进程 `DeepSeek Harness` 提供的真实面板地址 `http://127.0.0.1:52791/`（带 token），页面由桌面版加载的 `dsh-superagent` 构建渲染；本次未使用 `pnpm dev` 或本地静态页。

验证后演示工单已删除（`cleanup.json` 中 `deleted: 5`，开放工单 0），桌面版已重新启动。

## 门禁

`pnpm check`（`tsc --noEmit` + `vitest run` + `tsdown build`）通过：66 个测试文件、1297 项测试全部通过，构建成功。未删除测试、未放宽断言、未调整超时。

## 未验证项

- 真实 GitHub 触发的端到端流水线仍未验证：本机 `gh` CLI 不在 PATH 且未登录，无法产生真实工单；U8 的分组截图来自注入的真实状态数据，不依赖 GitHub。
- 桌面安装验证沿用 `verification/2026-11-10-u1-u5/` 的真实 tgz 结果；本轮 UI 取证使用 Junction 安装（与工作区同一份构建，哈希见上），未重复执行 tgz 换装。
