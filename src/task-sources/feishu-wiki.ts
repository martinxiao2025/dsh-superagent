/**
 * 飞书知识库任务来源驱动：一个 spaceId 绑定一组根节点，目录递归、多文档与多维表格都从同一遍历产生任务。
 * 回写只支持多维表格记录的状态字段（任务键携带记录 ID）；docx 正文文档没有可更新的记录，明确报未支持。
 */
import { z } from 'zod'
import { checkFailed, checkPassed, type SourceCheck } from '../setup.ts'
import { type FeishuWikiApi } from './feishu-api.ts'
import { feishuFailureCode } from '../feishu-transport.ts'
import { issuesText, readWikiTasks } from './feishu-wiki-read.ts'
import {
  DEFAULT_TASK_FIELDS, errorText, taskColumnShape, taskColumnsOf,
  type TaskSourceDriver, type TaskSourceRunContext, type TaskSourceVerifyDeps, type TaskSourceWriteContext,
} from './kind.ts'
import { locateRow } from './locate.ts'

/** 根节点以 token 为身份；标题与类型由读取时解析，避免存下会过期的显示值。 */
export const FeishuWikiRootSchema = z.object({ nodeToken: z.string().trim().min(1).max(200) }).strict()
/** 飞书知识库配置：`spaceId` 是唯一归属，`roots` 为空时读取整个知识空间。 */
export const FeishuWikiTaskSourceSchema = z.object({
  feishuCredential: z.string().trim().max(64).default(''),
  spaceId: z.string().trim().max(64).default(''),
  roots: z.array(FeishuWikiRootSchema).max(200).default([]),
  strict: z.boolean().default(false),
  ...taskColumnShape,
}).strict()
export type FeishuWikiTaskSourceConfig = z.infer<typeof FeishuWikiTaskSourceSchema>

const fields: TaskSourceDriver['fields'] = [
  { key: 'feishuCredential', type: 'text', label: { zh: '飞书凭据', en: 'Feishu credential' },
    hint: { zh: '设置 › 飞书凭据里的记录 ID；应用密钥不会进入任务来源配置。',
      en: 'Record ID from Settings › Feishu credentials; the app secret never enters the TaskSource config.' } },
  { key: 'spaceId', type: 'text', label: { zh: '知识库 ID', en: 'Wiki space ID' },
    hint: { zh: '一个知识空间只归属一个任务来源。', en: 'A wiki space belongs to exactly one TaskSource.' } },
  { key: 'roots', type: 'rows', label: { zh: '根节点', en: 'Root nodes' },
    hint: { zh: '留空表示读取整个知识空间；多个根节点按顺序读取，目录会递归。',
      en: 'Leave empty to read the whole space; roots are read in order and folders recurse.' },
    columns: [{ key: 'nodeToken', label: { zh: '节点 token 或链接', en: 'Node token or URL' }, type: 'text' }] },
  { key: 'strict', type: 'switch', label: { zh: '严格编号', en: 'Strict IDs' }, advanced: true,
    hint: { zh: '同一任务编号出现在多份文档时整次同步失败。', en: 'Fail the whole sync when one task ID appears in several documents.' } },
  { key: 'idColumn', type: 'text', label: { zh: '编号列', en: 'ID column' }, advanced: true },
  { key: 'titleColumn', type: 'text', label: { zh: '标题列', en: 'Title column' }, advanced: true },
  { key: 'descriptionColumn', type: 'text', label: { zh: '描述列', en: 'Description column' }, advanced: true },
  { key: 'statusColumn', type: 'text', label: { zh: '状态列', en: 'Status column' }, advanced: true },
  { key: 'priorityColumn', type: 'text', label: { zh: '优先级列', en: 'Priority column' }, advanced: true },
]

/** 把知识库链接触发的失败归入面板可本地化的原因；语义判定由传输层的分类表单点维护。 */
function wikiErrorCode(error: unknown): string {
  return feishuFailureCode(error, { forbidden: 'feishuWikiForbidden', missing: 'feishuWikiMissing', fallback: 'feishuWikiUnreadable' })
}

/** 列字段逐项预检；多维表格同样按这组列名匹配字段。 */
function columnCheck(field: string, config: FeishuWikiTaskSourceConfig): SourceCheck {
  const column = ({ idColumn: config.idColumn, titleColumn: config.titleColumn, descriptionColumn: config.descriptionColumn,
    statusColumn: config.statusColumn, priorityColumn: config.priorityColumn } as Record<string, string>)[field]
  if (column === undefined) return checkFailed(field, 'checkUnsupported', { field })
  return column.trim() ? checkPassed(field, 'taskColumnOk', { column }) : checkFailed(field, 'taskColumnUnset')
}

/** 取凭据：未填写、未安装或材料不可用都给出不同的可读结果。 */
async function apiOf(config: FeishuWikiTaskSourceConfig,
  deps: Pick<TaskSourceVerifyDeps, 'feishu'>): Promise<{ api: FeishuWikiApi } | { check: SourceCheck }> {
  if (!config.feishuCredential) return { check: checkFailed('feishuCredential', 'feishuCredentialUnset') }
  const api = await deps.feishu?.(config.feishuCredential)
  return api ? { api } : { check: checkFailed('feishuCredential', 'feishuCredentialMissing', { credential: config.feishuCredential }) }
}

/** 逐字段预检：凭据、知识空间、根节点与列映射。 */
async function verify(config: FeishuWikiTaskSourceConfig, field: string, deps: TaskSourceVerifyDeps): Promise<SourceCheck[]> {
  if (field === 'feishuCredential') {
    if (!config.feishuCredential) return [checkFailed('feishuCredential', 'feishuCredentialUnset')]
    const api = await deps.feishu?.(config.feishuCredential)
    return api ? [checkPassed('feishuCredential', 'feishuCredentialOk', { credential: config.feishuCredential })]
      : [checkFailed('feishuCredential', 'feishuCredentialMissing', { credential: config.feishuCredential })]
  }
  if (field === 'spaceId') {
    if (!config.spaceId) return [checkFailed('spaceId', 'feishuWikiSpaceUnset')]
    const resolved = await apiOf(config, deps)
    if ('check' in resolved) return [resolved.check]
    try {
      const nodes = await resolved.api.children(config.spaceId, '')
      return [checkPassed('spaceId', 'feishuWikiSpaceOk', { spaceId: config.spaceId, nodes: String(nodes.length) })]
    } catch (error) {
      return [checkFailed('spaceId', wikiErrorCode(error), { spaceId: config.spaceId, output: errorText(error) })]
    }
  }
  if (field === 'roots') {
    const resolved = await apiOf(config, deps)
    if ('check' in resolved) return [resolved.check]
    if (!config.roots.length) return [checkPassed('roots', 'feishuWikiRootsSpace', { spaceId: config.spaceId })]
    const missing: string[] = []
    for (const root of config.roots) {
      try { await resolved.api.node(root.nodeToken) } catch { missing.push(root.nodeToken) }
    }
    return missing.length
      ? [checkFailed('roots', 'feishuWikiRootsMissing', { missing: missing.join('、') })]
      : [checkPassed('roots', 'feishuWikiRootsOk', { roots: String(config.roots.length) })]
  }
  if (field === 'strict') return [checkPassed('strict', 'taskStrictOk')]
  return [columnCheck(field, config)]
}

/** 飞书知识库驱动：读取知识空间、目录与多维表格；回写只支持多维表格记录的状态字段。 */
export const feishuWikiTaskSource: TaskSourceDriver<FeishuWikiTaskSourceConfig> = {
  kind: 'feishu-wiki',
  title: { zh: '飞书知识库', en: 'Feishu wiki' },
  description: { zh: '从知识空间、目录与多维表格读取任务', en: 'Read tasks from a wiki space, folders and bitables' },
  schema: FeishuWikiTaskSourceSchema,
  fields,
  fieldMap: { defaults: DEFAULT_TASK_FIELDS, required: ['id', 'title', 'status'] },
  knowledgeBase: config => config.spaceId,
  verify,
  async list(config: FeishuWikiTaskSourceConfig, ctx: TaskSourceRunContext) {
    ctx.signal.throwIfAborted()
    const api = config.feishuCredential ? await ctx.feishu?.(config.feishuCredential) : undefined
    if (!api) throw new Error(config.feishuCredential
      ? `飞书凭据 ${config.feishuCredential} 不可用，无法读取知识库`
      : '任务来源没有绑定飞书凭据，无法读取知识库')
    const result = await readWikiTasks(api, { spaceId: config.spaceId, roots: config.roots.map(root => root.nodeToken),
      strict: config.strict }, taskColumnsOf(config))
    ctx.signal.throwIfAborted()
    if (!result.tasks.length && result.issues.length) {
      throw new Error(`知识库没有可读取的任务：${issuesText(result.issues)}`)
    }
    return result.tasks
  },
  /** 回写多维表格记录的状态字段：任务键携带记录 ID；docx 任务没有可定位的记录，明确报未支持。 */
  async writeback(config: FeishuWikiTaskSourceConfig, target, status, ctx: TaskSourceWriteContext): Promise<void> {
    const parts = target.taskId.split(':')
    if (parts[0] !== 'feishu-bitable' || parts.length !== 4) {
      throw new Error(`飞书文档任务不支持回写（正文文档没有可更新的记录）：${target.taskId}`)
    }
    const [, nodeToken = '', tableId = '', recordId = ''] = parts
    if (!nodeToken || !tableId || !recordId) throw new Error(`任务键不是可回写的多维表格记录：${target.taskId}`)
    const api = config.feishuCredential ? await ctx.feishu?.(config.feishuCredential) : undefined
    if (!api?.updateRecord) throw new Error('任务来源没有绑定可写回的飞书凭据，无法回写知识库')
    try { await api.node(nodeToken) } catch (error) {
      throw new Error(`无法回写：多维表格 ${nodeToken} 已不可读（${error instanceof Error ? error.message : String(error)}）`)
    }
    // CAS（评审 C3）：给出期望状态时先读记录当前值，不匹配拒绝写入——人工修改不被无提示覆盖。
    // 行定位与 CAS 共用 locate.ts 单源（bitable 按 recordId 定位，无标题兜底）；无 CAS 期望时直接按任务键写入。
    const statusColumn = config.statusColumn || DEFAULT_TASK_FIELDS.status
    const { records, updateRecord } = api
    const update = (recordId: string) => updateRecord(nodeToken, tableId, recordId, { [statusColumn]: status })
    if (target.expectedStatus === undefined) { await update(recordId); return }
    const cellText = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(String).join('') : ''
    const record = locateRow((await records(nodeToken, tableId)).map(row => ({ row, id: row.recordId, title: '', status: cellText(row.fields[statusColumn]).trim() })),
      { taskId: recordId, taskTitle: target.taskTitle }, target.expectedStatus,
      (reason: 'duplicate' | 'missing' | 'cas', { count, current }: { count: number; current: string }) => reason === 'duplicate'
        ? new Error(`多维表格中记录「${recordId}」匹配到 ${count} 行，回写被拒绝`)
        : reason === 'missing' ? new Error(`多维表格中找不到记录：${recordId}`)
          : new Error(`任务清单的状态已不是「${target.expectedStatus}」（当前为「${current || '(空)'}」），回写被拒绝；请人工确认该任务的最终状态`))
    await update(record.recordId)
  },
}
