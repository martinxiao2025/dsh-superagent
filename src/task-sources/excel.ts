/**
 * Excel 任务来源驱动：清单位于项目代码仓库的工作副本中，读取前先同步仓库。
 * 只支持 010 标准格式（`tasks` 表 + 固定表头与枚举）；非标准清单整批拒绝并提示改造，
 * 回写沿用原子替换并保留原文件字节风格。清单文件缺失时按标准模板自动创建初始版本
 * 并提交进工作副本，项目从第一次验证或轮询起就可用。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { checkFailed, checkPassed, type SourceCheck } from '../setup.ts'
import { commitWorkCopy } from '../code-repos/work.ts'
import { readStandardTable } from './table.ts'
import { STANDARD_COLUMNS, STANDARD_TASK_FIELDS, TaskFormatError, parseStandardTasks, standardStatus } from './excel-format.ts'
import { taskTemplate } from './excel-template.ts'
import { TaskListError, type RawTask } from './tasks.ts'
import { writeTaskStatusAt } from './writeback.ts'
import {
  errorText, repoCheck, TaskRepoError,
  type TaskSourceDriver, type TaskSourceRunContext, type TaskSourceVerifyDeps, type TaskSourceWriteContext,
} from './kind.ts'

/** Excel 任务来源配置：清单是项目仓库内的相对路径，其余按 010 标准格式固定。 */
export const ExcelTaskSourceSchema = z.object({
  file: z.string().trim().min(1).max(1000),
}).strict()
export type ExcelTaskSourceConfig = z.infer<typeof ExcelTaskSourceSchema>

const fields: TaskSourceDriver['fields'] = [
  { key: 'file', type: 'text', label: { zh: '任务清单文件', en: 'Task list file' },
    hint: { zh: '相对仓库根目录的路径，例如 tasks/backlog.csv；缺失时自动按标准模板创建初始空表。内容须符合标准格式（tasks 表 + 固定表头）。', en: 'Path relative to the repository root, e.g. tasks/backlog.csv; an initial empty list is created from the standard template when missing. The content must follow the standard format (tasks sheet + fixed headers).' } },
]

/** 解析清单的本地绝对路径：仓库由项目决定，清单必须是仓库内相对路径。 */
export async function taskFilePath(
  config: ExcelTaskSourceConfig,
  syncRepo?: () => Promise<string>,
): Promise<string> {
  if (isAbsolute(config.file)) throw new TaskRepoError('repoNotReady', `任务清单路径必须是代码仓库内的相对路径：${config.file}`)
  if (!syncRepo) throw new TaskRepoError('repoNotReady', '代码仓库尚未接入同步能力')
  return join(await syncRepo(), config.file)
}

/**
 * 同步仓库并确保清单文件存在：缺失时按扩展名写标准模板初始版本（xlsx 用完整模板工作簿，
 * csv/tsv 写全部标准表头行），并提交进工作副本保持镜像干净。返回工作副本目录与是否新建。
 * 没有仓库同步能力（无法得知写入位置）时返回 undefined。
 */
export async function ensureTaskFile(
  config: ExcelTaskSourceConfig,
  syncRepo?: () => Promise<string>,
  git?: (args: string[], cwd: string) => Promise<string>,
): Promise<{ directory: string; created: boolean } | undefined> {
  if (!syncRepo) return undefined
  const directory = await syncRepo()
  const file = join(directory, config.file)
  if (existsSync(file)) return { directory, created: false }
  mkdirSync(dirname(file), { recursive: true })
  const extension = extname(config.file).toLowerCase()
  if (extension === '.xlsx') writeFileSync(file, taskTemplate())
  else {
    const delimiter = extension === '.tsv' ? '\t' : ','
    writeFileSync(file, `${STANDARD_COLUMNS.join(delimiter)}\n`, 'utf8')
  }
  if (git) {
    await commitWorkCopy(git, directory, file, `chore: initialize the standard task list ${config.file}`)
  }
  return { directory, created: true }
}

/** 读取结果：任务、标准格式版本与读取警告。 */
interface Loaded { tasks: RawTask[]; version: number; warnings: string[] }

/** 读取并校验清单；标准格式缺列、非法枚举、重复编号等问题整批抛出。已同步过时直接用目录。 */
async function loadTasks(config: ExcelTaskSourceConfig, syncRepo?: () => Promise<string>, directory?: string): Promise<Loaded> {
  const file = directory ? join(directory, config.file) : await taskFilePath(config, syncRepo)
  const standard = await readStandardTable(file)
  const parsed = parseStandardTasks(standard.table)
  const warnings = [...standard.warnings,
    ...parsed.unknown.length ? [`未知列已忽略：${parsed.unknown.join('、')}`] : [],
    ...parsed.empty ? ['任务表只有表头，当前没有待处理任务'] : []]
  return { tasks: parsed.tasks, version: standard.version, warnings }
}

/** 逐字段预检：缺失则先建初始版本，再校验文件可读且符合标准格式。 */
async function verify(config: ExcelTaskSourceConfig, field: string, deps: TaskSourceVerifyDeps): Promise<SourceCheck[]> {
  if (field !== 'file') return [checkFailed(field, 'checkUnsupported', { field })]
  if (isAbsolute(config.file)) return [checkFailed('file', 'taskFileAbsolute', { file: config.file })]
  let file: string
  try { file = await taskFilePath(config, deps.syncRepo) } catch (error) { return [repoCheck('file', error)] }
  let created = false
  if (!existsSync(file)) {
    const ensured = await ensureTaskFile(config, deps.syncRepo, deps.git)
    if (!ensured) return [checkFailed('file', 'taskFileMissing', { file })]
    created = ensured.created
  }
  try {
    const loaded = await loadTasks(config, deps.syncRepo)
    const warnings = loaded.warnings.length ? `；${loaded.warnings.join('；')}` : ''
    return [checkPassed('file', created ? 'taskFileCreated' : 'taskFileStandardOk',
      { rows: String(loaded.tasks.length), version: String(loaded.version), warnings })]
  } catch (error) {
    if (error instanceof TaskFormatError) return [checkFailed('file', error.code, { output: error.message })]
    if (error instanceof TaskListError) return [checkFailed('file', 'taskFileUnreadable', { output: error.message })]
    return [checkFailed('file', 'taskFileUnreadable', { output: errorText(error) })]
  }
}

/** Excel 驱动：首批支持回写。 */
export const excelTaskSource: TaskSourceDriver<ExcelTaskSourceConfig> = {
  kind: 'excel',
  title: { zh: 'Excel 文件', en: 'Excel file' },
  description: { zh: '仓库中的标准格式 CSV / TSV / XLSX 任务清单', en: 'Standard-format CSV / TSV / XLSX task list in a repository' },
  schema: ExcelTaskSourceSchema,
  fields,
  fieldMap: { defaults: STANDARD_TASK_FIELDS, required: ['id', 'title', 'status'] },
  verify,
  /** 先同步项目仓库（清单缺失时自动建初始版本），再从工作副本读取清单；仓库只同步一次。 */
  async list(config: ExcelTaskSourceConfig, ctx: TaskSourceRunContext): Promise<RawTask[]> {
    ctx.signal.throwIfAborted()
    const git = ctx.commands && typeof ctx.commands.git === 'function' ? (args: string[], cwd: string) => ctx.commands!.git(args, cwd) : undefined
    const ensured = await ensureTaskFile(config, ctx.syncRepo, git)
    if (!ensured) throw new TaskRepoError('repoNotReady', '代码仓库尚未接入同步能力')
    const tasks = (await loadTasks(config, ctx.syncRepo, ensured.directory)).tasks
    ctx.signal.throwIfAborted()
    return tasks
  },
  /** 回写状态列；完成/失败映射到标准枚举后写入 `tasks` 表。 */
  async writeback(config: ExcelTaskSourceConfig, target, status, ctx: TaskSourceWriteContext): Promise<void> {
    const directory = ctx.syncRepo ? await ctx.syncRepo() : undefined
    const file = await taskFilePath(config, ctx.syncRepo)
    await writeTaskStatusAt(file, STANDARD_TASK_FIELDS, target, standardStatus(status))
    if (directory && ctx.commands) {
      await commitWorkCopy((args, cwd) => ctx.commands!.git(args, cwd), directory, file,
        `chore: record task ${target.taskId} as ${status}`)
    }
  },
}
