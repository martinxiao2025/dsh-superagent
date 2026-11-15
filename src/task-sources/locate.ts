/**
 * 回写行定位的单源决策（评审 S6/C3）：任务状态回写前，在候选行中定位唯一目标行并做 CAS 校验。
 * 三个回写驱动（xlsx / CSV/TSV / 飞书多维表格）共用同一决策，仅由调用方提供行取值与错误构造。
 */

/** 一个候选行：`row` 是驱动自己的行形态，`id`/`title`/`status` 为 trim 后的单元格文本。 */
export interface LocatedRow<V> { row: V; id: string; title: string; status: string }

/**
 * 在候选行中定位回写目标：ID 列可用且命中时优先按 ID（标题可重复，同名标题不参与），
 * 否则按标题兜底；选定键命中多于一行时显式拒绝而不是写错行；找不到时报缺失。
 * 给出 `expectedStatus` 时执行 CAS：行当前状态不匹配即拒绝，由人工仲裁而不是无提示覆盖。
 */
export function locateRow<V>(rows: readonly LocatedRow<V>[], target: { taskId: string; taskTitle: string }, expectedStatus: string | undefined,
  fail: (reason: 'duplicate' | 'missing' | 'cas', info: { count: number; current: string }) => Error): V {
  const taskId = target.taskId.trim(), taskTitle = target.taskTitle.trim()
  const byId = taskId !== '' ? rows.filter(row => row.id === taskId) : []
  const chosen = byId.length ? byId : taskTitle !== '' ? rows.filter(row => row.title === taskTitle) : []
  if (chosen.length > 1) throw fail('duplicate', { count: chosen.length, current: '' })
  const match = chosen[0]
  if (!match) throw fail('missing', { count: 0, current: '' })
  if (expectedStatus !== undefined && match.status !== expectedStatus.trim()) throw fail('cas', { count: 1, current: match.status })
  return match.row
}
