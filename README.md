# dsh-superagent

dsh-superagent 是一个主动式编码智能体，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 插件包的形式提供。消息来源是**记录**（当前为飞书机器人：每条记录独立配置、轮询并上报健康状态）；持续工作来自**项目**——每个项目绑定一个 Git 仓库与一种任务来源（仓库内的 Excel/CSV/TSV 清单、飞书知识库或飞书群消息，三选一）。调度器按清单领取任务，为每个工单开出独立的 DSH 会话与 per-ticket git worktree，执行器会话在真实检出里工作，工单终态回写任务清单。当获得许可的人在对话中向智能体提出工作时，它会开一个工单并在原对话中答复。Web 面板展示需要人处理的事项与系统健康。

它也是一种与智能体协作的方式：**尽可能少占用人的注意力，尽可能多地提供价值。** 能为整个团队行动的智能体，也可能浪费整个团队的注意力，因此它只在被请求时、或在团队写下的规则允许时行动，并且只在有人必须行动或能用到结果时才发言。[docs/000-philosophy.md](docs/000-philosophy.md) 解释了这一原则以及它对操作者的要求。

## 安装

安装步骤较多，因此由智能体与你一起完成。对你的编码智能体说：

> 阅读本仓库中的 SETUP.md，和我一起安装 dsh-superagent。

它会一次只问一个简短的问题，最后完整展示一遍计划，然后安装并配置所有内容。它遵循的就是 [SETUP.md](SETUP.md)。

## 文档

按顺序阅读编号文档；每篇只依赖它之前的文档。

- [000 理念](docs/000-philosophy.md)
- [001 领域模型](docs/001-domain.md)
- [002 授权](docs/002-authorization.md)
- [003 执行](docs/003-execution.md)
- [004 提示词](docs/004-prompts.md)
- [005 面板](docs/005-panel.md)
- [006 部署](docs/006-deployment.md)：手动安装、配置、管理 API、升级与故障排查
- [007 架构](docs/007-architecture.md)：开发者指南，模块表与测试表是代码索引
- [008 操作手册](docs/008-cookbook.md)：新增一个消息来源
- [009 项目交付域设计](docs/009-project-design.md)：项目 / 代码仓库 / 任务来源 / 凭据 / 调度的设计权威
- [010 任务清单格式规范](docs/010-task-format.md)：标准工作簿与知识库任务表

编码智能体另见 [AGENTS.md](AGENTS.md)：仓库的工作约定、常用命令与测试守卫的硬规则。已完成的工作记录在 [CHANGELOG.md](CHANGELOG.md)；待办任务只记录在 [tasks/backlog.csv](tasks/backlog.csv)。

## 开发

`pnpm check` 运行类型检查、测试和构建；`pnpm dev` 一键启动 **Web UI 可视化调试**（推荐回路，详见 [006 部署 · 开发与调试](docs/006-deployment.md)）：

```sh
pnpm dev
```

脚本会构建、生成开发覆盖层并启动 `dsh web`，就绪后打印面板 URL；开发实例的状态目录隔离在检出内的 `.dsh-dev-state`，与桌面版生产实例互不影响。改代码后 `pnpm build` 并重启 `pnpm dev`。dsh CLI 不在 PATH 时用 `--dsh <路径>` 或 `DSH_CLI` 环境变量指定。在真实 profile 上验证时改用桌面版重挂载回路（`pnpm build` 后用插件管理器对 `dsh-superagent` 条目禁用再启用，或 `dsh plugin --profile <名称> add link:<检出路径>`），并用 `node scripts/verify-live.mjs` 做只读实机核验——详见 [006 部署 · 开发与调试](docs/006-deployment.md)。

## 许可证

[MIT](LICENSE)
