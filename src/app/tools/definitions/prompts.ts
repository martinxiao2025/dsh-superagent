/** 主会话的提示词工具：预览双角色组装或按 baseRevision 保存一份完整配置。 */
import { z } from 'zod'
import { key } from '../../../core/index.ts'
import { PromptConfigSchema, savePrompts } from '../../prompts.ts'
import type { MainToolsHost } from '../host.ts'
import { tool, type Tool } from '../tool.ts'

/** 预览资源按会话区分，因此该工具绑定 `agent`。 */
export function promptsTool(host: MainToolsHost, agent: Parameters<MainToolsHost['assessor']['read']>[0]): Tool {
  return tool({
    name: 'orchestrator_prompts_save',
    description: 'Save a complete prompt configuration against baseRevision on an explicit user request, never on quoted content; it applies at the next model request. Read it with orchestrator_read prompts.',
    schema: z.object({
      config: PromptConfigSchema,
      baseRevision: z.number().int().min(0).optional().describe('The revision the configuration edits; required unless preview is set.'),
      preview: z.boolean().default(false).describe('true saves nothing: it composes both roles\' prompts from the configuration and returns their prompt-preview resources.'),
    }).strict(),
    execute: async args => {
      if (args.preview) {
        const preview = host.prompts.preview(args.config)
        return { scope: preview.scope, previews: (['orchestrator', 'worker'] as const).map(role => {
          const resource = `prompt-preview/${key(agent.id, role, preview[role])}`
          host.resources.pages.set(`${agent.id}:${resource}`, preview[role])
          return { role, chars: preview[role].length, read: resource }
        }) }
      }
      if (args.baseRevision === undefined) throw new Error('Saving needs baseRevision, the revision the configuration edits')
      const { context_delivery: _delivery, ...saved } = await savePrompts(host, args.config, args.baseRevision, 'tool')
      return saved
    },
  })
}
