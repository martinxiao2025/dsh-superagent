/** 暴露给准备命令并记录在执行器会话说明中的执行环境变量；绝不包含凭据。 */
import { join } from 'node:path'
import { key } from '../core/ids.ts'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized } from '../fields.ts'
import type { VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** 由执行器注册的变量；`ticket` 条目仅在有工单时填充。 */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录（项目目录下按工单 id 命名的子目录）；执行器 Session 在其中工作', en: 'This ticket\'s directory, a subdirectory named after the ticket id inside its project; the executor Session works in it' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，用于分支与工单标识；执行目录按项目和工单 id 命名，见 DSH_SUPERAGENT_DIR', en: 'The ticket\'s short name, used for its branch; the directory is named after the project and the ticket id, see DSH_SUPERAGENT_DIR' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_SOURCE', ticket: true, description: { zh: '这个工单的来源记录 id；执行环境只按该记录注入变量', en: 'This ticket\'s Source record id; the execution environment only uses that record' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

export const executionRoot = (settings: Settings, stateDir: string): string => settings.executor.directory || join(stateDir, 'work')

/** Windows 保留设备名：目录名与之相同会导致无法创建或访问。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 把项目标识洗成可安全用作 Windows 目录名的一段文本：取最后一段，去掉非法字符与首尾的点、空格，
 * 保留设备名加 `project-` 前缀。返回值只由输入决定，便于对同名冲突做确定性判断。
 */
export function projectDirectoryName(raw: string): string {
  const last = raw.trim().split(/[\\/]+/).filter(Boolean).pop() ?? ''
  const cleaned = last.replace(/[<>:"|?*\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '')
  if (!cleaned) return ''
  return WINDOWS_RESERVED.test(cleaned) ? `project-${cleaned}` : cleaned
}

/** 来源记录声明的项目标识：GitHub 取仓库，GitLab 取项目路径，其他来源没有项目。 */
function projectIdOf(source: { kind: string; config: Record<string, unknown> } | undefined): string {
  const value = source?.kind === 'github' ? source.config.repository : source?.kind === 'gitlab' ? source.config.project : undefined
  return typeof value === 'string' ? value : ''
}

/**
 * 工单目录名：优先用来源记录的项目名；多条记录声明同一项目名时统一追加记录 ID，避免两个项目静默共用一个目录；
 * 没有项目标识的来源（飞书）退回记录 ID。结果只由设置决定，不随工单或时间变化。
 */
export function projectDirectory(settings: Settings, sourceId: string | undefined, fallback: string): string {
  const nameOf = (id: string): string => projectDirectoryName(projectIdOf(settings.sources[id])) || id
  if (!sourceId || !settings.sources[sourceId]) return projectDirectoryName(fallback) || 'ticket'
  const own = nameOf(sourceId)
  const shared = Object.keys(settings.sources).some(id => id !== sourceId && nameOf(id) === own)
  return shared ? `${own}-${sourceId}` : own
}

/**
 * 工单目录名：工单在每个项目目录下拥有自己的子目录，因此同一项目并发执行的工单不会互相覆盖。
 * 清洗规则与项目名同一口径（Windows 非法字符、首尾点与空格、保留设备名）；清洗改变了 id 时追加原 id 的
 * 短哈希，避免 `a/b` 与 `a\b` 这类不同工单落到同一个目录，空结果则退回 `ticket-<短哈希>`。
 */
export function ticketDirectoryName(raw: string): string {
  const suffix = key('ticket-directory', raw).slice(0, 12)
  if (!raw) return `ticket-${suffix}`
  const cleaned = projectDirectoryName(raw)
  if (cleaned === raw) return cleaned
  return cleaned ? `${cleaned}-${suffix}` : `ticket-${suffix}`
}

/** 按来源记录分组列出所有已声明的变量；对于当前已关闭的记录，`enabled` 为 false。 */
export function declaredVariables(sources: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  const on = new Set(sources.environments(settings).map(item => item.id))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ id, variables }) => ({ owner: id, enabled: on.has(id), variables }))]
}

/**
 * 执行环境变量。有工单时只注入该工单来源记录的变量，其他记录不会混入（也不会有同名覆盖）；
 * 没有工单的调用（主会话预览、设置页与文档）仍列出所有已启用的记录，作为声明视图。
 */
export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const executor: Record<string, string> = {
    DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '),
    ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id, DSH_SUPERAGENT_SOURCE: trigger?.source ?? '' } : {},
  }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { id, environment, config } of sources.environments(settings)) {
    // 工单只认自己的来源记录；准备命令同样经由这里取环境变量，因此两者口径一致。
    if (ticket && id !== trigger?.source) continue
    const values = environment.values({ source: deployment.sources[id], config, ...trigger?.source === id ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: id })
  }
  return result
}

/** 将工单固定的目录、名称和来源触发器与部署的当前设置组合起来。 */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
