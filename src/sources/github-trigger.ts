/** 把 GitHub Issue、PR、评论、评审和 CI 状态变化归一化为领域触发器。 */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { mentions } from './forge.ts'
export { mentions } from './forge.ts'

export const SOURCE = 'github'
/** GitHub 回复地址：Issue/PR 会话，或 `url` 指向讨论评论时的评审线程。 */
export const githubChannel = (number: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: `github:${number}`, address: { number: String(number), ...(url ? { url } : {}) } })
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${number}`
/** 解析 `repository` 中 Issue、PR 或评审评论的网页或 API URL；其他 URL 或仓库返回 undefined。 */
export function githubAddress(url: string, repository: string): { number: number; pr: boolean; discussion?: number } | undefined {
  const address = /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+\/[^/]+)\/(issues|pulls?)\/(\d+)\/?(?:#discussion_r(\d+)|#[\w-]*)?$/i
  const match = address.exec(url)
  if (!match || !sameName(match[1]!, repository)) return undefined
  return { number: Number(match[3]), pr: match[2]!.toLowerCase() !== 'issues', ...match[4] ? { discussion: Number(match[4]) } : {} }
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
const author = (user: { login: string; type?: string }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.login }, human: isHumanLogin(user) && !sameName(user.login, agent) })
/** 为评论或评审构建触发器；没有正文的评论或正文为空的 `COMMENTED` 评审，其 text 为空。 */
export function commentTrigger(comment: GithubComment, ref: PullRef, kind: 'conversation' | 'inline' | 'review', agent: string): Trigger {
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const version = comment.updated_at ?? comment.submitted_at ?? ''
  const id = key('github-comment', comment.html_url ?? `github:${ref.number}`, String(comment.id), version)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: String(ref.number) }], ...author(comment.user, agent), at,
    text: commentText(comment, kind),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(ref.number, comment.html_url ?? undefined),
    ...(comment.html_url ?? ref.url ? { url: comment.html_url ?? ref.url } : {}),
    meta: { number: ref.number, isPr: ref.isPr, ...(ref.prAuthor ? { prAuthor: ref.prAuthor } : {}), commentId: comment.id, kind,
      ...comment.path ? { path: comment.path, line: comment.line ?? comment.original_line ?? null } : {},
      ...comment.in_reply_to_id ? { inReplyTo: comment.in_reply_to_id } : {} } }
}
/**
 * 为新打开的 Issue 的标题和正文构建触发器。
 * ID 与以前存储 Issue 正文时相同，因此已存储的正文不会被再次接入。
 */
export function issueTrigger(issue: Opened, agent: string): Trigger {
  const body = issue.body ?? ''
  return { id: key('github-issue', String(issue.number)), source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.number) }], ...author(issue.user, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: githubChannel(issue.number, issue.html_url), url: issue.html_url, meta: { number: issue.number, isPr: false, kind: 'issue' } }
}
/**
 * 为新打开的 PR 的标题和描述构建触发器。
 * GitHub 中 PR 与 Issue 共用同一编号序列且不会冲突，因此复用 `issueTrigger` 的 `github-issue` ID 格式。
 */
export function pullTrigger(pull: Opened, agent: string): Trigger {
  return { ...issueTrigger(pull, agent), meta: { number: pull.number, isPr: true, prAuthor: pull.user.login, kind: 'pull' } }
}
/** 为默认分支 CI 状态变化构建触发器；默认分支 CI 没有可回复的人，因此没有 `channel`。 */
export function branchCiTrigger(branch: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('github-ci', `branch:${branch}`, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `ci:${branch}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, url, meta: { ci: true, branch, sha, revision } }
}
export function ciTrigger(pr: { number: number; html_url: string; user: { login: string } }, revision: number, summary: string): Trigger {
  return { id: key('github-ci', String(pr.number), String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: String(pr.number) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: summary, channel: githubChannel(pr.number), url: pr.html_url,
    meta: { number: pr.number, isPr: true, prAuthor: pr.user.login, ci: true, revision } }
}
