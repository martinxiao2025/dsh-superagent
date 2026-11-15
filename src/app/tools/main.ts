/** 主会话工具注册表：按文件拆分的工具定义（`definitions/`）在此组装；新增工具先落 definitions 再登记于此。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readResource, type MainResourceHost } from '../resources.ts'
import type { MainToolsHost } from './host.ts'
import { evalTools } from './definitions/eval.ts'
import { promptsTool } from './definitions/prompts.ts'
import { replyTools } from './definitions/replies.ts'
import { retroTool } from './definitions/retro.ts'
import { routeTool } from './definitions/route.ts'
import { settingsTools } from './definitions/settings.ts'
import { ticketTools } from './definitions/ticket.ts'
import { readTool, type Tool } from './tool.ts'

export type { MainToolsHost } from './host.ts'
/** 构建主会话的工具；`agent` 将提示词预览资源限定到该会话。 */
export function mainTools(host: MainToolsHost, agent: Agent): Tool[] {
  const resources: MainResourceHost = { ...host.resources, sessions: host.sessions, settings: host.settings }
  return [
    readTool('Read one page of a resource the resource parameter lists, such as the ticket list or a ticket. Follow next_offset, and next_resource where a page names one.',
      false, (resource, offset, limit, signal) => readResource(resources, resource, offset, limit, undefined, signal)),
    routeTool(host),
    ...ticketTools(host),
    ...evalTools(host, agent),
    ...replyTools(host),
    ...settingsTools(host),
    retroTool(host),
    promptsTool(host, agent),
  ]
}
