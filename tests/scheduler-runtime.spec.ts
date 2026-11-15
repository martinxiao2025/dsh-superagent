/**
 * 项目调度与真实 Engine 的集成用例：真实 Runtime（真实 Store、真实调度器、真实 Effects）+
 * 内存任务来源驱动，覆盖「轮询入队 → 真实建单 → worker 会话报告 → 队列结算 → 回写驱动」
 * 的完整链路。queue.spec 用假引擎钉住状态机语义；本文件验证状态机与引擎/执行器的真实接缝。
 */
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Runtime } from '../src/app/runtime.ts'
import { jobRegistry } from './fixtures/host.ts'
import { reference, testMachine } from './fixtures/deployment.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { taskSources } from '../src/task-sources/index.ts'
import type { TaskSourceDriver } from '../src/task-sources/kind.ts'
import type { RawTask } from '../src/task-sources/tasks.ts'
import { z } from 'zod'

let directory: string
let runtime: Runtime
let deliveries: ReturnType<typeof vi.fn<(request: { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }) => void>>
/** 每个会话已注册的工具，按 `controller.create` 的注册路径捕获；`runReport` 经它调用执行器工具。 */
let toolRegistry: Map<string, Map<string, { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }>>
/** 内存任务来源：测试直接改 `tasks` 模拟来源变化；`written` 记录回写。 */
const driver: { tasks: RawTask[]; written: { taskId: string; status: string }[] } = { tasks: [], written: [] }
const memoryDriver: TaskSourceDriver = {
  kind: 'memory-e2e', title: { zh: '内存集成', en: 'Memory integration' }, description: { zh: '集成测试用', en: 'For integration tests' },
  schema: z.object({}).strict(), fields: [],
  fieldMap: { defaults: { id: 'id', title: 'title', description: 'description', status: 'status', priority: 'priority' }, required: [] },
  async verify() { return [] },
  async list() { return driver.tasks },
  async writeback(_config, target, status) { driver.written.push({ taskId: target.taskId, status }) },
}
/** 项目记录；设置块的键就是项目 ID，记录体内不含 `id`。 */
const project = (id: string) => ({ name: id, enabled: true, codeRepo: { kind: 'github', config: {} },
  taskSource: { kind: 'memory-e2e', config: {} }, gitCredential: '', feishuCredential: '',
  execution: { directory: '', branch: '', prepare: '', gitTimeoutSeconds: 0 },
  schedule: { intervalMinutes: 5, runOnStart: false }, retry: { maxRetries: 2, retryBackoffSeconds: 10 },
  taskPolicy: { doneStatus: '已完成', failedStatus: '失败', pendingStatuses: ['todo'] } })
const task = (id: string, title: string, status = 'todo'): RawTask => ({ id, title, description: `${title} 的说明`, status })
/** 推进调度器：手动 scan 与 pump，等待 Effects 派发。 */
const settle = async () => { await runtime.idle() }
const relays = (sessionId: string) => deliveries.mock.calls.map(([call]) => call)
  .filter(call => call.sessionId === sessionId)
  .map(call => { try { return JSON.parse(call.text) as Record<string, unknown> } catch { return { text: call.text } as Record<string, unknown> } })

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'orchestrator-scheduler-e2e-'))
  // 项目工单执行发生在 per-ticket worktree：materializeWorkspace 要求轮询工作副本已是 git 仓库。
  mkdirSync(join(directory, 'repos', 'repo-p1'), { recursive: true })
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : { default_branch: 'master', permissions: { push: true } })
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockImplementation(async args => {
    // materializeWorkspace 用 `rev-parse --is-inside-work-tree` 判断目录是否仓库（期望 'true'）；
    // 工单目录与轮询工作副本都按「已是同一仓库」放行，worktree 子命令静默成功。
    if (args[0] === 'rev-parse') return args[1] === '--is-inside-work-tree' ? 'true\n' : `${join(directory, 'repos', 'repo-p1')}\n`
    return ''
  })
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  taskSources.register(memoryDriver)
  // 最小宿主：与 runtime.spec 相同的假 DSH 服务面，但只要 agents 与 deliveries。
  const agents = new Map<string, { id: string; status: string; inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }; cancel: ReturnType<typeof vi.fn>; inject: ReturnType<typeof vi.fn> }>
  const tools = new Map<string, Map<string, { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }>>()
  toolRegistry = tools
  const sections = new Map<string, { name: string; text: () => string }>()
  const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'
  deliveries = vi.fn()
  const controller = {
    create: vi.fn(async ({ sessionId, agentPreset }: { sessionId: string; agentPreset: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const preset = {}
      const sessionTools = new Map<string, { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }>()
      tools.set(sessionId, sessionTools)
      agentCtx.reflect.provide('tools', { register: (tool: { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }) => { sessionTools.set(tool.name, tool); return () => sessionTools.delete(tool.name) },
        get: (name: string, scope?: object) => (scope === preset || scope === agents.get(sessionId)) && [SHELL, 'read', 'skill'].includes(name) ? { name } : undefined,
        restrict: () => () => {}, guard: () => () => {} })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: (spec: { name: string; text: () => string }) => { sections.set(sessionId, spec); return () => {} } })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[], remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
        const at = list.findIndex(message => message.id === id)
        if (at >= 0) list.splice(at, 1)
        return at >= 0 }) }
      const deliver = (mode: 'queue' | 'steer') => vi.fn((message: UserMessage) => {
        inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        deliveries({ sessionId, mode, id: message.id, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
        agents.get(sessionId)!.status = 'running'
      })
      const modelEvents: { type: string; data: unknown }[] = []
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver('queue'), steer: deliver('steer'), status: 'idle', inject: vi.fn(),
        session: { id: sessionId, header: { agentPreset }, snapshotEvents: () => modelEvents, requestHeader: () => undefined,
          append: vi.fn((type: string, data: unknown) => { modelEvents.push({ type, data }) }) }, cancel: vi.fn(), whenIdle: async () => {} } as never)
      bindScopeParent(agents.get(sessionId)!, preset)
    }),
    selectModel: vi.fn(async () => {}), resolveAgent: vi.fn(async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }),
    rename: vi.fn(async () => {}), prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }),
    inspect: vi.fn(async () => ({ events: [] })),
  }
  const jobs = jobRegistry()
  const subprocess = { spawn: vi.fn(() => ({ done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } } })) }
  const ctx = new Context()
  const services = { agents, llm: { resolveCallConfig: vi.fn(async value => value) }, sessionController: controller,
    sessionPersistence: { flush: vi.fn(async () => {}), open: vi.fn(async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} })) },
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd, setTitle: async () => {} }) }, permissionPresets: { set: () => {} }, subprocess,
    webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} }, jobs: jobs.service }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  const BOT = join(directory, 'lark-bot')
  writeFileSync(BOT, '#!/bin/sh\n', { mode: 0o755 })
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const settings = store.settings()
  store.saveSettings(SettingsSchema.parse({ ...settings, sources: { feishu: { kind: 'feishu', name: '飞书', enabled: true, config: { cli: BOT } } } }))
  store.close()
  runtime = new Runtime(ctx, testMachine({ stateDir: directory }), vi.fn())
  await runtime.ready
  runtime.sources.register({ kind: 'feishu', title: { zh: '飞书', en: 'Feishu' }, description: { zh: '', en: '' }, schema: z.object({}).passthrough(),
    fields: [], health: [] } as never)
  runtime.store.saveSettings({ ...runtime.store.settings(), sources: { feishu: { kind: 'feishu', name: '飞书', enabled: true, config: { cli: BOT } } } })
  // 注册集成项目：内联内存任务来源与空仓库。
  runtime.store.saveSettings({ ...runtime.store.settings(),
    policy: { ...runtime.store.settings().policy, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } } })
  await runtime.idle()
  deliveries.mockClear()
  // 吸收启动 tick（runExclusive 的首轮）：后到的 scan 会并入已运行的一轮，
  // 因此先排空它，测试里的 scan 才能真正轮询（项目的 runOnStart=false 不轮询启动轮）。
  await runtime.scheduler.scan()
})

afterEach(async () => { await runtime?.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

describe('调度器与真实引擎集成', () => {
  it('轮询入队 → 建单 → worker 首条消息承载任务 → 报告完成 → 队列结算并回写驱动', async () => {
    driver.tasks = [task('t1', '登录修复')]
    const current = runtime.store.settings()
    runtime.store.projects.save('p1', project('p1') as never)
    // scan 一轮完成轮询、建单与派工：真实引擎创建了工单与 worker 会话。
    await runtime.scheduler.scan()
    await runtime.idle()
    // launch 副作用是异步的：等 worker 会话出现（Effects 派发 + sessions.ensure 完成）。
    for (let attempt = 0; attempt < 50 && ![...toolRegistry.keys()].some(id => id.startsWith('worker-')); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await runtime.idle()
    }
    const entries = runtime.store.queue.list()
    expect(entries.map(entry => [entry.task, entry.state])).toEqual([['t1', 'running']])
    const ticketId = entries[0]!.ticketId!
    expect(runtime.store.tickets.get(ticketId)).toMatchObject({ title: '登录修复', mandate: { basis: { via: 'scheduled' } } })
    const sessionId = `worker-${ticketId}`
    // 真实执行器向 worker 会话投递了承载任务的首条消息：工单 id、标题与调度触发器。
    expect(relays(sessionId)[0]).toMatchObject({ ticket_id: ticketId, title: '登录修复',
      trigger: { text: '登录修复' } })
    // worker 报告完成：经 orchestrator_report 工具（真实引擎路径）记录并结束工单。
    await runReport(ticketId, sessionId, 'ready', '修复完成，已提交 PR')
    await runtime.idle()
    const ended = runtime.store.tickets.get(ticketId)!
    expect(ended.ended).toMatchObject({ outcome: 'completed' })
    // 工单结束回调把队列结算为 succeeded；回写副作用经 Effects 落到驱动。
    await runtime.idle()
    expect(runtime.store.queue.get(entries[0]!.id)).toMatchObject({ state: 'succeeded' })
    expect(driver.written).toEqual([{ taskId: 't1', status: '已完成' }])
  })

  it('worker 报告失败时队列按项目退避重试，重试产生新工单', async () => {
    driver.tasks = [task('t2', '导出修复')]
    runtime.store.projects.save('p1', project('p1') as never)
    await runtime.scheduler.scan()
    await runtime.idle()
    const entry = runtime.store.queue.list()[0]!
    expect(entry).toMatchObject({ state: 'running' })
    const firstTicket = entry.ticketId!
    await runReport(firstTicket, `worker-${firstTicket}`, 'dropped', '缺少必要信息')
    await runtime.idle()
    const retried = runtime.store.queue.get(entry.id)!
    expect(retried.state).toBe('queued')
    expect(retried.attempt).toBe(1)
    expect(retried.ticketId).toBeFalsy()
    expect(runtime.store.tickets.get(firstTicket)!.ended).toMatchObject({ outcome: 'dropped' })
    // 到期后重试建新工单：新旧工单是两个不同的工单。
    runtime.store.queue.save({ ...retried, dueAt: Date.now() - 1 })
    runtime.scheduler.pump()
    await runtime.idle()
    const second = runtime.store.queue.get(entry.id)!
    expect(second.state).toBe('running')
    expect(second.ticketId).toBeTruthy()
    expect(second.ticketId).not.toBe(firstTicket)
    expect(second.tickets).toContain(firstTicket)
  })

  it('停用项目保留排队项；重新启用后继续派工', async () => {
    driver.tasks = [task('t3', '样式修复')]
    runtime.store.projects.save('p1', project('p1') as never)
    await runtime.scheduler.scan()
    await runtime.idle()
    const first = runtime.store.queue.list()[0]!
    expect(first).toMatchObject({ state: 'running' })
    // 执行中的项目轮询被推迟（与 worker 检出互斥）；先把 t3 结算完成，空闲后才轮询到 t4。
    await runReport(first.ticketId!, `worker-${first.ticketId!}`, 'ready', '完成')
    await runtime.idle()
    // 先用 poll 直接入队 t4（绕过 scan 尾部的 pump），再停用项目：pump 不派发停用项目的排队项。
    driver.tasks = [task('t3', '样式修复'), task('t4', '打印修复')]
    await runtime.scheduler.poll('p1')
    await runtime.idle()
    const queuedBefore = runtime.store.queue.list().filter(entry => entry.task === 't4')
    expect(queuedBefore).toHaveLength(1)
    const settings = runtime.store.settings()
    runtime.store.projects.save('p1', { ...project('p1'), enabled: false } as never)
    runtime.scheduler.pump()
    await runtime.idle()
    const queued = runtime.store.queue.list().filter(entry => entry.task === 't4')
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ state: 'queued' })
    // 重新启用后继续派工。
    runtime.store.projects.save('p1', project('p1') as never)
    runtime.scheduler.pump()
    await runtime.idle()
    expect(runtime.store.queue.get(queued[0]!.id)).toMatchObject({ state: 'running' })
  })

  it('手动重试耗尽重试的条目会生成新触发器并真正重新执行（评审 C1）', async () => {
    // 回归背景：retryEntry 把 attempt 归零后，triggerId 若只由 attempt 决定，
    // pump 会幂等拿回历史尝试已结束的旧工单——重试不执行任何新工单还会再次回写失败。
    // 修复：triggerId 纳入 tickets.length（工单历史代次，永不复位）。
    driver.tasks = [task('t5', '部署修复')]
    runtime.store.projects.save('p1', project('p1') as never)
    await runtime.scheduler.scan()
    await runtime.idle()
    const entry = runtime.store.queue.list()[0]!
    const firstTicket = entry.ticketId!
    // 耗尽全部自动重试（maxRetries=2）：连续三次 dropped 报告；每次重试产生新工单（其 worker 会话按新工单命名）。
    for (let round = 0; round <= 2; round++) {
      const current = runtime.store.queue.get(entry.id)!.ticketId!
      await runReport(current, `worker-${current}`, 'dropped', `失败 ${round}`)
      await runtime.idle()
      const due = runtime.store.queue.get(entry.id)!
      if (due.state === 'queued') runtime.store.queue.save({ ...due, dueAt: Date.now() - 1 })
      runtime.scheduler.pump()
      await runtime.idle()
    }
    const exhausted = runtime.store.queue.get(entry.id)!
    expect(exhausted).toMatchObject({ state: 'failed' })
    expect(exhausted.attempt).toBe(3)
    // 手动重试：attempt 归零，但历史代次使触发器全新 → 产生新工单并进入 running。
    expect(runtime.scheduler.retryEntry(exhausted.id).retried).toBe(true)
    await runtime.idle()
    const retried = runtime.store.queue.get(entry.id)!
    expect(retried.state).toBe('running')
    expect(retried.ticketId).toBeTruthy()
    expect(retried.ticketId).not.toBe(firstTicket)
  })

  it('worker 向人提问时队列不接管工单（评审 C2）', async () => {
    // 回归背景：settleOutcome 曾对全部 person 阶段 stop-then-retry——worker 通过 attention
    // 提的问题会在 15 秒内被强停重建，问题丢失且烧掉重试预算。现在只有 blocked/failed 接管。
    driver.tasks = [task('t6', '设计确认')]
    runtime.store.projects.save('p1', project('p1') as never)
    await runtime.scheduler.scan()
    await runtime.idle()
    const entry = runtime.store.queue.list()[0]!
    const ticketId = entry.ticketId!
    // worker 用 progress + human_action 向人提问：工单进入 person/answer（attention 置位）。
    const ask = toolRegistry.get(`worker-${ticketId}`)?.get('orchestrator_report')!
    await ask.execute({ state: 'progress', summary: '进行中，需要确认', human_action: '用哪个配色方案？' }, { signal: new AbortController().signal })
    await runtime.idle()
    // 再走一轮调度：工单仍然存活，问题保留，队列条目保持 running。
    runtime.scheduler.pump()
    await runtime.idle()
    const ticket = runtime.store.tickets.get(ticketId)!
    expect(ticket.ended).toBeUndefined()
    expect(ticket.attention).toBeDefined()
    expect(runtime.store.queue.get(entry.id)).toMatchObject({ state: 'running', ticketId })
  })

  it('worker 报告 blocked 时项目按既有语义接管（评审 C2 白名单的反向验证）', async () => {
    driver.tasks = [task('t7', '构建修复')]
    runtime.store.projects.save('p1', project('p1') as never)
    await runtime.scheduler.scan()
    await runtime.idle()
    const entry = runtime.store.queue.list()[0]!
    const ticketId = entry.ticketId!
    await runReport(ticketId, `worker-${ticketId}`, 'blocked', '等待设计文件')
    runtime.scheduler.observe(ticketId)
    await runtime.idle()
    // blocked 报告之后工单在等人：项目自动接管（stop-then-retry），条目回到 queued 等退避。
    expect(runtime.store.tickets.get(ticketId)!.ended).toBeDefined()
    expect(runtime.store.queue.get(entry.id)!.state).toBe('queued')
  })
})

/** 通过执行器工具把 worker 报告写进真实引擎（与 runtime.spec 相同的工具路径）。 */
async function runReport(ticketId: string, sessionId: string, state: string, summary: string): Promise<void> {
  const tool = toolRegistry.get(sessionId)?.get('orchestrator_report')
  if (!tool) throw new Error(`orchestrator_report is not registered for ${sessionId}`)
  await tool.execute({ state, summary }, { signal: new AbortController().signal })
  await runtime.idle()
}
