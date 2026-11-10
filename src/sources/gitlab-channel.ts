/** GitLab 出站频道：用智能体账号在 Issue/MR 下回帖。 */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { webBaseOf } from '../deployment.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { GITLAB_WEB, NoteSchema } from './gitlab-trigger.ts'

/** GitLab 返回 404 表示 issue/MR/note 已不存在，重试也不会成功。 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code === 404
/** 在 Issue 或 MR 下回帖，正文末尾带 HTML 标记；重试前先列出最近 notes，按标记去重。 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const gitlab = commands.gitlab
  if (!gitlab) throw new Error('The GitLab Source has no working CLI')
  const iid = Number(message.channel.address.number)
  const section = message.channel.address.kind === 'mr' ? 'merge_requests' : 'issues'
  if (!iid) throw new Error('Missing GitLab reply target')
  const path = `projects/${gitlab.projectId}/${section}/${iid}/notes`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    // GitLab notes 列表按创建时间倒序，最近的评论在前；用 100 条覆盖常见的重试窗口。
    const recent = await commands.gitlabApi(z.array(NoteSchema), `${path}?per_page=100&sort=desc&order_by=created_at`)
    if (recent.some(note => sameName(note.author.username, gitlab.login) && (note.body ?? '').includes(marker))) return 'sent'
    // 标记与正文同一行：Windows 的 .cmd 包装器经 cmd.exe 传参时无法保留换行。
    await commands.gitlabApi(path, '-X', 'POST', '-f', `body=${message.text} ${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** 频道深链优先使用触发器的网页 URL；没有时按记录实例的规范路径拼接。 */
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const isPr = address.kind === 'mr'
  const project = links.gitlab?.project
  const site = webBaseOf(links.gitlab?.instanceUrl ?? '', GITLAB_WEB).replace(/\/+$/, '')
  const fallback = project ? `${site}/${project}/-/${isPr ? 'merge_requests' : 'issues'}/${number}` : ''
  return { url: address.url ?? fallback,
    label: isPr ? { zh: `GitLab !${number}`, en: `GitLab !${number}` }
      : { zh: `GitLab #${number}`, en: `GitLab #${number}` } }
}
