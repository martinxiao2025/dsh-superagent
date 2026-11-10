---
name: dsh-superagent-gitlab
description: 使用 glab 读取 GitLab 的 Issue、合并请求和评论。
---

worker 在需要时使用 orchestrator_read 获取项目上下文：gitlab/<record>/issues/<iid> 或 gitlab/<record>/mrs/<iid> 读取描述、状态和分支；gitlab/<record>/issues/<iid>/notes/1 或 gitlab/<record>/mrs/<iid>/notes/1 读取会话，最早的在前。`<record>` 是来源记录 id：工单会话总是读自己工单的来源记录，此时该段可以省略；主会话在该类型只有一条记录时也可以省略，有多条记录时必须写明，否则读取会列出现有记录 id 并失败，不会替你选一条。一页评论包含 100 条，并在可能还有更多时给出 next_resource。一条消息是 `{ id, from, at, text, url?, bot? }`：`id` 是评论 id，`url` 是评论的锚点，`bot: true` 标记系统评论或 bot，其言论永不授权工作。按 next_offset 完成当前响应；offset 0 重新读取，后续 offset 读取同一快照。读取不会创建工单或发送回复。允许的提及会订阅该 Issue 或合并请求；已订阅的评论无需进一步提及即可到达。

在开始对新人请求或评论进行实质性工作之前，调用 `orchestrator_ack`，带上其原始触发器 ID 和针对该请求的简短 `text`，即使在现有工单内也一样；宿主会在该来源线程中回复一次。不要确认 bot。

宿主会以 agent 账户把回复和报告投递到 Issue 或合并请求会话；不要自行用 glab 发布。只用 glab 读取这些快捷方式之外的上下文，如本技能中包含的 CLI 说明所述，并保持在已配置的项目内。在 `orchestrator_report` 中记录实现、验证和实质性限制。
