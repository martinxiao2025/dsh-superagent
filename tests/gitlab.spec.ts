import { describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { GitlabConfigSchema, gitlabKind, pollRound, pollThreads as pollGitlabThreads, watch } from '../src/sources/gitlab.ts'
import { gitlabChannel } from '../src/sources/gitlab-trigger.ts'
import { gitlabThreadContext, readGitlab } from '../src/sources/gitlab-read.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { issueTrigger, isHumanAccount, noteTrigger, pullTrigger, type GitlabItem, type GitlabNote } from '../src/sources/gitlab-trigger.ts'
import { pollFailure } from '../src/sources/poll.ts'
import { testDeployment, testGitlab } from './fixtures/deployment.ts'
import { programSource } from './fixtures/program.ts'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT = 'group/sub/widgets'
const URL = `https://gitlab.com/${PROJECT}`
const LOGIN = 'agent-bot'
const ISSUE_URL = `${URL}/-/issues/12`
const MR_URL = `${URL}/-/merge_requests/3`
const at = () => new Date().toISOString()
const issue = (time = at()): GitlabItem => ({ id: 101, iid: 12, title: 'Fix the margin', description: 'Please @agent-bot fix it',
  state: 'opened', created_at: time, updated_at: time, web_url: ISSUE_URL, author: { id: 1, username: 'alice' } })
const mr = (time = at()): GitlabItem => ({ id: 201, iid: 3, title: 'Fix the padding', description: '', state: 'opened',
  created_at: time, updated_at: time, web_url: MR_URL, author: { id: 2, username: 'carol' }, source_branch: 'fix', target_branch: 'main' })
const note = (body: string, time = at(), id = 1): GitlabNote => ({ id, body, system: false,
  author: { id: 1, username: 'alice' }, created_at: time, updated_at: time })
/** 伪造的 glab：按 `api <path>` 路由读取 JSON 夹具，支持 page/per_page、POST 回帖和 404。 */
const glabBody = (fixture: string, calls: string, project: string): string => `
const fs = require('node:fs')
const args = argv
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
const data = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'))
if (args[0] !== 'api') return 1
const target = args[1] || ''
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET'
if (target === 'user') { console.log(JSON.stringify(data.user)); return 0 }
const prefixes = ['projects/' + encodeURIComponent(${JSON.stringify(project)}), 'projects/' + data.projectId]
const prefix = prefixes.find(item => target === item || target.startsWith(item + '/'))
if (!prefix) { console.error('glab: outside project'); return 1 }
if (target === prefix) { console.log(JSON.stringify(data.projectPayload)); return 0 }
const raw = target.slice(prefix.length + 1)
const query = raw.split('?')[1] || ''
const path = raw.split('?')[0]
const page = Number(new URLSearchParams(query).get('page') || '1')
const per = Number(new URLSearchParams(query).get('per_page') || '100')
if (method === 'POST') {
  const flag = args.indexOf('-f')
  const field = flag >= 0 ? args[flag + 1] : ''
  const count = Object.values(data.posted).reduce((sum, list) => sum + list.length, 0)
  const note = { id: 900 + count, body: String(field).replace(/^body=/, ''), author: { username: data.login },
    created_at: new Date().toISOString(), system: false }
  data.posted[path] = [note, ...(data.posted[path] || [])]
  fs.writeFileSync(${JSON.stringify(fixture)}, JSON.stringify(data))
  console.log(JSON.stringify(note))
  return 0
}
const value = data.routes[path]
if (value === 404) { console.error('glab: Not Found (HTTP 404)'); return 1 }
const all = [...(data.posted[path] || []), ...(Array.isArray(value) ? value : [])]
if (path.endsWith('/notes')) { console.log(JSON.stringify(all.slice((page - 1) * per, page * per))); return 0 }
if (Array.isArray(value)) { console.log(JSON.stringify(value.slice((page - 1) * per, page * per))); return 0 }
if (value && Array.isArray(value.pages)) { console.log(JSON.stringify(value.pages[page - 1] || [])); return 0 }
console.log(JSON.stringify(value === undefined ? [] : value))
return 0
`
/** 搭建 GitLab 来源的离线宿主；所有 CLI 调用都落到假 glab，且可以逐轮改写路由。 */
function host(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gitlab-'))
  const fixture = join(dir, 'glab.json')
  const calls = join(dir, 'calls.json')
  writeFileSync(fixture, JSON.stringify({ projectPath: PROJECT, projectId: 42, login: LOGIN, user: { id: 7, username: LOGIN },
    projectPayload: { id: 42, path_with_namespace: PROJECT, namespace: { path: 'group/sub' },
      permissions: { project_access: { access_level: 30 }, group_access: null } }, posted: {}, routes: {} }))
  writeFileSync(calls, '')
  const cli = programSource(dir, 'glab', glabBody(fixture, calls, PROJECT))
  const store = new Store(join(dir, 'oracle.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' }, sources: { gitlab: { kind: 'gitlab', enabled: true, config: { project: PROJECT, ...config } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const deployment = testDeployment({ gitlab: { cli, project: PROJECT, projectId: 42, login: LOGIN, id: 'gitlab', kind: 'gitlab', instanceUrl: '', userId: 7 } })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const received: Trigger[] = []
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); if (result !== 'duplicate') received.push(trigger); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment, stateDir: '',
    ready: Promise.resolve(), configured: () => true, receive }
  const context = sourceContextOf(parts, gitlabKind, 'gitlab')
  const read = () => JSON.parse(readFileSync(fixture, 'utf8')) as { posted: Record<string, { body: string }[]>; routes: Record<string, unknown> }
  const write = (data: unknown) => writeFileSync(fixture, JSON.stringify(data))
  const setRoutes = (routes: Record<string, unknown>) => { const data = read(); write({ ...data, routes: { ...data.routes, ...routes } }) }
  const callsRead = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
  return { ...context, store, received, health: () => board.all, fixture, read, setRoutes, calls: callsRead }
}

describe('gitlab triggers', () => {
  it('parses Issue, merge request and note triggers with GitLab thread IDs and GitHub-shaped meta', () => {
    const item = issue()
    expect(issueTrigger('gitlab', item, LOGIN)).toMatchObject({ id: key('gitlab-issue', '12'), source: 'gitlab',
      threads: [{ source: 'gitlab', id: 'issue:12' }], actor: { source: 'gitlab', id: 'alice' }, human: true,
      addressed: 'mention', url: ISSUE_URL, meta: { number: 12, isPr: false, kind: 'issue' } })
    expect(pullTrigger('gitlab', mr(), LOGIN)).toMatchObject({ id: key('gitlab-mr', '3'), threads: [{ source: 'gitlab', id: 'mr:3' }],
      url: MR_URL, meta: { number: 3, isPr: true, prAuthor: 'carol', kind: 'pull' } })
    const ref = { iid: 12, isPr: false, url: ISSUE_URL }
    const human = noteTrigger('gitlab', note('@Agent-Bot please'), ref, LOGIN)
    expect(human).toMatchObject({ threads: [{ source: 'gitlab', id: 'issue:12' }], human: true, addressed: 'mention',
      url: `${ISSUE_URL}#note_1`, meta: { number: 12, isPr: false, commentId: 1, kind: 'conversation' } })
    expect(noteTrigger('gitlab', note('@Agent-Bot', at(), 2), ref, LOGIN).id).not.toBe(human.id)
  })
  it('treats system notes, bots and the agent itself as non-human', () => {
    const ref = { iid: 12, isPr: false, url: ISSUE_URL }
    expect(isHumanAccount({ username: 'alice' })).toBe(true)
    expect(isHumanAccount({ username: 'alice', bot: true })).toBe(false)
    expect(isHumanAccount({ username: 'project_123_bot' })).toBe(false)
    expect(noteTrigger('gitlab', { ...note('system'), system: true }, ref, LOGIN).human).toBe(false)
    expect(noteTrigger('gitlab', { ...note('bot'), author: { username: 'project_123_bot' } }, ref, LOGIN).human).toBe(false)
    expect(noteTrigger('gitlab', { ...note('mine'), author: { username: LOGIN } }, ref, LOGIN).human).toBe(false)
  })
  it('finds Issues, merge requests and their URLs', () => {
    const instance = { id: 'gitlab', kind: 'gitlab', enabled: true, config: {} }
    expect(gitlabKind.find!(instance, '#12')).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!(instance, '!12')).toEqual({ threads: ['gitlab:mr:12'], terms: [] })
    expect(gitlabKind.find!(instance, `${URL}/-/issues/12`)).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!(instance, `${URL}/-/merge_requests/3`)).toEqual({ threads: ['gitlab:mr:3'], terms: [] })
  })
  it('maps receive scopes and Policy rows through the shared forge policy', () => {
    const config = GitlabConfigSchema.parse({ project: PROJECT, observeIssues: true, observeComments: true })
    expect(gitlabKind.scope!({ meta: { kind: 'issue' } }, config)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { kind: 'pull' } }, config)).toEqual({ listened: true, observed: false, row: 'pulls' })
    expect(gitlabKind.scope!({ meta: { kind: 'conversation' } }, config)).toEqual({ listened: true, observed: true, row: 'comments' })
    expect(gitlabKind.policy!.rows!({ observeIssues: true, observePulls: false, observeComments: true })).toMatchObject([
      { id: 'issues', note: { zh: '全部' }, cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } },
      { id: 'pulls', note: { zh: '仅 @' }, cells: { listedUnaddressed: false } },
      { id: 'comments', note: { zh: '全部' } },
    ])
  })
})

describe('gitlab polling', () => {
  it('establishes both stream cursors on the first round, then emits new Issue and MR triggers once', async () => {
    const h = host()
    await pollRound(h)
    expect(h.calls()).toEqual([])
    expect(h.health().gitlab).toMatchObject({ state: 'ready', detail: expect.stringContaining('0 issues, 0 merge requests') })
    const time = at()
    h.setRoutes({ issues: [issue(time)], merge_requests: [mr(time)] })
    expect(await pollRound(h)).toEqual({ issues: 1, mrs: 1 })
    expect(h.received.map(trigger => trigger.id)).toEqual([key('gitlab-issue', '12'), key('gitlab-mr', '3')])
    expect(h.health().gitlab).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 issues, 1 merge requests') })
    expect(h.store.get('gitlab-cursor:gitlab:issues')).toBeTruthy()
    expect(h.store.get('gitlab-cursor:gitlab:merge_requests')).toBeTruthy()
    await pollRound(h)
    expect(h.received).toHaveLength(2)
  })
  it('drops an unaddressed note when Receive comments is off, and receives it when on', async () => {
    const off = host()
    await pollRound(off)
    const time = at()
    off.setRoutes({ issues: [{ ...issue(time), description: 'no mention' }], 'issues/12/notes': [note('just a note', time)] })
    await pollRound(off)
    expect(off.received.map(trigger => trigger.meta.kind)).toEqual(['issue'])
    const on = host({ observeComments: true })
    await pollRound(on)
    on.setRoutes({ issues: [{ ...issue(time), description: 'no mention' }], 'issues/12/notes': [note('just a note', time)] })
    await pollRound(on)
    expect(on.received.map(trigger => trigger.meta.kind)).toEqual(['issue', 'conversation'])
  })
  it('does not replay notes that predate the cursor on an updated existing item', async () => {
    const h = host({ observeComments: true })
    await pollRound(h)
    const now = Date.now()
    h.setRoutes({ issues: [{ ...issue(new Date(now - 120_000).toISOString()), updated_at: at() }],
      'issues/12/notes': [note('an old note', new Date(now - 90_000).toISOString())] })
    expect(await pollRound(h)).toEqual({ issues: 1, mrs: 0 })
    expect(h.received).toEqual([])
  })
  it('reads new notes on a followed Thread', async () => {
    const h = host()
    const createdAt = new Date(Date.now() - 60_000).toISOString()
    h.store.threads.save({ key: 'gitlab:issue:12', ref: { source: 'gitlab', id: 'issue:12' }, createdAt, subscriptions: ['t-1'],
      correlated: [], pending: [], meta: { title: 'Fix the margin', number: 12, isPr: false, url: ISSUE_URL } })
    h.setRoutes({ 'issues/12/notes': [note('@agent-bot please continue', at())] })
    await pollGitlabThreads(h)
    expect(h.received).toHaveLength(1)
    expect(h.received[0]).toMatchObject({ threads: [{ source: 'gitlab', id: 'issue:12' }], addressed: 'mention',
      meta: { number: 12, commentId: 1, kind: 'conversation' } })
    expect(h.store.get('gitlab-notes:gitlab:issue:12')).toBeTruthy()
  })
  it('reports ready details and the consecutive-failure threshold', async () => {
    expect(pollFailure(1, 2, new Error('network'))).toBeUndefined()
    expect(pollFailure(2, 2, new Error('network'))).toMatchObject({ state: 'error', code: 'pollFailures',
      values: { count: '2', error: 'Error: network' } })
    const h = host()
    await pollRound(h)
    expect(h.health().gitlab?.detail).toContain('next poll ≥ 60s')
    const failing = host({ failuresBeforeError: 1 })
    failing.store.set('gitlab-cursor:gitlab:issues', at())
    failing.store.set('gitlab-cursor:gitlab:merge_requests', at())
    failing.setRoutes({ issues: 404, merge_requests: 404 })
    const controller = new AbortController()
    const running = watch(failing, controller.signal)
    await vi.waitFor(() => expect(failing.health().gitlab?.state).toBe('error'), { timeout: 5_000 })
    controller.abort()
    await running
  })
})

describe('gitlab reading and replies', () => {
  it('reads an Issue body and paginates its notes', async () => {
    const h = host()
    const time = at()
    const notes = Array.from({ length: 100 }, (_, index) => note(`note ${index}`, time, index + 1))
    h.setRoutes({ 'issues/12': issue(time), 'issues/12/notes': notes })
    expect(await readGitlab(h.commands, 'gitlab/issues/12')).toMatchObject({ number: 12, title: 'Fix the margin', state: 'opened' })
    const page = await readGitlab(h.commands, 'gitlab/issues/12/notes/1') as { messages: unknown[]; next_resource: string }
    expect(page.messages).toHaveLength(101)
    expect(page.next_resource).toBe('2')
    const context = await gitlabThreadContext.read(h.commands, issueTrigger('gitlab', issue(time), LOGIN), 'root', undefined, {})
    expect(context.messages).toHaveLength(101)
    expect(context.next).toBe('2')
  })
  it('posts a marked note idempotently and treats 404 as gone', async () => {
    const h = host()
    const message = { id: 'out-1', channel: gitlabChannel('gitlab', 12, false, ISSUE_URL), text: 'Working on it', kind: 'reply' as const }
    expect(await sendGitlab(h, message)).toBe('sent')
    expect(await sendGitlab(h, message)).toBe('sent')
    const posted = h.read().posted['issues/12/notes']!
    expect(posted).toHaveLength(1)
    expect(posted[0]!.body).toContain('Working on it')
    expect(posted[0]!.body).toContain('<!-- dsh-superagent:out-1 -->')
    h.setRoutes({ 'issues/12/notes': 404 })
    expect(await sendGitlab(h, { ...message, id: 'out-2' })).toBe('gone')
  })
})
describe('GitLab records', () => {
  it('keeps the threads, triggers and channels of two records apart', () => {
    const primary = { id: 'gitlab', kind: 'gitlab', enabled: true, config: {} }
    const second = { id: 'gitlab-work', kind: 'gitlab', enabled: true, config: {} }
    expect(gitlabKind.find!(primary, '#12')).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!(second, '#12')).toEqual({ threads: ['gitlab-work:issue:12'], terms: [] })
    expect(gitlabKind.find!(second, '!3')).toEqual({ threads: ['gitlab-work:mr:3'], terms: [] })
    const item = issue()
    const other = issueTrigger('gitlab-work', item, LOGIN)
    expect(other).toMatchObject({ source: 'gitlab-work', threads: [{ source: 'gitlab-work', id: 'issue:12' }],
      actor: { source: 'gitlab-work', id: 'alice' }, channel: { source: 'gitlab-work', thread: 'gitlab-work:issue:12' } })
    expect(other.id).not.toBe(issueTrigger('gitlab', item, LOGIN).id)
    const ref = { iid: 12, isPr: false }
    expect(noteTrigger('gitlab-work', note('please'), ref, LOGIN).id)
      .not.toBe(noteTrigger('gitlab', note('please'), ref, LOGIN).id)
  })
  it('links a record\'s pages on its own GitLab instance', () => {
    const links = { gitlab: testGitlab({ id: 'gitlab-work', instanceUrl: 'https://gitlab.example.com/', project: 'group/sub/widgets' }) }
    expect(gitlabKind.channel!.link(gitlabChannel('gitlab-work', 12, false).address, links))
      .toEqual({ url: 'https://gitlab.example.com/group/sub/widgets/-/issues/12', label: { zh: 'GitLab #12', en: 'GitLab #12' } })
    expect(gitlabKind.channel!.link(gitlabChannel('gitlab-work', 3, true).address, links).url)
      .toBe('https://gitlab.example.com/group/sub/widgets/-/merge_requests/3')
    // 没有实例地址时仍按 gitlab.com 拼接。
    expect(gitlabKind.channel!.link(gitlabChannel('gitlab', 12, false).address,
      { gitlab: testGitlab({ project: 'group/sub/widgets' }) }).url).toBe(`${URL}/-/issues/12`)
  })
})
