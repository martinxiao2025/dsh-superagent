/**
 * 飞书知识库任务来源驱动：一个 spaceId 绑定一组根节点，目录递归、多文档与多维表格都从同一遍历产生任务。
 * 首批只读，不实现回写。
 */
import { z } from 'zod'
import { checkFailed, checkPassed, type SourceCheck } from '../setup.ts'
import { FeishuApiError, type FeishuWikiApi } from './feishu-api.ts'
import { issuesText, readWikiTasks } from './feishu-wiki-read.ts'
import {
  DEFAULT_TASK_FIELDS, errorText, taskColumnShape, taskColumnsOf,
  type TaskSourceDriver, type TaskSourceRunContext, type TaskSourceVerifyDeps,
} from './kind.ts'

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

/** 把知识库链接触发的失败归入面板可本地化的原因。 */
function wikiErrorCode(error: unknown): string {
  const text = errorText(error)
  const status = error instanceof FeishuApiError ? error.status : undefined
  const code = error instanceof FeishuApiError ? error.code : undefined
  if (status === 403 || [99991663, 99991672, 131006].includes(code ?? -1) || /permission|forbidden|无权限|\b403\b/i.test(text)) {
    return 'feishuWikiForbidden'
  }
  if (status === 404 || [131002, 131003].includes(code ?? -1) || /not found|does not exist|\b404\b/i.test(text)) return 'feishuWikiMissing'
  return 'feishuWikiUnreadable'
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

/** 飞书知识库驱动：只读；每个文档/表格独立解析，单份失败不拖垮其他文档。 */
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
}
