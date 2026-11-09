/** 编排器和执行器 DSH 会话的生命周期、提示词/工具/技能装饰、消息投递和预算重试跟踪。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** `Sessions` 使用的宿主依赖。 */
export interface SessionsHost {
  /** DSH Cordis 上下文：会话、智能体、持久化及其事件。 */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** `models` 健康条目，报告等待模型预算重试的受管会话。 */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** `ticket` 的执行环境变量，会渲染到其执行器的系统提示词中。 */
  environment(ticket: Ticket): Variable[]
  /** 要在主会话（`ticket === undefined`）或 `ticket` 的执行器会话上注册的工具。 */
  tools(agent: Agent, ticket?: Ticket): Tool[]
}

/**
 * Sessions 为其装饰的智能体注册的内容：提示词部分、工具和技能作用域的释放器，
 * 技能所在的作用域，以及某一提示词修订的技能；对于执行器的子代理，仅包含其工具限制。
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** 创建执行器会话和主会话时使用的智能体预设，由该包的补丁定义。 */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH 的智能体预设注册表为某个会话选择了 `agentPreset`。 */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * 执行器会话所使用的 DSH 工具：文件、搜索、shell 及其任务、Web、技能、待办列表和
 * 子代理。无论何时注册，它都不会获得配置中的其他工具：不会获得任何向人提问或展示内容的工具、修改配置的工具、
 * 安排工作或在执行器槽位之外启动目标的工具、暂停和人员挂起的工具、启动或向其他会话发消息的工具，或编辑文档的工具。
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** 主会话将要等待时被告知的内容：它等待的东西会主动送达，而等待步骤会阻塞下一步。 */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** 在 `standard` 下的主会话在其命令将等待 shell 默认时长时被告知的内容。 */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** 命令位置上的 `sleep`：开头，; & | ( { ! ` 或换行之后，或运行它的关键字或命令之后。 */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * 主会话的守卫：拒绝运行 sleep 或将步骤挂起超过 30 秒的 bash 命令，以及超过 5 秒的任务等待。在 `standard` 下，
 * 作为在路由器预设之前创建的主会话，shell 会将命令挂起 60 秒，任务等待默认持续 30 秒，
 * 因此命令需要设置超时或放到后台，任务等待则需要设置超时；路由器预设会将两者都在 5 秒后结束。
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * 创建并装饰编排器和执行器的 DSH `Agent` 会话，为其注入角色模型、来自 `Prompts` 的系统提示词部分、运行时技能和受限工具集。
 * `Runtime`、`DshExecutor`、`MasterAssessor`、`Settings` 以及管理路由/工具使用它来确保会话存在、通过 `AgentDelivery` 投递去重消息，并处理有序的 `relay` 和 `notice` 副作用。
 * 将会话事件送入 `RetryHealth`，以在 `models` `HealthEntry` 上报告模型预算等待，并在 `Store`（`KV.sessions.prompts`）中持久记录每个会话运行过的提示词修订，以授权提示词版本读取。
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** 已装饰的智能体及其注册的释放器和技能作用域，直到该智能体被释放或 `Sessions.dispose()` 运行。 */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** 注册有序的 `relay` 和 `notice` 副作用处理器，将内容投递到主会话。 */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // 按入队顺序把转发和通知投递到主会话。
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** 订阅宿主智能体和会话事件，使新建会话得到装饰，并让模型预算重试反映到健康状态中。在启动时调用一次。 */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // 在 DSH 的 Web UI 中于首次轮次之前打开会话时，可能会为其选择默认预设：再次选择我们的预设。
    // 首次轮次之后 DSH 会拒绝任何选择，因此保持原样。
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /** 在工作区 `cwd` 中解析或创建会话 `id`，初始化其角色模型，用提示词/技能/工具装饰它，设置 `danger-full-access` 权限，并将其重命名为 `title`。 */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // 会话会保留创建时使用的预设，即该包自带的预设之一（cordis.patch.yml）。
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** 返回 `sessionId` 是否已持有在 `requestId` 下投递的消息；若会话不存在则返回 `false`。 */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** 按请求 id 至多投递一次消息：投递到下一轮次、当前轮次，或不唤醒智能体地以标签 `inject`。 */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** `prompt` 在 `requestId` 下投递的消息 id，DSH 的收件箱事件以此命名。 */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** 向主会话入队一个引导转发；转发是持久化的，由 `Effects` 重试直至投递成功，每个 `requestId` 至多一次。 */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** 向主会话入队一个持久化后台通知，用于注入；同名的新通知会替换仍在等待的该名称通知。 */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** 等待当前可运行的 `notice` 副作用结算；若通知 `name` 已到达主会话则返回 `'injected'`，若仍在排队则返回 `'pending'`。 */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** 在不唤醒主会话的情况下向其注入通知；主会话尚不存在时为空操作。 */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // 按通知名称和载荷哈希去重，使重试具备幂等性，同时更新后的载荷仍会投递。
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** 返回当前提示词修订、每个已加载会话的活动提示词修订，以及主会话是否仍有待处理的 `'prompts'` 通知。 */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** 返回会话运行的提示词版本（其最新模型请求所绑定的版本，或当前版本）。 */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** 会话是否有权读取 `revision`（其活动修订或之前运行过的任何修订）。 */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** 返回 `agent` 的工具注册器，它把工具输出渲染为 JSON 文本，并在存在 `output.image` 时作为图片附加。 */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** 返回 `sessionId` 的活动模型预算重试状态（`{ model_retry }`）供状态列表使用；未在等待时返回 `{}`。 */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // 禁用变量插值，以保留团队提示词中的字面 ${{ ... }} 表达式。
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // 重新创建的技能作用域（例如技能服务重启后）初始为空，因此在重新绑定前重置 `binding.skills`。
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // 若智能体在等待技能作用域期间被释放，则退出。
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // 执行器会话保留其已有的配置文件工作工具（DSH 要求这些工具已知）；其自身工具不会被遮蔽。
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * 会话是否运行路由器预设：以 DSH 的预设注册表最近的选择为准（在注册表没有 `presetForSession` 的 DSH 上，
   * 通过会话投影读取），否则按创建时的设置；无法读取时使用更安全的 `standard` 上限。
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  /**
   * 执行器会话的工具：仅包含配置文件的工作工具（DSH 要求这些工具已知），其工单结束后则没有。
   * 失败或被阻塞的执行器会保留其工具，以便人员可在其会话中继续；只有自动化输入会等待（见执行器）。
   * 通过父作用域读取继承的工具，其中包含预设的工具。全局视图会遗漏预设工具；
   * 智能体自身的视图还会包含 `subagent` 等本地工具，而 restrict 拒绝命名它们。
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * 执行器会话的子代理，或其子代理的子代理，在 DSH 的 `standard` 预设下以执行器权限运行，
   * 获得与执行器相同的工具，并在执行器工单结束后不再拥有工具。其他智能体保持原样。
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // 沿子代理的父级向上找到执行器；这些父级在其子代理运行期间处于加载状态。
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** 在智能体的技能作用域中注册某一提示词版本的技能，替换较早版本的技能。 */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' || name === 'gitlab' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** 返回当前提示词版本；在绑定到模型请求时更新智能体的技能并把修订记录到 Store。 */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** 按相反顺序（LIFO）释放 `agent` 的注册；释放其技能作用域也会释放其技能。 */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** 释放 `Sessions` 在所有已装饰智能体上注册的提示词部分、技能和工具。 */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
