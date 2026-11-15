/**
 * 执行目录路径的纯函数叶子：工单目录树的形状（根、项目目录、工单子目录）。
 * executor/launch.ts 与 app 的视图共用；独立叶子避免 executor 反向依赖 app（评审 P1-9）。
 * 只放不依赖设置 schema 之外模块的纯函数；来源项目名推导依赖 Settings 类型。
 */
import { join } from 'node:path'
import { key } from './core/ids.ts'

export const executionRoot = (settings: { executor: { directory: string } }, stateDir: string): string =>
  settings.executor.directory || join(stateDir, 'work')

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
export function projectDirectory(settings: { sources: Readonly<Record<string, { kind: string; config: Record<string, unknown> }>> },
  sourceId: string | undefined, fallback: string): string {
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
