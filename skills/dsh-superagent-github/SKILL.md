---
name: dsh-superagent-github
description: 使用 gh 操作 GitHub 代码仓库：读取上下文、创建分支与拉取请求、查看 CI 和审查。
---

GitHub 只是代码仓库，不产生工单，也不会把 Issue、PR、评论或 CI 事件投递给宿主或工单。

需要仓库上下文时直接使用 `gh`：`gh repo view`、`gh issue view <number>`、`gh pr view <number>`、`gh pr diff <number>`、`gh pr checks <number>`，或 `gh api ...`。宿主不提供 GitHub 资源读取，也没有由宿主投递的评论、审查或 CI 通知。

提交使用智能体账号（`gh api user` 可确认）；绝不要直接合并 PR、启用自动合并或关闭 Issue，除非交付要求明确要求。PR 只是交付物：它的关闭或合并不会产生终态通知，也不会结束工单。审查反馈和 CI 结果需要自己读取；需要人决定时用 `orchestrator_report` 报告，不要假设宿主会跟踪 PR 状态。
