/** 主会话的回复与线程工具：向人发送回答/结果/需要人行动的通知，以及退订线程。 */
import { z } from 'zod'
import { IM_WORDS } from '../../../infra/text.ts'
import { routed, type MainToolsHost } from '../host.ts'
import { tool, type Tool } from '../tool.ts'

export function replyTools(host: MainToolsHost): Tool[] {
  return [
    tool({
      name: 'orchestrator_reply',
      description: 'Send an answer to a human question, a ready result, or attention requiring human action, as the replies section says; the gate refuses anything else, such as progress. purpose=result needs a ticket in person/review after a ready report, a completed or merged one, or a dropped one whose matched rule asks for a closing message.',
      schema: z.object({
        trigger_id: z.string().optional().describe('The original human question, for an answer only.'),
        ticket_id: z.string().optional(),
        purpose: z.enum(['answer', 'result', 'attention']),
        human_action: z.string().trim().min(1).optional().describe('Required for attention: the ticket\'s current attention question.'),
        text: z.string().min(1).max(20000).describe(`IM replies are hard-capped at ${IM_WORDS} words (Chinese uses word segmentation; Markdown link labels and targets count); the gate rejects longer text. Plain result text for GitHub-only delivery may use the full range.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: args.purpose, text: args.text, ...(args.trigger_id ? { triggerId: args.trigger_id } : {}),
          ...(args.ticket_id ? { ticketId: args.ticket_id } : {}), ...(args.human_action ? { question: args.human_action } : {}) })
        await host.sendReplies()
        return { status: host.store.replyStatus(reply.id) ?? reply.status }
      },
    }),
    tool({
      name: 'orchestrator_thread_unsubscribe',
      description: 'Drop every ticket subscription on a thread. Later messages there no longer reach those tickets as context; a new positive decision can subscribe it again.',
      schema: z.object({ thread: z.string().describe('Thread key, for example github:123 or feishu:<chat>:<root message>') }).strict(),
      execute: async args => {
        return { removed: host.quietly(() => host.engine.unsubscribe(args.thread)), thread: args.thread }
      },
    }),
  ]
}
