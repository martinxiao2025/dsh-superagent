/** 飞书知识库任务来源驱动：复用现有文档读取，首批只读、不实现回写。 */
import { z } from 'zod'
import type { SourceCheck } from '../setup.ts'
import { readFeishuTasksWith } from './feishu-doc.ts'
import {
  checkFailed, checkPassed, errorText, taskColumnShape, taskColumnsOf,
  type TaskSourceDriver, type TaskSourceRunContext, type TaskSourceVerifyDeps,
} from './kind.ts'

/** 飞书知识库配置：`source` 为已安装飞书来源记录 ID，用于取得机器人 CLI 调用。 */
export const FeishuWikiTaskSourceSchema = z.object({
  source: z.string().trim().max(64).default(''),
  url: z.string().trim().min(1).max(1000),
  ...taskColumnShape,
}).strict()
export type FeishuWikiTaskSourceConfig = z.infer<typeof FeishuWikiTaskSourceSchema>

const fields: TaskSourceDriver['fields'] = [
  { key: 'source', type: 'text', label: { zh: '飞书来源', en: 'Feishu source' },
    hint: { zh: '已安装的飞书来源记录 ID，用它的机器人身份读取文档。', en: 'Installed Feishu source record ID used to read the document.' } },
  { key: 'url', type: 'text', label: { zh: '知识库链接', en: 'Wiki URL' }, hint: { zh: '飞书文档或知识库节点链接。', en: 'Feishu document or wiki node URL.' } },
  { key: 'idColumn', type: 'text', label: { zh: '编号列', en: 'ID column' }, advanced: true },
  { key: 'titleColumn', type: 'text', label: { zh: '标题列', en: 'Title column' }, advanced: true },
  { key: 'descriptionColumn', type: 'text', label: { zh: '描述列', en: 'Description column' }, advanced: true },
  { key: 'statusColumn', type: 'text', label: { zh: '状态列', en: 'Status column' }, advanced: true },
  { key: 'priorityColumn', type: 'text', label: { zh: '优先级列', en: 'Priority column' }, advanced: true },
]

/** 列字段逐项预检；飞书清单可能退化为复选框列表，因此这里只校验列名非空。 */
function columnCheck(field: string, config: FeishuWikiTaskSourceConfig): SourceCheck {
  const column = ({ idColumn: config.idColumn, titleColumn: config.titleColumn, descriptionColumn: config.descriptionColumn,
    statusColumn: config.statusColumn, priorityColumn: config.priorityColumn } as Record<string, string>)[field]
  if (column === undefined) return checkFailed(field, 'checkUnsupported', { field })
  return column.trim() ? checkPassed(field, 'taskColumnOk', { column }) : checkFailed(field, 'taskColumnUnset')
}

/** 逐字段预检：来源记录可用、文档可读、列映射非空。 */
async function verify(config: FeishuWikiTaskSourceConfig, field: string, deps: TaskSourceVerifyDeps): Promise<SourceCheck[]> {
  if (field === 'source') {
    if (!config.source) return [checkFailed('source', 'feishuSourceUnset')]
    const lark = await deps.lark(config.source)
    return lark ? [checkPassed('source', 'feishuSourceOk', { name: config.source })] : [checkFailed('source', 'feishuSourceMissing', { source: config.source })]
  }
  if (field === 'url') {
    if (!config.url) return [checkFailed('url', 'wikiUrlUnset')]
    if (!config.source) return [checkFailed('url', 'feishuSourceUnset')]
    const lark = await deps.lark(config.source)
    if (!lark) return [checkFailed('url', 'feishuSourceMissing', { source: config.source })]
    try {
      const tasks = await readFeishuTasksWith(lark, config.url, taskColumnsOf(config))
      return [checkPassed('url', 'wikiUrlOk', { rows: String(tasks.length) })]
    } catch (error) {
      return [checkFailed('url', 'wikiUnreadable', { output: errorText(error) })]
    }
  }
  return [columnCheck(field, config)]
}

/** 飞书知识库驱动：首批只读。 */
export const feishuWikiTaskSource: TaskSourceDriver<FeishuWikiTaskSourceConfig> = {
  kind: 'feishu-wiki',
  title: { zh: '飞书知识库', en: 'Feishu wiki' },
  description: { zh: '从飞书文档或知识库节点读取任务', en: 'Read tasks from a Feishu document or wiki node' },
  schema: FeishuWikiTaskSourceSchema,
  fields,
  fieldMap: { defaults: { id: 'id', title: 'title', description: 'description', status: 'status', priority: 'priority' }, required: ['id', 'title'] },
  verify,
  /** 复用现有文档读取；`commands` 必须已绑定到配置的飞书来源。 */
  async list(config: FeishuWikiTaskSourceConfig, ctx: TaskSourceRunContext) {
    ctx.signal.throwIfAborted()
    const tasks = await readFeishuTasksWith(args => ctx.commands.lark(args), config.url, taskColumnsOf(config))
    ctx.signal.throwIfAborted()
    return tasks
  },
}
