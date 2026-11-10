/** GitHub 来源种类定义与通知、仓库轮询循环。 */
import { key, type Thread } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GithubSourceSchema, isGithubSource, webBaseOf, type ResolvedGithubSource } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { ciCounts, ciFact, ciFailures, ciSummary, githubThreadContext, pullChecks } from './github-read.ts'
import { branchCiTrigger, ciTrigger, commentTrigger, CommentSchema, githubAddress, githubPage, issueTrigger, IssueSchema, pullTrigger, SOURCE }
  from './github-trigger.ts'
import { githubLink, sendGithub } from './github-channel.ts'
import type { GithubComment, PullRef } from './github-trigger.ts'
import { observePull, pullsOf, readPull, type Pull } from './github-pull.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollFailure, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceAdapter, SourceKind } from './kind.ts'
import { forgePolicy, forgeScope } from './forge.ts'
import { threadKey } from './identity.ts'
import { z } from 'zod'
export { pollFailure } from './poll.ts'
/** 这条上下文的 GitHub 来源；记录尚未通过部署检查时抛出，提醒调用方先检查 `configured()`。 */
const account = (ctx: SourceContext): ResolvedGithubSource => {
  if (!isGithubSource(ctx.source)) throw new Error('The GitHub Source has no working CLI')
  return ctx.source
}

export { commentTrigger, type GithubComment } from './github-trigger.ts'
/** 智能体账号的通知；`subject.url` 是其 Issue 或 PR 的 API 地址。 */
const NotificationSchema = z.looseObject({
  repository: z.looseObject({ full_name: z.string() }), subject: z.looseObject({ url: z.string().nullish() }),
})

const GithubConfigSchema = GithubSourceSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false) }).strict()
export type GithubConfig = z.infer<typeof GithubConfigSchema>
const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments', ci: 'observeCi' } as const
export const githubKind: SourceKind<GithubConfig> = {
  kind: SOURCE,
  title: { zh: 'GitHub', en: 'GitHub' },
  description: { zh: '智能体的 GitHub 账号；接收仓库里发给它的通知、已订阅 Issue 与 PR 的讨论、CI 状态变化和 PR 合并关闭。', en: 'The agent\'s GitHub accounts; receives notifications to it in the repository, discussion on subscribed Issues and PRs, CI changes, and PR merge or close.' },
  schema: GithubConfigSchema,
  fields: [
    { key: 'instanceUrl', type: 'text', label: { zh: '实例地址', en: 'Instance URL' },
      hint: { zh: '留空使用 github.com；自建 GitHub Enterprise 填站点根地址，例如 https://github.example.com。', en: 'Leave empty for github.com; for a self-hosted GitHub Enterprise, enter the site root such as https://github.example.com.' } },
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。这个来源接收这个仓库的通知和讨论；保存时检查智能体账号能否推送到它，然后重启 dsh-superagent。', en: 'Written owner/name. This Source receives the repository\'s notifications and discussion; saving checks that the agent account can push to it, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitHub CLI', en: 'Agent GitHub CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GH_CONFIG_DIR 登录智能体账号的 gh 包装脚本。智能体以它登录的账号行事，执行器以 gh 调用它。保存时检查它登录的账号能否推送到仓库，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a gh wrapper signed in to the agent account through GH_CONFIG_DIR. The agent acts as the account it is signed in to, and the Executor calls it as gh. Saving checks that this account can push to the repository, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' }, hint: { zh: 'GitHub 要求更长间隔时以 GitHub 为准。', en: 'A longer interval requested by GitHub wins.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选。', en: 'New pull requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，Issue 和 PR 上没有 @ 智能体的评论和代码评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and review comments on Issues and PRs that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 CI', en: 'Receive the default branch\'s CI' },
      hint: { zh: '打开后，默认分支的 CI 失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'Failures of the default branch\'s CI, and its recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } }],
  // 来源在它完整接收的仓库范围内观察什么；其他位置只观察针对智能体的内容。
  scope: ({ meta }, config) => forgeScope(meta, config, OBSERVED),
  health: ['github'],
  channel: { send: sendGithub, link: githubLink },
  threadContext: githubThreadContext,
  // `#12`、`12` 或这条记录实例上 Issue/PR 的页面都指向该记录的线程。
  find: (instance, query) => {
    const config = GithubConfigSchema.parse(instance.config)
    const exact = /^#?(\d+)$/.exec(query.trim())
    const number = exact?.[1] ?? String(githubAddress(query, config.repository, config.instanceUrl)?.number ?? '')
    return { threads: number ? [threadKey(instance.id, number)] : [], terms: [] }
  },
  policy: forgePolicy({
    config: GithubConfigSchema,
    observed: OBSERVED,
    allowed: { zh: '能发起工作的 GitHub 账号', en: 'GitHub accounts that may originate work' },
    allowedColumn: { zh: '账号', en: 'Account' },
    accountPattern: /^[A-Za-z0-9-]+$/,
    accountInput: '[A-Za-z0-9\\-]+',
    bots: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
    botsHint: { zh: '名单里的机器人账号（例如 dependabot[bot]）的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收仓库里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list, such as dependabot[bot], becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the repository on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
    botColumn: { zh: '账号', en: 'Account' },
    botPattern: /^[A-Za-z0-9-]+(\[bot\])?$/,
    botInput: '[A-Za-z0-9\\-]+(\\[bot\\])?',
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    issues: { zh: '新 Issue', en: 'New Issues' },
    pulls: { zh: '新 PR', en: 'New pull requests' },
    comments: { zh: '评论', en: 'Comments' },
    ci: { key: 'observeCi', label: { zh: '默认分支的 CI', en: 'Default branch CI' },
      received: { zh: '接收', en: 'Received' }, notReceived: { zh: '不接收', en: 'Not received' } },
  }),
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '这个来源监听的仓库，owner/name。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The repository this Source watches, as owner/name. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITHUB_ACCOUNT', description: { zh: '智能体的 GitHub 账号；gh 以它登录，除自动合并外的 GitHub 操作都用 gh，不用其他账号或凭据', en: 'The agent\'s GitHub account. gh is signed in to it; use gh for every GitHub operation except auto-merge, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从 GitHub 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on GitHub' } },
      { key: 'DSH_SUPERAGENT_GITHUB_PR_HEAD', description: { zh: '接下工单的 PR 的 head 引用 refs/pull/<编号>/head；不是 PR 时为空', en: 'Head ref refs/pull/<number>/head of the PR that started the ticket; empty when it was not a PR' } },
    ],
    values: ({ source, trigger }) => {
      const number = source?.kind === 'github' && trigger?.threads[0]?.source === source.id ? Number(trigger.meta.number) || 0 : 0
      return { DSH_SUPERAGENT_GITHUB_REPOSITORY: source?.kind === 'github' ? source.repository : '', DSH_SUPERAGENT_GITHUB_ACCOUNT: source?.kind === 'github' ? source.login : '',
        DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: source?.kind === 'github' ? source.noreply : '', DSH_SUPERAGENT_GITHUB_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITHUB_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '' }
    },
  },
  facts: (source): Record<string, Localized | string> => source?.kind === 'github' ? {
    cli: { zh: `当前账号 @${source.login}`, en: `Current account @${source.login}` },
  } : {},
}
export const githubAdapter: SourceAdapter<GithubConfig> = {
  kind: githubKind,
  async watch(host, id, signal) {
    const ctx = sourceContext(host, githubKind, id)
    // 未处理的 Promise 拒绝会终止 DSH 进程，因此逃出轮询循环的失败改为报告为来源健康状态。
    try { await watch(ctx, signal) }
    catch (error) { ctx.report('github', { state: 'error', detail: String(error) }) }
  },
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // 设置解析出账号后会重启 dsh-superagent；在此之前不轮询任何内容。
  if (!ctx.configured()) { ctx.report('github', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GithubConfig>()
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('github', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('github', failed)
    }
    await pause(Math.max(interval, ctx.config<GithubConfig>()?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined
  pulls: Map<number, Promise<Pull>>; read: Set<number>; failures: string[]; dropped: number[]; abandoned: number[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, pulls: new Map(), read: new Set(),
  failures: [], dropped: [], abandoned: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config()
export interface Retry { since: string; pr: boolean; failedAt?: string; attempts?: number }
const RETRY_WINDOW_MS = 24 * 3600_000
/** GitHub 返回 HTTP 410（Gone）时为 true；HTTP 404 会重试，因为它可能表示私有仓库的访问权限被撤销。 */
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 410
/** 在线程和本轮中记录一次失败读取；已删除（410）或已放弃（24 小时以上）的线程不会让本轮失败。 */
function failed(ctx: SourceContext, round: Round, number: number, error: unknown, abandoned = false): void {
  if (deleted(error)) round.dropped.push(number)
  else if (abandoned) round.abandoned.push(number)
  else round.failures.push(`#${number}: ${String(error)}`)
  ctx.threads.patch(threadKey(ctx.id, String(number)), { pollError: String(error) })
}
function included(raw: string): { headers: string; body: string } {
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  return { headers: raw.slice(0, split), body: raw.slice(split).trim() }
}
const ListedSchema = CommentSchema.extend({ issue_url: z.string().nullish(), pull_request_url: z.string().nullish() })
/** 仓库级事件流；GitHub 的 `/issues` 端点包含 PR，`/issues/comments` 覆盖 Issue 和 PR 的会话评论（不含行内代码评论）。 */
const STREAMS = [
  { id: 'issues', observed: (config: GithubConfig) => config.observeIssues || config.observePulls, path: 'issues?state=all' },
  { id: 'comments', observed: (config: GithubConfig) => config.observeComments, path: 'issues/comments?' },
  { id: 'review-comments', observed: (config: GithubConfig) => config.observeComments, path: 'pulls/comments?' },
] as const
/** 轮询仓库级事件流（新 Issue/PR、评论、默认分支 CI）；每个流从打开开关时开始读取，关闭时重置，并独立失败。 */
async function pollRepository(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GithubConfig>()
  if (!config) return
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    if (!stream.observed(config)) { ctx.state.set(KV.github.stream(ctx.id, stream.id), undefined); continue }
    try { await readStream(ctx, round, stream.id, stream.path, config) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream.id}: ${String(error)}`) }
  }
  // 关闭 CI 观察时清除失败基线，但保留修订号计数器，以便后续触发器拥有唯一 ID。
  if (!config.observeCi) {
    const seen = ctx.state.get(KV.github.branchCi(ctx.id))
    ctx.state.set(KV.github.branchCi(ctx.id), seen && { revision: seen.revision })
    return
  }
  try { await pollBranchCi(ctx, round) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`default branch CI: ${String(error)}`) }
}
/**
 * 从游标开始轮询一个仓库级事件流（最早的在前），并把游标推进到最新条目之前五秒（`cursorAt`），
 * 依靠触发器 ID 去重，使重复消息成为空操作。游标保持不变时（包括被限制到每小时时间窗时），
 * 发送上一页的 ETag 会让未变化的列表返回 HTTP 304，不消耗速率限制。早于对应类型开关打开时间
 * 或超出时间窗的条目会被忽略。
 */
async function readStream(ctx: SourceContext, round: Round, id: string, path: string, config: GithubConfig): Promise<void> {
  const name = KV.github.stream(ctx.id, id)
  const stored = ctx.state.get(name)
  const kinds = id === 'issues' ? [...config.observeIssues ? ['issues'] : [], ...config.observePulls ? ['pulls'] : []] : ['comments']
  const before = typeof stored?.started === 'object' ? stored.started : {}
  const started: Record<string, string> = Object.fromEntries(kinds.map(kind => [kind, before[kind] ?? round.started]))
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString()
  const conditional = stored?.etag && stored.since === since ? ['-H', `If-None-Match: ${stored.etag}`] : []
  let raw: string
  const listed = `${path}&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`
  try { raw = await ctx.commands.withSignal(round.signal).api(listed, '--include', ...conditional) }
  catch (error) {
    if (error instanceof CliError && error.code === 304) return
    throw error
  }
  const { headers, body } = included(raw)
  const items = validItems(ListedSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const { login } = account(ctx)
  const fresh = (at: string | null | undefined, kind: string) =>
    kind in started && Date.parse(at ?? '') >= Math.max(Date.parse(started[kind]!), horizon)
  for (const item of items) {
    // 中途停止会在推进游标前中止，以便未读取的条目被重试。
    if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
    if (sameName(item.user.login, login)) continue
    if (id === 'issues') {
      const issue = IssueSchema.safeParse(item)
      const pr = issue.success && !!issue.data.pull_request
      if (!issue.success || !fresh(issue.data.created_at, pr ? 'pulls' : 'issues')) continue
      await ctx.receive(pr ? pullTrigger(ctx.id, issue.data, login) : issueTrigger(ctx.id, issue.data, login))
      nameThread(ctx, issue.data.number, issue.data.title)
      continue
    }
    const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec((id === 'comments' ? item.issue_url : item.pull_request_url) ?? '')?.[1])
    if (!number || !fresh(item.updated_at ?? item.created_at, 'comments')) continue
    const isPr = id === 'review-comments' || /\/pull\//.test(item.html_url ?? '')
    const ref = { number, isPr, ...item.html_url ? { url: item.html_url } : {} }
    const trigger = commentTrigger(ctx.id, item, ref, id === 'comments' ? 'conversation' : 'inline', login)
    if (trigger.text) await ctx.receive(trigger)
  }
  const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? '')).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  const next = Date.parse(moved) > Date.parse(since) ? moved : since
  const etag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim()
  // ETag 属于本次请求，只有游标保持不变时下一轮才会重复该请求。
  ctx.state.set(name, { since: next, started, ...etag && next === since ? { etag } : {} })
}
/** 轮询默认分支的 CI 检查，仅在初始基线之后失败检查集合发生变化时发出触发器。 */
async function pollBranchCi(ctx: SourceContext, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const { default_branch: branch } = await commands.api(z.looseObject({ default_branch: z.string() }), '')
  const head = await commands.api(z.looseObject({ sha: z.string() }), `commits/${encodeURIComponent(branch)}`)
  const snapshot = await pullChecks(commands, head.sha, round.tally)
  const previous = ctx.state.get(KV.github.branchCi(ctx.id))
  // 打开开关或重命名默认分支后的首次观察会建立基线。
  const known = previous?.branch === branch ? previous.failures : undefined
  const failures = ciFailures(snapshot)
  const counts = ciCounts(snapshot)
  // 检查仍在运行时保留之前的失败，以便只在所有检查通过后报告恢复。
  const now = failures.length || !counts.running ? failures : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const summary = ciSummary(snapshot, branch, `github/commits/${head.sha}/checks`)
    const { repository, instanceUrl } = account(ctx)
    const url = `${webBaseOf(instanceUrl, 'https://github.com').replace(/\/+$/, '')}/${repository}/commit/${head.sha}`
    await ctx.receive(branchCiTrigger(ctx.id, branch, head.sha, revision, summary, url))
    ctx.threads.describe(threadKey(ctx.id, `ci:${branch}`), { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } })
  }
  ctx.state.set(KV.github.branchCi(ctx.id), { branch, failures: now, revision })
}
/**
 * 一次轮询：先通知，再观察仓库事件流，然后处理未关闭工单的 PR 及其 CI，最后处理已订阅线程。
 * 每个步骤以及每个 Issue、PR 或线程都独立失败，因此所有步骤都会执行完，本轮才失败。
 * 其他读取失败（包括 404）会让本轮失败并逼近错误阈值，而已删除（410）或已放弃
 * （24 小时以上）的线程只记录在线程和健康详情中。
 * @returns GitHub 请求的轮询间隔，单位为秒。
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const notified = await pollNotifications(ctx, round).then(value => ({ value }), (error: unknown) => ({ error }))
  await pollRepository(ctx, round)
  await pollTicketPulls(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if ('error' in notified) throw notified.error
  const { count, interval } = notified.value
  if (signal?.aborted) return interval
  if (round.failures.length) throw new Error(`${round.failures.length} GitHub reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const named = (numbers: number[]) => [...new Set(numbers)].sort((a, b) => a - b).map(number => `#${number}`).join(', ')
  const dropped = (round.dropped.length ? `; deleted on GitHub: ${named(round.dropped)}` : '')
    + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report('github', { state: 'ready', detail: `${count} notifications; next poll ≥ ${interval}s${dropped}`, at: round.started })
  return interval
}
/** 读取游标以来的通知及其指向的每个 Issue 或 PR，并与失败读取的重试映射一起原子推进游标；已删除（410）的 Issue 在记录错误后被丢弃。 */
async function pollNotifications(ctx: SourceContext, round: Round): Promise<{ count: number; interval: number }> {
  const { state } = ctx
  const commands = ctx.commands.withSignal(round.signal)
  const since = state.get(KV.github.since(ctx.id)) ?? round.started
  if (state.get(KV.github.since(ctx.id)) === undefined) state.set(KV.github.since(ctx.id), since)
  const { repository, instanceUrl } = account(ctx)
  const path = `notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`
  const raw = await commands.api(path, '--include')
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  const headers = raw.slice(0, split)
  const body = raw.slice(split).trim()
  const asked = Number(/x-poll-interval:\s*(\d+)/i.exec(headers)?.[1] ?? 60)
  const interval = Math.max(60, Number.isFinite(asked) ? asked : 60)
  const notifications = /rel="next"/.test(headers)
    ? await commands.pages(NotificationSchema, path, round.tally)
    : validItems(NotificationSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const retries = { ...state.get(KV.github.retries(ctx.id)) }
  // 上一轮失败的条目先运行，随后是按时间顺序新通知的条目；每项只读取一次。
  const items = new Map(Object.entries(retries).map(([number, retry]) => [Number(number), retry]))
  for (const notification of notifications.reverse()) {
    if (!sameName(notification.repository.full_name, repository)) continue
    const address = githubAddress(notification.subject.url ?? '', repository, instanceUrl)
    if (!address || address.discussion || items.has(address.number)) continue
    const { number, pr } = address
    items.set(number, { since: [state.get(KV.github.cursor(ctx.id, number)) ?? since, since].sort().at(-1)!, pr })
  }
  for (const [number, item] of items) {
    if (stopped(ctx, round)) return { count: notifications.length, interval }
    round.read.add(number)
    try {
      await readNotified(ctx, round, number, item)
      delete retries[number]
    } catch (error) {
      if (stopped(ctx, round)) return { count: notifications.length, interval }
      const retry = { ...item, failedAt: item.failedAt ?? round.started, attempts: (item.attempts ?? 0) + 1 }
      // 失败持续 24 小时后放弃通知重试，避免永久不可读的线程让来源健康一直处于错误；游标保留，以便之后的通知或线程轮询仍能读取遗漏内容。
      const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
      failed(ctx, round, number, error, abandoned)
      if (!deleted(error) && !abandoned) { retries[number] = retry; continue }
      delete retries[number]
    }
  }
  ctx.atomic(() => { state.set(KV.github.since(ctx.id), cursorAt(round.started)); state.set(KV.github.retries(ctx.id), retries) })
  return { count: notifications.length, interval }
}
async function readNotified(ctx: SourceContext, round: Round, number: number, item: Retry): Promise<void> {
  const { since } = item
  let isPr = item.pr
  if (!isPr) {
    const issue = await ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
    // `issues/<n>` 也会返回设置了 `pull_request` 的 PR；在下面的 PR 分支中处理它们。
    isPr = !!issue.pull_request
    if (!isPr) {
      // 游标以来由他人而非智能体打开的 Issue 会带上正文，使正文中的 @ 能进入准入判断。
      // 之后通过编辑正文添加的 @ 不会被读取：只有作者才能作为正文的行为者。
      const { login } = account(ctx)
      const opened = Date.parse(issue.created_at) >= Date.parse(since) && !sameName(issue.user.login, login)
      if (opened) await ctx.receive(issueTrigger(ctx.id, issue, login))
      await intakeComments(ctx, { number, isPr: false, url: issue.html_url }, since, round)
      nameThread(ctx, number, issue.title)
    }
  }
  if (isPr) {
    const pr = await pull(ctx, round, number)
    // 为游标以来打开的 PR 发出 PR 描述触发器；其 ID 与仓库 PR 流产生的一致。
    const { login } = account(ctx)
    if (pr.created_at && Date.parse(pr.created_at) >= Date.parse(since) && !sameName(pr.user.login, login)) {
      const opened = { number, title: pr.title ?? '', body: pr.body, user: pr.user, created_at: pr.created_at, html_url: pr.html_url }
      await ctx.receive(pullTrigger(ctx.id, opened, login))
    }
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since, round)
    if (pr.title) nameThread(ctx, number, pr.title)
  }
  ctx.state.set(KV.github.cursor(ctx.id, number), cursorAt(round.started))
  ctx.threads.patch(threadKey(ctx.id, String(number)), { pollError: undefined })
}
/** 每轮轮询最多读取并观察一个 PR 一次。 */
function pull(ctx: SourceContext, round: Round, number: number): Promise<Pull> {
  let read = round.pulls.get(number)
  if (!read) {
    read = readPull(ctx, number, round.signal).then(async pr => { await observePull(ctx, pr); return pr })
    round.pulls.set(number, read)
  }
  return read
}
async function intakeComments(ctx: SourceContext, ref: PullRef, since: string, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const { login } = account(ctx)
  const kinds = ref.isPr ? ['conversation', 'inline', 'review'] as const : ['conversation'] as const
  for (const kind of kinds) {
    const suffix = `&since=${encodeURIComponent(since)}`
    const path = kind === 'conversation' ? `issues/${ref.number}/comments?per_page=100${suffix}` : kind === 'inline' ? `pulls/${ref.number}/comments?per_page=100${suffix}` : `pulls/${ref.number}/reviews?per_page=100`
    const comments = await commands.pages(CommentSchema, path, round.tally)
    for (const comment of comments) {
      // 读取中途停止会抛出，以便线程游标保持原处。
      if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
      const timestamp = Date.parse(comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
      if (sameName(comment.user.login, login)) continue
      // 没有正文的评审决定仍会进入工单：worker 可能正在等待该批准。
      const trigger = commentTrigger(ctx.id, comment, ref, kind, login)
      if (trigger.text) await ctx.receive(trigger)
    }
  }
}
export async function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const numbers = [...new Set(ctx.tickets.open().flatMap(ticket => pullsOf(ticket, true, ctx.id)))]
  for (const number of numbers) {
    if (stopped(ctx, round)) return
    try {
      const pr = await pull(ctx, round, number)
      if (pr.state !== 'closed' && !pr.merged) await pollChecks(ctx, round, number, pr)
    } catch (error) { if (!stopped(ctx, round)) failed(ctx, round, number, error) }
  }
}
/** 轮询 PR 的 CI 检查；只有首次基线观察之后的变化才会成为触发器。 */
async function pollChecks(ctx: SourceContext, round: Round, number: number, pr: Pull): Promise<void> {
  const snapshot = await pullChecks(ctx.commands.withSignal(round.signal), pr.head.sha, round.tally)
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.github.ci(ctx.id, number))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) await ctx.receive(ciTrigger(ctx.id, pr, revision, ciSummary(snapshot, `PR #${number}`, `github/pulls/${number}/checks`)))
  ctx.state.set(KV.github.ci(ctx.id, number), { fingerprint, revision })
  ctx.threads.describe(threadKey(ctx.id, String(number)), { facts: { ci: ciFact(ciCounts(snapshot)) } })
}
function nameThread(ctx: SourceContext, number: number, title: string): void {
  ctx.threads.patch(threadKey(ctx.id, String(number)), { title })
  ctx.threads.describe(threadKey(ctx.id, String(number)), { label: `#${number} ${title}`, facts: { number: { value: `#${number}` } } })
}
/** 轮询尚未在本轮读取的已订阅 Issue 和 PR 线程；已删除（410）的 Issue 在时间窗内仍会轮询（消耗一次读取），且不会让本轮失败。 */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, ctx.id, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) round.dropped.push(Number(thread.ref.id)); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(Number(thread.ref.id)))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // 默认分支的 CI 线程没有可读取的 Issue 或 PR；它的 CI 以触发器形式到达。
  if (thread.ref.id.startsWith('ci:')) return
  const number = Number(thread.ref.id)
  if (!number) throw new Error('Subscribed thread has no GitHub issue or PR number')
  round.read.add(number)
  if (typeof thread.meta.isPr !== 'boolean' || typeof thread.meta.title !== 'string') {
    const issue = await ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
    ctx.threads.patch(thread.key, { number, isPr: !!issue.pull_request, url: issue.html_url })
    if (issue.title) nameThread(ctx, number, issue.title)
    thread = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = KV.github.cursor(ctx.id, number)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (thread.meta.isPr === true) {
    const pr = await pull(ctx, round, number)
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since, round)
  } else await intakeComments(ctx, { number, isPr: false }, since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
