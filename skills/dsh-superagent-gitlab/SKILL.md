---
name: dsh-superagent-gitlab
description: 使用 glab 操作 GitLab 代码仓库：读取上下文、创建分支与合并请求、查看 CI 和评论。
---

GitLab 只是代码仓库，不产生工单，也不会把 Issue、合并请求、评论或 CI 事件投递给宿主或工单。

需要项目上下文时直接使用 `glab`：`glab repo view`、`glab issue view <iid>`、`glab mr view <iid>`、`glab mr diff <iid>`、`glab ci status`，或 `glab api ...`。宿主不提供 GitLab 资源读取，也没有由宿主投递的评论或 CI 通知。

提交使用智能体账号（`glab auth status` 可确认）；绝不要直接合并合并请求或关闭 Issue，除非交付要求明确要求。合并请求只是交付物：它的关闭或合并不会产生终态通知，也不会结束工单。评论和 CI 结果需要自己读取；需要人决定时用 `orchestrator_report` 报告，不要假设宿主会跟踪合并请求状态。
