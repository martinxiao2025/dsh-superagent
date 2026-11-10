/** GitLab Issue/MR 本体与 note 的只读上下文，供评估和 worker 读取。 */
import { z } from 'zod'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { isHumanAccount, ItemSchema, NoteSchema, type GitlabItem, type GitlabNote } from './gitlab-trigger.ts'

/** 把 GitLab 的标签（字符串或 `{name}` 对象）归一化为名字数组。 */
const labelNames = (item: Pick<GitlabItem, 'labels'>): string[] =>
  (item.labels ?? []).map(label => typeof label === 'string' ? label : label.name)
/** GitLab 的 note 或主体转成模型可读消息；机器人/系统账号标记 `bot`，避免被当成人类授权。 */
function gitlabMessage(from: string, at: string, text: string, id: string, options: { url?: string; bot?: boolean } = {}): ContextMessage {
  return { id, from, at, text, ...options.bot ? { bot: true as const } : {}, ...options.url ? { url: options.url } : {} }
}
const itemMessage = (item: GitlabItem): ContextMessage => gitlabMessage(item.author.username, item.created_at,
  `${item.title}\n\n${item.description ?? ''}`, item.web_url ?? String(item.iid),
  { url: item.web_url ?? undefined, bot: !isHumanAccount(item.author) })
const noteMessage = (note: GitlabNote, item?: GitlabItem): ContextMessage => {
  const url = item?.web_url ? `${item.web_url}#note_${note.id}` : undefined
  return gitlabMessage(note.author.username, note.created_at ?? note.updated_at ?? '', note.body ?? '',
    url ?? String(note.id), { url, bot: !!note.system || !isHumanAccount(note.author) })
}
/** 读取资源的 GitLab API 前缀；读取器也可能在 setup 完成前被调用，因此给出清晰错误。 */
const apiProject = (commands: Commands): string => {
  const project = commands.gitlab
  if (!project) throw new Error('The GitLab Source has no working CLI')
  return `projects/${encodeURIComponent(project.project)}`
}
/** 读取 Issue 或 MR 的一页 note（第一页也包含本体描述），`next_resource` 表示还有下一页。 */
async function conversationPage(commands: Commands, kind: 'issues' | 'mrs', iid: number, page: number) {
  const path = `${apiProject(commands)}/${kind === 'issues' ? 'issues' : 'merge_requests'}/${iid}`
  const item = await commands.gitlabApi(ItemSchema, path)
  const messages: ContextMessage[] = page === 1 ? [itemMessage(item)] : []
  const listed = await commands.gitlabApi(z.array(z.unknown()), `${path}/notes?sort=asc&order_by=created_at&per_page=100&page=${page}`)
  const tally: Tally = { skipped: 0 }
  const notes = validItems(NoteSchema, listed, tally)
  messages.push(...notes.filter(note => !note.system).map(note => noteMessage(note, item)))
  return { messages, next_resource: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}
/**
 * 读取 Issue/MR 本体或一页 note，返回模型可读的 `{ messages }` 或带标题、状态、分支的摘要。
 * 资源命名与 GitHub 对齐：`gitlab/<record>/issues/<iid>`、`gitlab/<record>/mrs/<iid>`、`gitlab/<record>/issues/<iid>/notes/<page>`；
 * 记录段可省略，由调用方的命令作用域决定。
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const match = /^gitlab\/(?:([^/]+)\/)?(issues|mrs)\/([1-9]\d*)(?:\/notes(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/<record>/issues/<iid>, gitlab/<record>/mrs/<iid>, or append /notes/<page>')
  const [, , kind = 'issues', iidText, page = '1'] = match
  const iid = Number(iidText)
  if (resource.includes('/notes')) {
    if (match[4] && Number(match[4]) < 1) throw new Error('Note pages start at 1')
    return conversationPage(commands, kind as 'issues' | 'mrs', iid, Number(page))
  }
  const item = await commands.gitlabApi(ItemSchema, `${apiProject(commands)}/${kind === 'issues' ? 'issues' : 'merge_requests'}/${iid}`)
  const branches = item.source_branch && item.target_branch ? { head: item.source_branch, base: item.target_branch } : {}
  const labels = labelNames(item).length ? { labels: labelNames(item) } : {}
  return { number: item.iid, title: item.title, state: item.state ?? '', ...item.merged_at ? { merged: true } : {},
    ...item.draft ? { draft: true } : {}, ...branches, ...labels, ...itemMessage(item) }
}
/**
 * GitLab Trigger 的上下文阅读器：Issue/MR 描述在第一页，note 按创建时间升序分页。
 * 评论 Trigger 与本体 Trigger 都读取同一会话，因此 part 不影响结果。
 */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, _part, cursor) => {
    const iid = Number(trigger.meta.number)
    const body = await conversationPage(commands, trigger.meta.isPr ? 'mrs' : 'issues', iid, Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next_resource ?? undefined, body }
  },
}
