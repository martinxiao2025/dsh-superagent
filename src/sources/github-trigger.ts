/** 把 GitHub Issue、PR、评论、评审和 CI 状态变化归一化为领域触发器。 */
import { z } from 'zod'
import type { ChannelRef, Trigger } from '../core/index.ts'
import { webBaseOf } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import { mentions } from './forge.ts'
import { threadKey, triggerKey } from './identity.ts'
export { mentions } from './forge.ts'

export const SOURCE = 'github'
/** 记录 `instanceUrl` 所指向的 GitHub 站点根地址；企业实例去掉末尾斜杠。 */
const siteOf = (instanceUrl: string): string => webBaseOf(instanceUrl, 'https://github.com').replace(/\/+$/, '')
/** GitHub 回复地址：Issue/PR 会话，或 `url` 指向讨论评论时的评审线程；线程与来源都用记录 ID。 */
export const githubChannel = (record: string, number: number, url?: string): ChannelRef =>
  ({ source: record, thread: threadKey(record, String(number)), address: { number: String(number), ...(url ? { url } : {}) } })
/** 记录实例上的 Issue/PR 页面地址。 */
export const githubPage = (instanceUrl: string, repository: string, number: number, pr = false): string =>
  `${siteOf(instanceUrl)}/${repository}/${pr ? 'pull' : 'issues'}/${number}`
/**
 * 解析 `repository` 中 Issue、PR 或评审评论的网页或 API URL；其他站点、仓库或 URL 返回 undefined。
 * `instanceUrl` 为空时只认 github.com 与 api.github.com；企业实例只认自己的网页主机与 `<instanceUrl>/api/v3`。
 */
export function githubAddress(url: string, repository: string, instanceUrl = ''): { number: number; pr: boolean; discussion?: number } | undefined {
  const site = siteOf(instanceUrl)
  const api = instanceUrl ? `${site}/api/v3` : 'https://api.github.com'
  const after = (prefix: string): string | undefined => url.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
    ? url.slice(prefix.length) : undefined
  const rest = after(`${api}/repos/`) ?? after(`${site}/`)
  if (rest === undefined) return undefined
  const [path = '', hash = ''] = rest.split('#', 2)
  const match = /^([^/]+)\/([^/]+)\/(issues|pulls?)\/(\d+)\/?$/.exec(path)
  if (!match || !sameName(`${match[1]}/${match[2]}`, repository)) return undefined
  const discussion = /^discussion_r(\d+)$/.exec(hash)
  return { number: Number(match[4]), pr: match[3]!.toLowerCase() !== 'issues', ...discussion ? { discussion: Number(discussion[1]) } : {} }
}
/** GitHub 把已删除的账号返回为 `null`，并显示为 `ghost`。 */
export const UserSchema = z.looseObject({ login: z.string(), type: z.string().optional() }).nullable()
  .transform(user => user ?? { login: 'ghost', type: 'User' })
/**
 * GitHub 评论或评审；评审带有 `state` 和 `commit_id`，行内评审评论还带有文件、行号、diff 片段
 * 和 `in_reply_to_id`（其评审线程的根评论 ID）。
 */
export const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), user: UserSchema, html_url: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), submitted_at: z.string().nullish(),
  state: z.string().nullish(), commit_id: z.string().nullish(),
  path: z.string().nullish(), line: z.number().nullish(), original_line: z.number().nullish(), diff_hunk: z.string().nullish(),
  in_reply_to_id: z.number().nullish(),
})
export type GithubComment = z.infer<typeof CommentSchema>
/** `issues/<number>` 返回的 Issue；编号是 PR 时 GitHub 会设置 `pull_request`。 */
export const IssueSchema = CommentSchema.extend({
  number: z.number(), title: z.string(), state: z.string(), created_at: z.string(), html_url: z.string(),
  pull_request: z.looseObject({ url: z.string() }).nullish(),
})
export type GithubIssue = z.infer<typeof IssueSchema>
type Opened = Pick<GithubIssue, 'number' | 'title' | 'body' | 'user' | 'created_at' | 'html_url'>
export interface PullRef { number: number; isPr: boolean; url?: string; prAuthor?: string }
/**
 * GitHub 把该账号报告为普通用户而非机器人或 GitHub App 时为 true。
 * 以普通用户账号运行的评审机器人在这里算作人类；提示词会说明哪些账号是自动化的。
 */
export const isHumanLogin = (user: { login: string; type?: string }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')
/** 格式化行内评审评论的文件:行号以及其 diff 片段末尾几行（GitHub 的 diff 片段以被评论行为结尾）。 */
export function reviewPlace(comment: GithubComment): string {
  const line = comment.line ?? comment.original_line
  const hunk = (comment.diff_hunk ?? '').split('\n').slice(-3).join('\n')
  return [`${comment.path}${line != null ? `:${line}` : ''}`, hunk].filter(Boolean).join('\n')
}
function commentText(comment: GithubComment, kind: 'conversation' | 'inline' | 'review'): string {
  const decided = kind === 'review' && comment.state && comment.state !== 'COMMENTED'
  const decision = decided ? `${comment.state} review of commit ${comment.commit_id ?? 'unknown'}` : ''
  const place = kind === 'inline' && comment.path ? reviewPlace(comment) : ''
  return [decision, place, comment.body ?? ''].filter(Boolean).join('\n\n')
}
const author = (record: string, user: { login: string; type?: string }, agent: string) =>
  ({ actor: { source: record, id: user.login }, human: isHumanLogin(user) && !sameName(user.login, agent) })
/** 为评论或评审构建触发器；没有正文的评论或正文为空的 `COMMENTED` 评审，其 text 为空。 */
export function commentTrigger(record: string, comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = triggerKey(record, 'comment', comment.html_url ?? threadKey(record, String(ref.number)), String(comment.id), version)
  return { id, source: record, threads: [{ source: record, id: String(ref.number) }], ...author(record, comment.user, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(record, ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
}
/**
 * 为新打开的 Issue 的标题和正文构建触发器。
 * ID 与以前存储 Issue 正文时相同，因此已存储的正文不会被再次接入。
 */
export function issueTrigger(record: string, issue: Opened, agent: string): Trigger {
  const body = issue.body ?? ''
  return { id: triggerKey(record, 'issue', String(issue.number)), source: record,
    threads: [{ source: record, id: String(issue.number) }], ...author(record, issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(record, issue.number, issue.html_url), url: issue.html_url, meta: { number: issue.number, isPr: false, kind: 'issue' } }
}
/**
 * 为新打开的 PR 的标题和描述构建触发器。
 * GitHub 中 PR 与 Issue 共用同一编号序列且不会冲突，因此复用 `issueTrigger` 的 `github-issue` ID 格式。
 */
export function pullTrigger(record: string, pull: Opened, agent: string): Trigger {
  return { ...issueTrigger(record, pull, agent), meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
}
/** 为默认分支 CI 状态变化构建触发器；默认分支 CI 没有可回复的人，因此没有 `channel`。 */
export function branchCiTrigger(record: string, branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: triggerKey(record, 'ci', `branch:${branch}`, String(revision)), source: record,
    threads: [{ source: record, id: `ci:${branch}` }], actor: { source: record, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision } }
}
export function ciTrigger(record: string, pr: { number: number; html_url: string; user: { login: string } }, revision: number, summary: string): Trigger {
  return { id: triggerKey(record, 'ci', String(pr.number), String(revision)), source: record, threads: [{ source: record, id: String(pr.number) }],
    actor: { source: record, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: githubChannel(record, pr.number), url: pr.html_url,
    meta: { number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision } }
}
