/** 主会话的评估工具：装载候选上下文、分页读取更多上下文与记录评估决策。 */
import { z } from 'zod'
import { type DecisionKind } from '../../../core/index.ts'
import { AssessmentSchema, EvalReadSchema } from '../../assessment.ts'
import { routed, type MainToolsHost } from '../host.ts'
import { tool, type Tool } from '../tool.ts'

/** 三个评估工具都绑定 `agent`（读取资源限定到该会话）；`orchestrator_eval_decide` 经 `routed` 收口。 */
export function evalTools(host: MainToolsHost, agent: Parameters<MainToolsHost['assessor']['read']>[0]): Tool[] {
  return [
    tool({
      name: 'orchestrator_eval',
      description: 'Load a proactive candidate\'s window and its thread\'s tickets; repeated calls reuse them.',
      schema: z.object({ trigger_id: z.string() }).strict(),
      execute: async (args, signal) => host.assessor.context(args.trigger_id, signal),
    }),
    tool({
      name: 'orchestrator_eval_read',
      description: 'Read more of a candidate\'s context, always with its trigger_id: a message or stub whole by message_id, an image by image_id, the root, the parent, a thread page by cursor, or a file or directory by path.',
      schema: EvalReadSchema,
      execute: async (read, signal) => host.assessor.read(agent, read, signal),
    }),
    tool({
      name: 'orchestrator_eval_decide',
      description: 'Record the decision of an assessment, as admission describes it, after orchestrator_eval with the same trigger_id.',
      schema: z.object({ trigger_id: z.string().min(1), ...AssessmentSchema.shape }).strict(),
      execute: async ({ trigger_id, ...result }, signal) => {
        const decided = await host.assessor.decide(trigger_id, AssessmentSchema.parse(result), signal)
        return routed(host, { decision: decided.state as DecisionKind, reason: decided.reason, ticketId: decided.ticket_id })
      },
    }),
  ]
}
