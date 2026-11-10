/** GitHub 出站频道：以智能体账号发布 Issue/PR 评论和评审线程回复。 */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { githubAddress, githubPage } from './github-trigger.ts'

const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), in_reply_to_id: z.number().nullish(), user: z.looseObject({ login: z.string() }).nullish(),
})
/** Issue 被永久删除（410）或锁定（403）时为 true；404 会重试，因为它可能表示私有仓库临时失去权限。 */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
const missing = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** 发布评论或评审线程回复，并嵌入 HTML 标记，使重试不会产生重复评论。 */
export async function sendGithub(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const github = commands.github
  const { repository } = github
  const number = Number(message.channel.address.number)
  if (!number) throw new Error('Missing GitHub reply target')
  try {
    // 保留的触发器 URL 也会为线程感知投递之前排队的回复提供路由。
    const address = githubAddress(message.channel.address.url ?? '', repository)
    let rootId: number | undefined
    if (address?.pr && address.discussion && address.number === number) {
      // 目标行内评审评论被删除时，退回为顶层 PR 评论。
      const source = await commands.api(CommentSchema, `pulls/comments/${address.discussion}`)
        .catch((error: unknown) => { if (missing(error)) return undefined; throw error })
      rootId = source ? source.in_reply_to_id ?? source.id : undefined
    }
    const path = rootId === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const mine = (comment: z.infer<typeof CommentSchema>) => sameName(comment.user?.login ?? '', github.login)
      && (rootId === undefined || comment.in_reply_to_id === rootId) && (comment.body ?? '').includes(marker)
    if ((await commands.pages(CommentSchema, path)).some(mine)) return 'sent'
    const target = rootId === undefined ? path : `${path}/${rootId}/replies`
    await commands.api(z.unknown(), target, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function githubLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const review = !!links.repository && !!githubAddress(address.url ?? '', links.repository)?.discussion
  return { url: address.url ?? (links.repository ? githubPage(links.repository, Number(number)) : ''),
    label: review ? { zh: `GitHub #${number} 的 review 讨论`, en: `Review discussion on GitHub #${number}` }
      : { zh: `GitHub #${number}`, en: `GitHub #${number}` } }
}
