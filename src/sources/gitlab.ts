/** GitLab 源定义与 Issue/MR、note 轮询循环。 */
import { z } from 'zod'
import type { Thread } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GitlabSourceSchema, isGitlabSource, type ResolvedGitlabSource } from '../deployment.ts'
import type { Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { cursorAt, pause, pollFailure, pollThreads as pollEach } from './poll.ts'
import { forgePolicy, forgeScope } from './forge.ts'
import type { Localized, SourceAdapter, SourceKind } from './kind.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { gitlabThread, issueTrigger, ItemSchema, NoteSchema, noteTrigger, pullTrigger, SOURCE, type GitlabRef }
  from './gitlab-trigger.ts'

const account = (ctx: SourceContext): ResolvedGitlabSource => {
  if (!isGitlabSource(ctx.source)) throw new Error('The GitLab Source has no working CLI')
  return ctx.source
}
/** GitLab 源配置；`project` 为空表示尚未启用，`cli` 默认使用 PATH 上的 glab。 */
export const GitlabConfigSchema = GitlabSourceSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments' } as const
/** 每个轮询轮次最多读取的条目数；GitLab notes 需要逐条读取，限制调用量，剩余条目由下一次轮询继续。 */
const MAX_ITEMS_PER_STREAM = 20
const STREAMS = ['issues', 'merge_requests'] as const
type Stream = typeof STREAMS[number]
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收所选项目里的新 Issue、新 Merge Request，以及 @ 智能体或打开开关后的 note。', en: 'The agent\'s GitLab account; receives new Issues and merge requests in the selected project, and notes that mention the agent or arrive with the switch on.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'instanceUrl', type: 'text', label: { zh: '实例地址', en: 'Instance URL' },
      hint: { zh: '留空使用 gitlab.com；自建 GitLab 填站点根地址，例如 https://gitlab.example.com。', en: 'Leave empty for gitlab.com; for a self-hosted GitLab, enter the site root such as https://gitlab.example.com.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的 GitLab 项目', en: 'GitLab project' },
      hint: { zh: '写作 group/project，支持多级命名空间。保存时检查 glab 登录的账号能否读取项目并有 Developer 及以上权限，然后重启 dsh-superagent。', en: 'Written group/project; multi-level namespaces are supported. Saving checks that the account signed in to glab can read the project with Developer access or higher, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，默认 glab。可用 GITLAB_TOKEN 或 glab auth login 登录智能体账号；智能体以它登录的账号行事。', en: 'A command name or absolute path, glab by default. Sign it in to the agent account with GITLAB_TOKEN or glab auth login; the agent acts as that account.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: 'GitLab 没有返回推荐间隔的响应头，因此按这里配置的间隔轮询。', en: 'GitLab returns no recommended interval, so the configured interval is used.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收项目里的新 MR', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Merge Request 也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' },
      hint: { zh: '打开后，Issue 和 MR 上没有 @ 智能体的 note 也会收到，由策略的接收表决定是否成为候选。', en: 'Notes on Issues and merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
  ],
  scope: ({ meta }, config) => forgeScope(meta, config, OBSERVED),
  health: ['gitlab'],
  channel: { allowed: address => address.kind === 'issue' || address.kind === 'mr', send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // `#12`、`!12` 或 GitLab 网页 URL 分别指向 Issue 与 MR；两者编号独立。
  find: (_instance, query) => {
    const text = query.trim()
    const issue = (/^#(\d+)$/.exec(text) ?? /^(\d+)$/.exec(text) ?? /\/-\/issues\/(\d+)/.exec(text))?.[1]
    const mr = (/^!(\d+)$/.exec(text) ?? /\/-\/merge_requests\/(\d+)/.exec(text))?.[1]
    return { threads: [...issue ? [`${SOURCE}:issue:${issue}`] : [], ...mr ? [`${SOURCE}:mr:${mr}`] : []], terms: [] }
  },
  policy: forgePolicy({
    config: GitlabConfigSchema,
    observed: OBSERVED,
    allowed: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
    allowedColumn: { zh: '账号', en: 'Account' },
    accountPattern: /^[A-Za-z0-9_.-]+$/,
    accountInput: '[A-Za-z0-9_.\\-]+',
    bots: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
    botsHint: { zh: '名单里的机器人账号（例如 project_123_bot）的 note 在来源收到时成为推断的候选，交给评估：note @ 了智能体，或者打开了“接收项目里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的 note 不接收。', en: 'A note of a bot account on this list, such as project_123_bot, becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the project on. Such a note never makes an explicit request or stops a ticket; other bots\' notes are not admitted.' },
    botColumn: { zh: '账号', en: 'Account' },
    botPattern: /^[A-Za-z0-9_.-]+$/,
    botInput: '[A-Za-z0-9_.\\-]+',
    explicit: { zh: '名单里的账号在 Issue、MR 或 note 里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, a merge request, or a note.' },
    issues: { zh: '新 Issue', en: 'New Issues' },
    pulls: { zh: '新 MR', en: 'New merge requests' },
    comments: { zh: '评论', en: 'Comments' },
  }),
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的 GitLab 项目，group/project。', en: 'The GitLab project this Source watches, as group/project.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录。', en: 'The agent\'s GitLab account; glab is signed in to it.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_NUMBER', description: { zh: '接下工单的 Issue 或 MR 编号；工单不是从 GitLab 来的时为空。', en: 'IID of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_KIND', description: { zh: '接下工单的是 issue 还是 merge_request；不是 GitLab 工单时为空。', en: 'Whether the ticket started from an issue or a merge_request; empty when it did not start on GitLab.' } },
    ],
    values: ({ source, trigger }) => {
      const mine = trigger?.threads[0]?.source === SOURCE
      const number = mine ? Number(trigger?.meta.number) || 0 : 0
      return { DSH_SUPERAGENT_GITLAB_PROJECT: source?.kind === 'gitlab' ? source.project : '', DSH_SUPERAGENT_GITLAB_ACCOUNT: source?.kind === 'gitlab' ? source.login : '',
        DSH_SUPERAGENT_GITLAB_NUMBER: number ? String(number) : '', DSH_SUPERAGENT_GITLAB_KIND: number ? trigger?.meta.kind === 'pull' ? 'merge_request' : 'issue' : '' }
    },
  },
  facts: (source): Record<string, Localized | string> => source?.kind === 'gitlab' ? {
    cli: { zh: `当前账号 @${source.login}`, en: `Current account @${source.login}` },
  } : {},
}
export const gitlabAdapter: SourceAdapter<GitlabConfig> = {
  kind: gitlabKind,
  async watch(host, id, signal) {
    const ctx = sourceContext(host, gitlabKind, id)
    try { await watch(ctx, signal) }
    catch (error) { ctx.report('gitlab', { state: 'error', detail: String(error) }) }
  },
}
export async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // setup 未完成时先不轮询；setup 成功后重启 dsh-superagent。
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  // 可选来源的账号检查失败时 setup 只禁用 GitLab，这里保持暂停而不反复报错。
  if (ctx.problem) { ctx.report('gitlab', { state: 'paused', detail: ctx.problem.detail }); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>()
    try {
      if (config?.project) { await pollRound(ctx, signal); interval = config.pollSeconds }
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>()?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round {
  started: string
  signal?: AbortSignal | undefined
  read: Set<string>
  failures: string[]
  tally: Tally
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, read: new Set(), failures: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config()
const sectionOf = (stream: Stream): string => stream === 'issues' ? 'issues' : 'merge_requests'
const prefix = (isPr: boolean): string => isPr ? '!' : '#'
/**
 * 读取一个流中自游标以来更新过的条目：新 Issue/MR 才产生描述 Trigger，已有条目只检查新 note。
 * 首次轮询只写游标，不补发历史；每个流独立失败，游标按最后处理的条目推进。
 */
async function pollStream(ctx: SourceContext, round: Round, stream: Stream, config: GitlabConfig): Promise<number> {
  const state = KV.gitlab.cursor(stream)
  const stored = ctx.state.get(state)
  if (!stored) { ctx.state.set(state, cursorAt(round.started)); return 0 }
  const since = stored
  const isPr = stream === 'merge_requests'
  const commands = ctx.commands.withSignal(round.signal)
  const encoded = encodeURIComponent(config.project)
  const path = `projects/${encoded}/${stream}?order_by=updated_at&sort=asc&state=all&updated_after=${encodeURIComponent(since)}`
  const items = await commands.gitlabPages(ItemSchema, path, round.tally)
  const page = items.slice(0, MAX_ITEMS_PER_STREAM)
  const { login } = account(ctx)
  let newest = Date.parse(since)
  for (const item of page) {
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    const ref: GitlabRef = { iid: item.iid, isPr, ...item.web_url ? { url: item.web_url } : {}, ...isPr ? { prAuthor: item.author.username } : {} }
    round.read.add(`gitlab:${gitlabThread(item.iid, isPr)}`)
    const created = Date.parse(item.created_at) >= Date.parse(since)
    if (created && !sameName(item.author.username, login)) {
      await ctx.receive(isPr ? pullTrigger(item, login) : issueTrigger(item, login))
      nameThread(ctx, item.iid, isPr, item.title, item.web_url ?? undefined)
    }
    // 新建的条目从创建时间起读评论；已有条目只读游标之后的，避免回放历史评论。
    await readNotes(ctx, round, ref, created ? item.created_at : since, config)
    const at = Date.parse(item.updated_at ?? item.created_at)
    if (Number.isFinite(at)) newest = Math.max(newest, at)
  }
  if (page.length) {
    const moved = cursorAt(new Date(newest).toISOString())
    ctx.state.set(state, Date.parse(moved) > Date.parse(since) ? moved : since)
  }
  return items.length
}
/** 读取一个 Issue/MR 上自 notes 游标以来的 note；系统 note、智能体自己的 note 和空 note 跳过。 */
async function readNotes(ctx: SourceContext, round: Round, ref: GitlabRef, defaultSince: string, config: GitlabConfig): Promise<void> {
  const thread = `gitlab:${gitlabThread(ref.iid, ref.isPr)}`
  const checkpoint = KV.gitlab.notes(thread)
  const since = ctx.state.get(checkpoint) ?? defaultSince
  const section = sectionOf(ref.isPr ? 'merge_requests' : 'issues')
  const project = account(ctx)
  if (!project) throw new Error('The GitLab Source has no working CLI')
  const encoded = encodeURIComponent(project.project)
  const notes = await ctx.commands.withSignal(round.signal)
    .gitlabPages(NoteSchema, `projects/${encoded}/${section}/${ref.iid}/notes?sort=asc&order_by=created_at`, round.tally)
  const { login } = project
  for (const note of notes) {
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    if (note.system || sameName(note.author.username, login)) continue
    if (Date.parse(note.created_at ?? '') < Date.parse(since)) continue
    const trigger = noteTrigger(note, ref, login)
    if (!trigger.text) continue
    // 评论只有在 @ 智能体或打开了“接收项目里的评论”时才进入来源，与 GitHub 的通知语义一致。
    if (trigger.addressed || config.observeComments) await ctx.receive(trigger)
  }
  ctx.state.set(checkpoint, cursorAt(round.started))
}
/** 一轮轮询：issues 与 merge_requests 两个流，然后补齐本轮未覆盖的已订阅 Thread。 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<{ issues: number; mrs: number }> {
  const round = newRound(signal)
  const config = ctx.config<GitlabConfig>()
  if (!config?.project) { ctx.report('gitlab', health('paused', 'sourceOff')); return { issues: 0, mrs: 0 } }
  const counts = { issues: 0, mrs: 0 }
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) break
    try {
      const listed = await pollStream(ctx, round, stream, config)
      if (stream === 'issues') counts.issues = listed; else counts.mrs = listed
    } catch (error) { if (!stopped(ctx, round)) round.failures.push(`${stream}: ${String(error)}`) }
  }
  await pollThreads(ctx, signal, round, config)
  if (signal?.aborted) return counts
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  ctx.report('gitlab', { state: 'ready', detail: `${counts.issues} issues, ${counts.mrs} merge requests; next poll ≥ ${config.pollSeconds}s${skipped}`, at: round.started })
  return counts
}
/** 已订阅 Thread 的 note 轮询；本轮流中已经读过的 Thread 跳过，避免重复调用。 */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal), config = ctx.config<GitlabConfig>()): Promise<void> {
  if (!config?.project) return
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    const match = /^(issue|mr):([1-9]\d*)$/.exec(thread.ref.id)
    if (!match) throw new Error('Subscribed thread has no GitLab Issue or merge request IID')
    const isPr = match[1] === 'mr'
    const iid = Number(match[2])
    round.read.add(thread.key)
    let current = thread
    if (typeof thread.meta.isPr !== 'boolean' || typeof thread.meta.title !== 'string') {
      const project = account(ctx)
      if (!project) throw new Error('The GitLab Source has no working CLI')
      const item = await ctx.commands.withSignal(round.signal)
        .gitlabApi(ItemSchema, `${isPr ? 'merge_requests' : 'issues'}/${iid}`)
      current = ctx.threads.get(thread.key) ?? thread
      nameThread(ctx, iid, isPr, item.title, item.web_url ?? undefined)
    }
    const ref: GitlabRef = { iid, isPr, url: typeof current.meta.url === 'string' ? current.meta.url : undefined,
      ...isPr ? { prAuthor: typeof current.meta.prAuthor === 'string' ? current.meta.prAuthor : undefined } : {} }
    await readNotes(ctx, round, ref, current.createdAt, config)
  }, thread => round.read.has(thread.key))
}
function nameThread(ctx: SourceContext, iid: number, isPr: boolean, title: string, url?: string): void {
  const key = `gitlab:${gitlabThread(iid, isPr)}`
  const label = `${prefix(isPr)}${iid}`
  ctx.threads.patch(key, { title, number: iid, isPr, ...(url ? { url } : {}) })
  ctx.threads.describe(key, { label: `${label} ${title}`, ...(url ? { url } : {}), facts: { number: { value: label } } })
}
