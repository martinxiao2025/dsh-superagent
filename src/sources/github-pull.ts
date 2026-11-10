/** PR 绑定、生命周期观察和终态 IM 通知辅助函数。 */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { ResolvedGithubSource, ResolvedSource } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { githubPage, UserSchema } from './github-trigger.ts'
import { threadKey } from './identity.ts'
/** 这条上下文的 GitHub 来源；记录尚未通过部署检查时抛出。 */
const account = (ctx: SourceContext): ResolvedGithubSource => {
  if (ctx.source?.kind !== 'github') throw new Error('The GitHub Source has no working CLI')
  return ctx.source
}

const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
/** 从线程键 `<来源记录>:<编号>` 中取 PR 编号；`record` 给定时要求线程属于该记录。 */
const pullNumber = (thread: string, record?: string): number | undefined => {
  const [source, ...rest] = thread.split(':')
  if (record !== undefined && source !== record) return undefined
  const local = rest.join(':')
  return /^\d+$/.test(local) ? Number(local) : undefined
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false, record?: string): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread, record) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)
/** PR 由智能体账号从配置仓库中的分支（而非 fork）打开时为 true。 */
export const agentPull = (pr: { user: { login: string }; head?: { repo?: { full_name: string } | null } | null },
  account: Pick<ResolvedGithubSource, 'login' | 'repository'>): boolean =>
  sameName(pr.user.login, account.login) && sameName(pr.head?.repo?.full_name ?? '', account.repository)
/** 分支属于该工单时为 true：其最后一段路径是工单的短名，例如 `agent/<name>`。 */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * 当 PR 是工单的初始 PR，或是由智能体在该工单分支上创建的 PR 时，校验并把未关闭的 PR 绑定到工单；
 * 同时确保一个 PR 最多绑定一个未关闭的工单。
 * 绑定被拒绝时返回错误消息；PR 已绑定或 PR 未关闭（不算错误）时返回 undefined。
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const origin = ctx.triggers.get(ticket.origin.triggerId)
  const started = origin?.source === ctx.id && origin.meta.isPr === true && origin.meta.number === pr.number
  const source = account(ctx)
  const opened = agentPull(pr, source) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const { login } = source
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true, ctx.id).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === threadKey(ctx.id, String(pr.number)))
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened)
  return undefined
}
/**
 * 把轮询到的 PR 的打开/已合并/已关闭状态及自动合并事实与已绑定或分支匹配的工单对齐。
 * 未关闭的智能体 PR 会自动绑定到其分支上唯一的未关闭工单，除非该工单已经跟随另一个未关闭 PR
 * （只有执行器的报告会改变这一点）。
 * @returns PR 是否已结束。
 */
export async function observePull(ctx: SourceContext, pr: Pull): Promise<boolean> {
  const ended = pr.state === 'closed' || !!pr.merged
  if (ended) closePull(ctx, pr)
  else {
    const candidates = agentPull(pr, account(ctx)) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // 工单跟随到关闭、之后又重新打开的 PR 会被再次跟随。
    const reopened = ticket?.follows?.some(item => item.thread === threadKey(ctx.id, String(pr.number)) && item.closed)
    if (ticket && (reopened || pullsOf(ticket, true, ctx.id).every(number => number === pr.number))) claimPull(ctx, ticket.id, pr)
  }
  ctx.threads.describe(threadKey(ctx.id, String(pr.number)), { facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: ctx.id, id: String(pr.number) }, own)
    ctx.threads.patch(threadKey(ctx.id, String(pr.number)), { number: pr.number, isPr: true, url: pr.html_url, prAuthor: pr.user.login })
  })
}
/**
 * 向跟随该 PR 的未关闭工单报告一次已合并或已关闭，其结束由核心决定。
 * 工单对 PR 的订阅会保留，以便之后那里的人类评论可以恢复工单。
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true, ctx.id).includes(pr.number))) return
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: ctx.id, id: String(pr.number) }, pr.merged ? 'merged' : 'closed', at)
}
/**
 * 工单随其 PR 结束时的 IM 会话幂等出站通知（选择它打开的最后关闭的 PR，否则选择它跟随的最后一个）。
 * 通知语言跟随工单的来源请求：包含汉字且不含假名时为中文，否则为英文。
 */
export function pullEndNotices(ticket: Ticket, request: string, sources: Readonly<Record<string, ResolvedSource>>): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  // 线程键的前缀就是来源记录 ID（`threadKey` 的格式）。
  const resolved = sources[follow.thread.split(':')[0] ?? '']
  // 来源记录已被删除时没有仓库可拼链接，跳过通知而不是发出坏链接。
  if (resolved?.kind !== 'github') return []
  const number = pullNumber(follow.thread)!
  const url = githubPage(resolved.instanceUrl, resolved.repository, number, true)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  // GitHub 时间线和关联 Issue 已经显示合并或关闭，因此跳过 GitHub 频道。
  return ticket.channels.filter(channel => sources[channel.source]?.kind !== 'github').map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
