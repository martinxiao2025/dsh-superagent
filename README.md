# dsh-superagent

> **仅供研究参考的原型，不是 DeepSeek 官方产品。** 这份代码源自我们团队的日常开发工作，其中有大量工程由编码智能体完成。请把它当作研究代码，而不是可投产的软件。它可能仍有缺陷，编码风格和工程实践也可能不一致。在你自己的环境中使用之前，请先审阅并调整。
>
> 我们为公开发布做了适配，因此它与我们的内部版本、以及《Exploring Super-agent Design: Towards a More Autonomous Agent System》中描述的实现并不完全相同。文中讨论的某些设计属于未来发展方向，并未在本原型中实现。

dsh-superagent 是面向单个 GitHub 仓库的主动式编码智能体，可同时接入一个 GitLab 项目，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的插件包形式提供。它监听 GitHub（可选 GitLab），并可选监听飞书。当获得许可的人在对话中向智能体提出工作时，它会开一个工单，在各自的智能体会话和目录中处理，并在原对话中答复，例如给出一个拉取请求。Web 面板展示需要人处理的事项。

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
- [008 操作手册](docs/008-cookbook.md)：新增一个来源
- [009 来源记录](docs/009-source-records.md)：来源记录模型、身份规则与管理接口

## 开发

`pnpm check` 运行类型检查、测试和构建。

## 许可证

[MIT](LICENSE)
