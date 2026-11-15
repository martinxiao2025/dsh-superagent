# 2026-11-15 · M0–M5 重构后的桌面版真机部署冒烟

- 目的：确认 docs/012 的 M0–M5 重构在真实 DeepSeek Harness（桌面版）上可部署、可启动，
  SCHEMA 15 全新状态库自动建立，管理接口与项目创建（含宿主 workspace 归类）可用。
- 范围说明：完整工单级冒烟（阶段切换/阶段模型/usage 落账/预算两档/retro 有数据）需要真实任务
  来源与凭据配置（SCHEMA 15 reset 后凭据材料需人工重新录入），本会话无法自动化；按 012 风险节
  预案降级为「部署级冒烟 + stub 级集成测试（52+ 用例）」，剩余人工步骤列在文末。
- 前置保护：旧状态目录（SCHEMA 14，7.08 GB / 649,893 文件，robocopy 0 失败）完整备份到
  `backup-state/`，可随时回滚。

## 步骤与证据

| # | 步骤 | 结果 | 证据 |
|---|------|------|------|
| 1 | 备份旧状态目录 | ✅ | robocopy 649,893 文件 / 7.084 GB / 0 失败 → `backup-state/` |
| 2 | 停止桌面版 Harness（taskkill 3 进程）并 WMI 重启 | ✅ | 新 PID 17164，startup.json phase=ready（14:29:33） |
| 3 | 全新状态目录 SCHEMA 15 建立 | ✅ | kv `schema=15`；`usage`/`project`/`ticket` 表存在 |
| 4 | 健康探针（免同源 GET /health，本批次 U6 修复） | ✅ | `ok:true, stage:ready`（curl 无同源头直达） |
| 5 | GET settings：`models` 块结构 | ✅ | blocks=policy,models,eval,executor；stages 六键全 null（零配置零行为） |
| 6 | POST projects 创建「冒烟项目」 | ✅ | `{id:"alpha",revision:1,restarting:true}` |
| 7 | **宿主 workspace 自动归类（M5 核心）** | ✅ | `project.hostWorkspaceId = 188e2963-9443-4151-9713-4466554c6b8b`（宿主 registry 真实分配并写回） |
| 8 | GET overview：`usage` 字段 | ✅ | 全零合计（全新库），字段结构与面板契约一致 |
| 9 | GET retro（按修订聚合） | ✅ | `{by:"revision",buckets:[]}`（空库空桶） |
| 10 | PUT settings/models 保存校验（无效 provider） | ✅ | 400 `modelUnavailable`（"no adapter registered for provider no-such"）——真实宿主 LLM 解析链路在保存路径生效 |

## 剩余人工步骤（工单级冒烟）

1. 面板 → 飞书凭据重新录入（材料在备份中，但状态库已重建）。
2. 面板 → 模型分组：为各阶段配置不同模型（或保持 null 验证回落）。
3. 投一张测试工单 → 核对：`orchestrator_stage` 阶段切换、会话 `model/selection` 随阶段变化、
   `usage` 表按阶段落账、宿主侧边栏出现「冒烟项目」workspace 与「<项目> · <工单>」分组。
4. （可选）设一个小预算投工单 → 验证 80% 提醒与 100% 自动结束。

## 回滚

停宿主进程 → 删 `C:\Users\61054\.dsh\state\superagent` → 从 `backup-state/` 复制回 → WMI 重启桌面版。
