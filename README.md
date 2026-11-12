# dsh-superagent

> **仅供研究参考的原型，不是 DeepSeek 官方产品。** 这份代码源自我们团队的日常开发工作，其中有大量工程由编码智能体完成。请把它当作研究代码，而不是可投产的软件。它可能仍有缺陷，编码风格和工程实践也可能不一致。在你自己的环境中使用之前，请先审阅并调整。
>
> 我们为公开发布做了适配，因此它与我们的内部版本、以及《Exploring Super-agent Design: Towards a More Autonomous Agent System》中描述的实现并不完全相同。文中讨论的某些设计属于未来发展方向，并未在本原型中实现。

dsh-superagent 是面向 GitHub 仓库的主动式编码智能体，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的插件包形式提供。消息来源是记录（当前为飞书机器人，每条记录独立配置、轮询与健康状态）；工作来自**项目**——项目绑定一个 Git 仓库与一种任务来源（仓库内的 Excel/CSV/TSV 清单、飞书知识库或飞书群消息），智能体按调度领取任务、在各自的会话与 per-ticket worktree 中处理，并把终态回写任务清单。当获得许可的人在对话中向智能体提出工作时，它会开一个工单并在原对话中答复，例如给出一个拉取请求。Web 面板展示需要人处理的事项。

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
- [006 部署](docs/006-deployment.md)：手动安装、配置、升级与故障排查
- [007 架构](docs/007-architecture.md)
- [008 操作手册](docs/008-cookbook.md)：新增一个消息来源
- [009 项目交付域设计](docs/009-authoritative-project-design.md)：项目 / 仓库 / 任务来源 / 凭据 / 调度的权威设计（含实施状态）
- [010 任务清单格式规范](docs/010-task-format.md)：标准工作簿与知识库任务表（已实现）
- [011 架构与方案评审](docs/011-architecture-review.md)：评审结论与权威剩余任务清单

## 开发

`pnpm check` 运行类型检查、测试和构建；`pnpm dev` 一键启动 **Web UI 可视化调试**（推荐回路，详见 [006 部署 · 开发与调试](docs/006-deployment.md)）：

```sh
pnpm dev
```

脚本会构建、生成开发覆盖层并启动 `dsh web`，就绪后打印面板 URL；开发实例的状态目录隔离在检出内的 `.dsh-dev-state`，与桌面版生产实例互不影响。改代码后 `pnpm build` 并重启 `pnpm dev`。dsh CLI 不在 PATH 时用 `--dsh <路径>` 或 `DSH_CLI` 环境变量指定。在真实 profile 上验证时改用桌面版重挂载回路（`dsh plugin --profile <名称> add link:<检出路径>`）。

## 许可证

[MIT](LICENSE)
