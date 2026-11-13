/**
 * 飞书群消息任务来源驱动：把指定群里最近的文本消息当作任务清单，一条消息一个任务。
 * 只读、不回写；消息编号稳定，执行成功且内容未变的消息不会被重复执行。
 */
import { z } from 'zod'
import { checkFailed, checkPassed, type SourceCheck } from '../setup.ts'
import { FeishuApiError } from './feishu-api.ts'
import type { FeishuImApi } from './feishu-im-api.ts'
import {
  DEFAULT_TASK_FIELDS, errorText,
  type TaskSourceDriver, type TaskSourceRunContext, type TaskSourceVerifyDeps,
} from './kind.ts'

/** 任务标题的最大长度；完整消息仍保留在描述里。 */
const TITLE_MAX = 80

/** 群消息配置：凭据与群 ID 是必填范围，其余控制读取窗口与任务状态。 */
export const FeishuImTaskSourceSchema = z.object({
  feishuCredential: z.string().trim().max(64).default(''),
  chatId: z.string().trim().max(200).default(''),
  limit: z.number().int().min(1).max(200).default(20),
  /** 生成的 RawTask.status；必须与项目准入状态一致，否则轮询不会产生任务。 */
  taskStatus: z.string().trim().min(1).max(100).default('待处理'),
  stripMentions: z.boolean().default(true),
}).strict()
export type FeishuImTaskSourceConfig = z.infer<typeof FeishuImTaskSourceSchema>

const fields: TaskSourceDriver['fields'] = [
  { key: 'feishuCredential', type: 'text', label: { zh: '飞书凭据', en: 'Feishu credential' },
    hint: { zh: '设置 › 飞书凭据里的记录 ID；应用密钥不会进入任务来源配置。',
      en: 'Record ID from Settings › Feishu credentials; the app secret never enters the TaskSource config.' } },
  { key: 'chatId', type: 'text', label: { zh: '群 ID', en: 'Chat ID' },
    hint: { zh: '群设置或群链接里的 `oc_` 开头标识；应用需要开启群消息读取权限。',
      en: 'The `oc_` identifier from the chat settings or link; the app needs permission to read chat messages.' } },
  { key: 'limit', type: 'number', min: 1, max: 200, label: { zh: '最多读取消息数', en: 'Maximum messages' },
    hint: { zh: '按时间倒序读取最近的消息；首次轮询会把窗口内的历史消息当作待办。',
      en: 'Reads the most recent messages first; the first poll treats every message in the window as pending.' } },
  { key: 'taskStatus', type: 'text', label: { zh: '任务状态', en: 'Task status' },
    hint: { zh: '写入每条消息的状态；必须与项目的准入状态一致，默认「待处理」。',
      en: 'Status written on every message; it must match the Project pending statuses. Defaults to 待处理.' } },
  { key: 'stripMentions', type: 'switch', label: { zh: '去掉 @ 占位', en: 'Strip mentions' }, advanced: true,
    hint: { zh: '移除消息里的 @_user_N 占位，避免进入任务标题。',
      en: 'Removes @_user_N placeholders so they do not reach task titles.' } },
]

/** 把消息权限与不存在分别归入面板可本地化的原因。 */
function chatErrorCode(error: unknown): string {
  const text = errorText(error)
  const status = error instanceof FeishuApiError ? error.status : undefined
  const code = error instanceof FeishuApiError ? error.code : undefined
  if (status === 403 || [99991663, 99991672, 230003].includes(code ?? -1) || /permission|forbidden|无权限|\b403\b/i.test(text)) {
    return 'feishuChatForbidden'
  }
  if (status === 404 || [230001, 230002].includes(code ?? -1) || /not found|not in chat|does not exist|\b404\b/i.test(text)) {
    return 'feishuChatMissing'
  }
  return 'feishuChatUnreadable'
}

/** 取凭据：未填写、未安装或材料不可用都给出不同的可读结果。 */
async function apiOf(config: FeishuImTaskSourceConfig,
  deps: Pick<TaskSourceVerifyDeps, 'feishuIm'>): Promise<{ api: FeishuImApi } | { check: SourceCheck }> {
  if (!config.feishuCredential) return { check: checkFailed('feishuCredential', 'feishuCredentialUnset') }
  const api = await deps.feishuIm?.(config.feishuCredential)
  return api ? { api } : { check: checkFailed('feishuCredential', 'feishuCredentialMissing', { credential: config.feishuCredential }) }
}

/** 逐字段预检：凭据、群可读性与读取参数。 */
async function verify(config: FeishuImTaskSourceConfig, field: string, deps: TaskSourceVerifyDeps): Promise<SourceCheck[]> {
  if (field === 'feishuCredential') {
    if (!config.feishuCredential) return [checkFailed('feishuCredential', 'feishuCredentialUnset')]
    const api = await deps.feishuIm?.(config.feishuCredential)
    return api ? [checkPassed('feishuCredential', 'feishuCredentialOk', { credential: config.feishuCredential })]
      : [checkFailed('feishuCredential', 'feishuCredentialMissing', { credential: config.feishuCredential })]
  }
  if (field === 'chatId') {
    if (!config.chatId) return [checkFailed('chatId', 'feishuChatUnset')]
    const resolved = await apiOf(config, deps)
    if ('check' in resolved) return [resolved.check]
    try {
      const messages = await resolved.api.messages(config.chatId, { limit: 1 })
      return [checkPassed('chatId', 'feishuChatOk', { chatId: config.chatId, messages: String(messages.length) })]
    } catch (error) {
      return [checkFailed('chatId', chatErrorCode(error), { chatId: config.chatId, output: errorText(error) })]
    }
  }
  if (field === 'limit') return [checkPassed('limit', 'feishuImLimitOk', { limit: String(config.limit) })]
  if (field === 'taskStatus') return [checkPassed('taskStatus', 'feishuImStatusOk', { status: config.taskStatus })]
  if (field === 'stripMentions') return [checkPassed('stripMentions', 'feishuImMentionsOk')]
  return [checkFailed(field, 'checkUnsupported', { field })]
}

/** 去掉 @ 占位并压缩空白；只用于标题与正文展示，不改变消息身份。 */
function cleanText(text: string, stripMentions: boolean): string {
  return stripMentions ? text.replace(/@_user_\d+/g, '').replace(/[ \t]{2,}/g, ' ').trim() : text.trim()
}

/** 飞书群消息驱动：只读；按消息编号去重，跳过没有文本的消息。 */
export const feishuImTaskSource: TaskSourceDriver<FeishuImTaskSourceConfig> = {
  kind: 'feishu-im',
  title: { zh: '飞书消息', en: 'Feishu messages' },
  description: { zh: '把群消息当作任务清单逐条读取', en: 'Read chat messages as a task list' },
  schema: FeishuImTaskSourceSchema,
  fields,
  fieldMap: { defaults: DEFAULT_TASK_FIELDS, required: ['id', 'title'] },
  verify,
  async list(config: FeishuImTaskSourceConfig, ctx: TaskSourceRunContext) {
    ctx.signal.throwIfAborted()
    if (!config.chatId) throw new Error('任务来源没有填写群 ID，无法读取飞书消息')
    const api = config.feishuCredential ? await ctx.feishuIm?.(config.feishuCredential) : undefined
    if (!api) throw new Error(config.feishuCredential
      ? `飞书凭据 ${config.feishuCredential} 不可用，无法读取群消息`
      : '任务来源没有绑定飞书凭据，无法读取群消息')
    const messages = await api.messages(config.chatId, { limit: config.limit, signal: ctx.signal })
    ctx.signal.throwIfAborted()
    return messages.flatMap(message => {
      const text = cleanText(message.text, config.stripMentions)
      if (!text) return []
      const [first] = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      return [{ id: message.messageId, title: (first ?? message.messageId).slice(0, TITLE_MAX),
        description: text, status: config.taskStatus }]
    })
  },
}
