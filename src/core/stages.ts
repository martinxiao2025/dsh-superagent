/**
 * 工作单元的全流程阶段：一次工单执行内部的规范分段（调研→设计→实现→验证→评审→交付）。
 * 阶段是记录而非硬状态机：前进不强制（worker 可以回退或重复某阶段），准确性由阶段聚焦提示词保证。
 * 每个阶段可自由配置模型（`settings.models.stages`），会话的每个模型请求按当前阶段覆盖路由。
 */
import { z } from 'zod'

/** 六个规范阶段；顺序即交付的自然次序，但引擎不强制前进。 */
export const STAGES = ['investigate', 'design', 'implement', 'verify', 'review', 'deliver'] as const
export type Stage = (typeof STAGES)[number]
export const StageSchema = z.enum(STAGES)
/** 阶段的模型可见名称与一句话职责；注入阶段地图与阶段聚焦提示词。 */
export const STAGE_BRIEFS: Readonly<Record<Stage, string>> = {
  investigate: '调查：读代码与上下文，弄清现状与根因，产出结论与方案输入',
  design: '设计：把结论落成改动方案（文件、接口、边界），不写实现',
  implement: '实现：按方案编码与自测，小步提交',
  verify: '验证：跑测试与复现路径，确认方案解决了原始请求',
  review: '评审：自查 diff 与范围蔓延，确认授权边界与产品质量',
  deliver: '交付：总结结果、报告 ready（或提出需要人的问题）',
}
/** 一个阶段的时间线条目；`summary` 是 worker 声明阶段时给出的一句话进展。 */
export interface StageChange { stage: Stage; at: string; summary?: string }
