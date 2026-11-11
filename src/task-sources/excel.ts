/**
 * Excel 任务来源驱动：清单位于代码仓库的本地工作副本中，读取前先同步仓库。
 * 支持 `.csv` / `.tsv` / `.xlsx`，回写沿用原子替换。
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { SourceCheck } from '../setup.ts'
import { commitWorkCopy } from '../code-repos/work.ts'
import { readStandardTable, readTaskTable } from './table.ts'
import { STANDARD_TASK_FIELDS, TASK_SHEET, TaskFormatError, parseStandardTasks, standardStatus } from './excel-format.ts'
import { importTasks, TaskListError, type RawTask } from './tasks.ts'
import { writeTaskStatusAt } from './writeback.ts'
import {
  checkFailed, checkPassed, errorText, repoCheck, taskColumnShape, taskColumnsOf, TaskRepoError,
  type TaskSourceDriver, type TaskSourceRunContext, type TaskSourceVerifyDeps, type TaskSourceWriteContext,
} from './kind.ts'

/** Excel 任务来源配置：`repo` 为代码仓库记录 ID，`file` 为仓库内相对路径；未选仓库时兼容旧的绝对路径。 */
export const ExcelTaskSourceSchema = z.object({
  repo: z.string().trim().max(64).default(''),
  file: z.string().trim().min(1).max(1000),
  sheet: z.string().trim().max(100).default(''),
  /** 关闭时按 016 标准表头与枚举校验；开启后使用下面的自定义列映射。 */
  customColumns: z.boolean().default(false),
  ...taskColumnShape,
}).strict()
export type ExcelTaskSourceConfig = z.infer<typeof ExcelTaskSourceSchema>

const fields: TaskSourceDriver['fields'] = [
  { key: 'repo', type: 'text', label: { zh: '代码仓库', en: 'Code repository' },
    hint: { zh: '代码仓库记录 ID；清单文件相对该仓库的工作副本读取。', en: 'Code repository record ID; the file is read from its working copy.' } },
  { key: 'file', type: 'text', label: { zh: '任务清单文件', en: 'Task list file' },
    hint: { zh: '相对仓库根目录的路径，例如 tasks/backlog.csv。', en: 'Path relative to the repository root, e.g. tasks/backlog.csv.' } },
  { key: 'sheet', type: 'text', label: { zh: '工作表', en: 'Sheet' }, advanced: true,
    hint: { zh: '仅 .xlsx 使用；留空优先读取 tasks 表。', en: 'Only for .xlsx; leave empty to prefer the tasks sheet.' } },
  { key: 'customColumns', type: 'switch', label: { zh: '自定义列映射', en: 'Custom column mapping' }, advanced: true,
    hint: { zh: '关闭时按标准表头（task_id / title / status）与枚举校验；仅在旧表无法改表头时开启。',
      en: 'Off uses the standard headers (task_id / title / status) and enums; turn on only for legacy tables you cannot rename.' } },
  { key: 'idColumn', type: 'text', label: { zh: '编号列', en: 'ID column' }, advanced: true },
  { key: 'titleColumn', type: 'text', label: { zh: '标题列', en: 'Title column' }, advanced: true },
  { key: 'descriptionColumn', type: 'text', label: { zh: '描述列', en: 'Description column' }, advanced: true },
  { key: 'statusColumn', type: 'text', label: { zh: '状态列', en: 'Status column' }, advanced: true },
  { key: 'priorityColumn', type: 'text', label: { zh: '优先级列', en: 'Priority column' }, advanced: true },
]

/** 解析清单的本地绝对路径；配置了仓库时先同步工作副本。 */
export async function taskFilePath(
  config: ExcelTaskSourceConfig,
  syncRepo?: (repo: string) => Promise<string>,
  directory?: string,
): Promise<string> {
  if (config.repo) {
    if (isAbsolute(config.file)) throw new TaskRepoError('repoNotReady', `任务清单路径必须是代码仓库内的相对路径：${config.file}`)
    if (!directory && !syncRepo) throw new TaskRepoError('repoNotReady', `代码仓库 ${config.repo} 尚未接入同步能力`)
    return join(directory ?? await syncRepo!(config.repo), config.file)
  }
  if (!isAbsolute(config.file)) {
    throw new TaskRepoError('repoUnset', `任务清单路径不是绝对路径，且未选择代码仓库：${config.file}`)
  }
  return config.file
}

/** 读取结果：任务、标准格式版本与读取警告。 */
interface Loaded { tasks: RawTask[]; version: number; warnings: string[] }

/** 读取并校验清单；标准格式缺列、非法枚举、重复编号等问题整批抛出。 */
async function loadTasks(config: ExcelTaskSourceConfig, syncRepo?: (repo: string) => Promise<string>): Promise<Loaded> {
  const file = await taskFilePath(config, syncRepo)
  if (config.customColumns) {
    return { tasks: importTasks(await readTaskTable(file, config.sheet), taskColumnsOf(config)), version: 0, warnings: [] }
  }
  const standard = await readStandardTable(file, config.sheet)
  const parsed = parseStandardTasks(standard.table)
  const warnings = [...standard.warnings,
    ...parsed.unknown.length ? [`未知列已忽略：${parsed.unknown.join('、')}`] : [],
    ...parsed.empty ? ['任务表只有表头，当前没有待处理任务'] : []]
  return { tasks: parsed.tasks, version: standard.version, warnings }
}

/** 逐字段预检：仓库可达、文件可读、列映射非空。 */
async function verify(config: ExcelTaskSourceConfig, field: string, deps: TaskSourceVerifyDeps): Promise<SourceCheck[]> {
  if (field === 'repo') {
    if (!config.repo) return [checkFailed('repo', 'taskRepoUnset')]
    try {
      const directory = await deps.syncRepo(config.repo)
      return [checkPassed('repo', 'taskRepoOk', { directory })]
    } catch (error) { return [repoCheck('repo', error)] }
  }
  if (field === 'file') {
    if (config.repo && isAbsolute(config.file)) return [checkFailed('file', 'taskFileAbsolute', { file: config.file })]
    if (!config.repo && !isAbsolute(config.file)) return [checkFailed('file', 'taskFileRelative', { file: config.file })]
    let file: string
    try { file = await taskFilePath(config, deps.syncRepo) } catch (error) { return [repoCheck('file', error)] }
    if (!existsSync(file)) return [checkFailed('file', 'taskFileMissing', { file })]
    try {
      const loaded = await loadTasks(config, deps.syncRepo)
      if (config.customColumns) return [checkPassed('file', 'taskFileCustomOk', { rows: String(loaded.tasks.length) })]
      const warnings = loaded.warnings.length ? `；${loaded.warnings.join('；')}` : ''
      return [checkPassed('file', 'taskFileStandardOk', { rows: String(loaded.tasks.length), version: String(loaded.version), warnings })]
    } catch (error) {
      if (error instanceof TaskFormatError) return [checkFailed('file', error.code, { output: error.message })]
      if (error instanceof TaskListError) return [checkFailed('file', 'taskFileUnreadable', { output: error.message })]
      return [checkFailed('file', 'taskFileUnreadable', { output: errorText(error) })]
    }
  }
  if (field === 'sheet') return [checkPassed('sheet', 'taskSheetOk', { sheet: config.sheet || `(${TASK_SHEET})` })]
  if (field === 'customColumns') return [checkPassed('customColumns', config.customColumns ? 'taskCustomOn' : 'taskCustomOff')]
  // 标准格式下这些列固定，不再要求用户填写。
  if (!config.customColumns) {
    const column = STANDARD_TASK_FIELDS[{ idColumn: 'id', titleColumn: 'title', descriptionColumn: 'description',
      statusColumn: 'status', priorityColumn: 'priority' }[field] as keyof typeof STANDARD_TASK_FIELDS]
    return column ? [checkPassed(field, 'taskColumnStandard', { column })] : [checkFailed(field, 'checkUnsupported', { field })]
  }
  const column = ({ idColumn: config.idColumn, titleColumn: config.titleColumn, descriptionColumn: config.descriptionColumn,
    statusColumn: config.statusColumn, priorityColumn: config.priorityColumn } as Record<string, string>)[field]
  if (column === undefined) return [checkFailed(field, 'checkUnsupported', { field })]
  return column.trim() ? [checkPassed(field, 'taskColumnOk', { column })] : [checkFailed(field, 'taskColumnUnset')]
}

/** Excel 驱动：首批支持回写。 */
export const excelTaskSource: TaskSourceDriver<ExcelTaskSourceConfig> = {
  kind: 'excel',
  title: { zh: 'Excel 文件', en: 'Excel file' },
  description: { zh: '仓库中的 CSV / TSV / XLSX 任务清单', en: 'CSV / TSV / XLSX task list in a repository' },
  schema: ExcelTaskSourceSchema,
  fields,
  fieldMap: { defaults: STANDARD_TASK_FIELDS, required: ['id', 'title', 'status'] },
  /** 项目必须绑定这个代码仓库，清单文件从它的工作副本读取。 */
  repo: config => config.repo,
  verify,
  /** 先同步仓库，再从工作副本读取清单。 */
  async list(config: ExcelTaskSourceConfig, ctx: TaskSourceRunContext): Promise<RawTask[]> {
    ctx.signal.throwIfAborted()
    const tasks = (await loadTasks(config, ctx.syncRepo)).tasks
    ctx.signal.throwIfAborted()
    return tasks
  },
  /** 回写状态列；标准格式把完成/失败状态映射到枚举，自定义映射原样写入。 */
  async writeback(config: ExcelTaskSourceConfig, target, status, ctx: TaskSourceWriteContext): Promise<void> {
    const directory = config.repo && ctx.syncRepo ? await ctx.syncRepo(config.repo) : undefined
    const file = await taskFilePath(config, ctx.syncRepo, directory)
    const written = config.customColumns ? status : standardStatus(status)
    await writeTaskStatusAt(file, config.sheet, config.customColumns ? taskColumnsOf(config) : STANDARD_TASK_FIELDS, target, written)
    if (directory && ctx.commands) {
      await commitWorkCopy((args, cwd) => ctx.commands!.git(args, cwd), directory, file,
        `chore: record task ${target.taskId} as ${status}`)
    }
  },
}
