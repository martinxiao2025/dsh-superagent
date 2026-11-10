/** 把 GitLab Issue、Merge Request 和 note 归一化为领域 Trigger。 */
import { z } from 'zod'
import type { ChannelRef, Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { mentions } from './forge.ts'
import { threadKey, triggerKey } from './identity.ts'

export const SOURCE = 'gitlab'
/** GitLab 的 Issue 与 MR 编号各自独立，因此 Thread ID 必须带类型前缀。 */
export const gitlabThread = (iid: number, isPr: boolean): string => `${isPr ? 'mr' : 'issue'}:${iid}`
export const GITLAB_WEB = 'https://gitlab.com'
/** GitLab 回帖地址：`kind` 区分 issues 与 merge_requests 两个 API 端点；`record` 是来源记录 ID。 */
export const gitlabChannel = (record: string, iid: number, isPr: boolean, url?: string): ChannelRef =>
  ({ source: record, thread: threadKey(record, gitlabThread(iid, isPr)),
    address: { number: String(iid), kind: isPr ? 'mr' : 'issue', ...(url ? { url } : {}) } })
/** GitLab 删除账号时作者可能为 null，按 `ghost` 处理。 */
export const GitlabUserSchema = z.looseObject({ id: z.number().nullish(), username: z.string(), bot: z.boolean().nullish() }).nullable()
  .transform(user => user ?? { username: 'ghost' })
export type GitlabUser = z.infer<typeof GitlabUserSchema>
/** 一条 issue/MR note；`system` 为 true 表示里程碑、标签等系统事件，不是人的评论。 */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), system: z.boolean().nullish(), author: GitlabUserSchema,
  created_at: z.string().nullish(), updated_at: z.string().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/** Issue 与 MR 共用的主体字段；MR 额外带分支、草稿与合并时间。 */
export const ItemSchema = z.looseObject({
  id: z.number(), iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string().nullish(),
  created_at: z.string(), updated_at: z.string().nullish(), web_url: z.string().nullish(), author: GitlabUserSchema,
  source_branch: z.string().nullish(), target_branch: z.string().nullish(),
  draft: z.boolean().nullish(), merged_at: z.string().nullish(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])).nullish(),
})
export type GitlabItem = z.infer<typeof ItemSchema>
export interface GitlabRef { iid: number; isPr: boolean; url?: string; prAuthor?: string }
/**
 * GitLab 的人机判定：非系统 note、`author.bot !== true`，且用户名不匹配 `_bot` 命名约定。
 * 智能体自己的账号由 `author` 再排除，与 GitHub 适配器一致。
 */
export const isHumanAccount = (user: { username: string; bot?: boolean | null }): boolean =>
  user.bot !== true && !/_bot(_|$)/i.test(user.username)
const author = (record: string, user: GitlabUser, agent: string) =>
  ({ actor: { source: record, id: user.username }, human: isHumanAccount(user) && !sameName(user.username, agent) })
const bodyOf = (item: { description?: string | null }): string => item.description ?? ''
/** note 的网页锚点为 `#note_<id>`；触发器 URL 与上下文消息 ID 因此保持一致。 */
const noteUrl = (note: GitlabNote, ref: GitlabRef): string | undefined =>
  ref.url ? `${ref.url}#note_${note.id}` : undefined
/** 构建一条 note 的 Trigger；系统 note 仍会生成对象，但 `human` 为 false，轮询时会直接跳过。 */
export function noteTrigger(record: string, note: GitlabNote, ref: GitlabRef, agent: string): Trigger {
  const at = note.updated_at ?? note.created_at ?? new Date().toISOString()
  const version = note.updated_at ?? ''
  const url = noteUrl(note, ref)
  const body = note.body ?? ''
  return { id: triggerKey(record, 'note', ref.isPr ? 'mr' : 'issue', String(ref.iid), String(note.id), version), source: record,
    threads: [{ source: record, id: gitlabThread(ref.iid, ref.isPr) }],
    ...author(record, note.author, agent), human: !note.system && isHumanAccount(note.author) && !sameName(note.author.username, agent),
    at, text: body,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(record, ref.iid, ref.isPr, ref.url),
    ...(url ?? ref.url ? { url: url ?? ref.url } : {}),
    meta: { number: ref.iid, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: note.id, kind: 'conversation' } }
}
/** 新 Issue 的标题与描述；Issue 与 MR 编号独立，因此触发器 ID 带 `issue` 前缀。 */
export function issueTrigger(record: string, item: GitlabItem, agent: string): Trigger {
  const body = bodyOf(item)
  return { id: triggerKey(record, 'issue', String(item.iid)), source: record,
    threads: [{ source: record, id: gitlabThread(item.iid, false) }], ...author(record, item.author, agent), at: item.created_at,
    text: `${item.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(record, item.iid, false, item.web_url ?? undefined),
    ...(item.web_url ? { url: item.web_url } : {}),
    meta: { number: item.iid, isPr: false, kind: 'issue' } }
}
/** 新 Merge Request；meta 形状与 GitHub PR 一致，便于策略和环境变量逻辑复用。 */
export function pullTrigger(record: string, item: GitlabItem, agent: string): Trigger {
  const body = bodyOf(item)
  return { id: triggerKey(record, 'mr', String(item.iid)), source: record,
    threads: [{ source: record, id: gitlabThread(item.iid, true) }], ...author(record, item.author, agent), at: item.created_at,
    text: `${item.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(record, item.iid, true, item.web_url ?? undefined),
    ...(item.web_url ? { url: item.web_url } : {}),
    meta: { number: item.iid, isPr: true, prAuthor: item.author.username, kind: 'pull' } }
}
