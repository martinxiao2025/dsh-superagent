/**
 * runtime.spec.ts 的共享宿主夹具（从 runtime.spec.ts 拆出）：在模拟 DeepSeek Harness 宿主上
 * 运行已配置的 Runtime——假 agents/tools/sections/guards、假 CLI 子进程答案、内存飞书记录
 * 与 GitHub 账户。每个从 runtime.spec.ts 拆出的 spec 文件在顶部调用 `runtimeHost()`：
 * 它注册 beforeEach/afterEach 并返回全部句柄。会随 beforeEach 重置的可变句柄
 * （`h.runtime`、`h.directory`、`h.answers`、`h.jobs` 等）请通过属性读写，
 * 稳定的辅助函数（`runTool`、`feishu`、`route`、`acceptedTicket` 等）解构即可。
 */
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Runtime } from '../../src/app/runtime.ts'
import { jobRegistry } from './host.ts'
import { overview } from '../../src/app/views/overview.ts'
import { executorLoad } from '../../src/app/views/tickets.ts'
import { testMachine } from './deployment.ts'
import type { Machine } from '../../src/deployment.ts'
import { Store } from '../../src/app/store.ts'
import { SettingsSchema, policyVersion } from '../../src/policy.ts'
import { feishuKind, feishuTrigger } from '../../src/sources/feishu.ts'
import { Commands } from '../../src/infra/commands.ts'
import { threadKey, type Trigger } from '../../src/core/index.ts'
import { credentialHelper, workerGitConfig } from '../../src/infra/environment.ts'

export type RegisteredTool = { name: string; output: { render: (args: unknown, result: unknown) => unknown }; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
export type Section = { name: string; text: (context: { signal?: AbortSignal }) => string; interpolate?: boolean }
export type Guard = (execution?: { name: string; arguments: unknown }) => string | undefined
export type HttpHandler = (req: unknown, res: unknown) => Promise<void>
export interface Accounts { github?: Record<string, unknown>; feishu?: Record<string, unknown> | null }

/** 传给 `runtimeHost` 的选项：额外注册进宿主 Context 的服务，供个别用例在重启前替换。 */
export interface RuntimeHostOptions { services?: Record<string, unknown> }

export function runtimeHost (options: RuntimeHostOptions = {}) {
  let runtime: Runtime
  /** 预设提供的 shell 工具名随平台不同：Windows 上是 `pwsh`（`tool-bash` 被禁用），其他平台上是 `bash`。 */
  const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'
  const viewsOf = (value: Runtime) => ({ store: value.store, sources: value.sources, links: value.links() })
  const overviewOf = (value: Runtime) => overview(viewsOf(value), value.health, policyVersion(value.store.settings()), executorLoad(value.store, value.executor.activeCount()), value.setupProblem ?? value.sourceProblem)
  let directory: string
  let controller: { create: ReturnType<typeof vi.fn>; selectModel: ReturnType<typeof vi.fn>; resolveAgent: ReturnType<typeof vi.fn>; rename: ReturnType<typeof vi.fn>; prompt: ReturnType<typeof vi.fn>; events: ReturnType<typeof vi.fn> }
  let tools: Map<string, Map<string, RegisteredTool>>
  let sections: Map<string, Section>
  let guards: Map<string, Guard>
  let restricts: Map<string, unknown[]>
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
  function seed(store: Store, accounts: Accounts = {}): void {
    const settings = store.settings()
    const { feishu: _feishu, ...others } = settings.sources
    const feishu = accounts.feishu === null ? undefined : { ...settings.sources.feishu?.config, cli: BOT(), ...accounts.feishu }
    store.saveSettings(SettingsSchema.parse({ ...settings,
      sources: { ...others, ...feishu ? { feishu: { kind: 'feishu', name: '飞书', enabled: true, config: feishu } } : {} } }))
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
    return feishuFrom('feishu', id, text, overrides)
  }
  /** 与 `feishu` 相同，但来自另一条飞书记录，因此属于另一个项目。 */
  function feishuFrom(source: string, id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
    return feishuTrigger(source, { message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000), mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
  }
  /** 新增一条飞书记录与它的策略，使它的工单属于另一个项目。 */
  async function addFeishuSource(id: string) {
    const current = runtime.store.settings()
    runtime.store.saveSettings({ ...current,
      policy: { ...current.policy, sources: { ...current.policy.sources, [id]: { allowed: [{ id: MEMBER, name: 'Alice' }] } } },
      sources: { ...current.sources, [id]: { kind: 'feishu', name: id, enabled: true, config: { ...current.sources.feishu!.config } } } })
    await runtime.idle()
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
    vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : { default_branch: 'master', permissions: { push: true } })
    vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
    vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
    vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
    restarts = vi.fn()
    answers = {
      [`git -C ${directory} rev-parse --show-toplevel`]: `${directory}\n`,
      [`git -C ${directory} remote get-url --push origin`]: 'https://github.com/acme/widgets.git\n',
      [`${AGENT()} api user`]: '{"login":"agent-bot","id":7}', [`${AGENT()} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
      [`${OTHER()} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
      [`${OTHER()} config strict-mode`]: 'strict-mode: bot (source: profile)',
      [`${OTHER()} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
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
        const inherited = [SHELL, 'read', 'read_image', 'skill', 'job_output', 'job_list', 'job_kill', 'grep', 'web_search',
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
      events: vi.fn(async () => ({ records: [], hasMore: false, cursor: 0 })),
    }
    jobs = jobRegistry()
    services = { agents, llm: { resolveCallConfig: vi.fn(async value => value) }, sessionController: controller, sessionPersistence: { flush: vi.fn(async () => {}), open: vi.fn(async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} })) }, workspaceRegistry: { create: async (cwd: string) => ({ id: cwd, setTitle: async () => {} }) }, permissionPresets: { set: () => {} }, subprocess, webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: HttpHandler }) => { http = route.handler; return () => {} } }, jobs: jobs.service }
    if (options.services) Object.assign(services, options.services)
    for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
    for (const cli of [AGENT(), OTHER(), BOT()]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
    // 宿主进程可能自带 GIT_CONFIG_GLOBAL 等遗留值：垫片用例假定 stop 把环境恢复为进入前的形态，
    // 因此在运行时启动前清空这些变量，使「恢复为 undefined」的断言在任何宿主环境下都自洽。
    vi.stubEnv('GIT_CONFIG_GLOBAL', undefined); vi.stubEnv('GIT_CONFIG_NOSYSTEM', undefined)
    const store = new Store(join(directory, 'orchestrator.sqlite')); seed(store); store.close()
    runtime = new Runtime(ctx, testMachine({ stateDir: directory }), restarts)
    await runtime.ready
    // 来源类型通常由插件注册，而单元测试中不会加载这些插件。
    runtime.sources.register(feishuKind)
    runtime.store.saveSettings({ ...runtime.store.settings(), policy: { ...runtime.store.settings().policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT } } }, eval: { ...runtime.store.settings().eval, mode: 'auto' }, sources: { feishu: { kind: 'feishu', name: '飞书', enabled: true, config: { cli: BOT(), chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })
    deliveries.mockClear()
  })
  afterEach(async () => { expect(controller.prompt).not.toHaveBeenCalled(); await runtime?.stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })
  return {
    get runtime() { return runtime }, set runtime(value: Runtime) { runtime = value },
    get answers() { return answers }, set answers(value: Record<string, string | Error>) { answers = value },
    get jobs() { return jobs }, set jobs(value: ReturnType<typeof jobRegistry>) { jobs = value },
    get directory() { return directory },
    get controller() { return controller },
    get tools() { return tools },
    get sections() { return sections },
    get guards() { return guards },
    get restricts() { return restricts },
    get http() { return http },
    get agents() { return agents },
    get services() { return services },
    get deliveries() { return deliveries },
    get restarts() { return restarts },
    SHELL, viewsOf, overviewOf, api, runTool, subscribe, receive, relays,
    MEMBER, CHAT, feishu, feishuFrom, addFeishuSource, worktreeName, route, acceptedTicket,
    AGENT, OTHER, BOT, HELPERS, SCOPED, subprocess, restart,
  }
}
