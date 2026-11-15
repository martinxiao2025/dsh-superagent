/** 主会话的自我升级工具：读取按修订/模型/阶段分桶的回顾聚合，据其提出并落地 prompt 或模型配置的改进。 */
import { z } from 'zod'
import type { MainToolsHost } from '../host.ts'
import { tool, type Tool } from '../tool.ts'

export function retroTool(host: MainToolsHost): Tool {
  return tool({
    name: 'orchestrator_retrospective',
    description: 'Aggregate model usage across tickets for one of the bucket axes — the prompts revision, the model, or the work stage. Each bucket lists the tickets, requests, billed input, output and how the tickets ended (completed/merged/closed/dropped/stopped/open). Read it when asked to improve the orchestration or on your own initiative after a run of tickets; propose a change (which part text, which stage model, what budget) and apply it with orchestrator_prompts_save or orchestrator_settings_save — the loop is to measure, change one thing, then measure again.',
    schema: z.object({
      by: z.enum(['revision', 'model', 'stage']).describe('The bucket: prompt revision (each saved prompts version), model, or work stage.'),
    }).strict(),
    execute: async args => ({ by: args.by, buckets: host.store.read.retro(args.by) }),
  })
}
