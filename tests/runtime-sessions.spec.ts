/**
 * 会话与预设（从 runtime.spec.ts 拆出）：在模拟 DeepSeek Harness 宿主上通过工具和 HTTP 运行整个应用——
 * 主动评估与沉默规则、执行环境提示词段、提示词版本与其读取限制、模板字面量、
 * 默认交付要求、主会话的 shell 与任务等待守卫、预设注册表与 standard 上限、
 * 工单工具的限制、明确工单的派工提示词、worker/router 预设与人的重选、
 * worker 子代理的工具与守卫，以及主会话提示词中的策略部分。
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { mandateInstructions } from '../src/executor/format.ts'
import { masterPrompt } from '../src/app/context.ts'
import { composeSkill, defaultPrompts } from '../src/app/prompts.ts'
import { policyVersion } from '../src/policy.ts'
import { key } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { runtimeHost } from './fixtures/runtime-host.ts'

const h = runtimeHost()
const { runTool, receive, relays, feishu, acceptedTicket, restart, CHAT, SHELL } = h
it('assesses a proactive observation in the orchestrator Session and creates the ticket only on a positive auto-mode decision', async () => {
  const observe = (mode: 'observe' | 'auto') => h.runtime.settings.save('eval', { ...h.runtime.store.settings().eval, mode }, h.runtime.store.blockRevision('eval'), 'panel')
  await observe('observe')
  const trigger = feishu('3', '这个文案好奇怪，改成“浏览网页”吧', { mentions: [] })
  await receive(trigger)
  const candidate = relays(h.runtime.masterId).at(-1)!
  expect(candidate).toMatchObject({ kind: 'candidate', strength: 'inferred', mode: 'observe', next_action: expect.stringContaining('orchestrator_eval') })
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_3', chat_id: CHAT }] })
  const details = await runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: trigger.id })
  // 规则位于主会话的策略部分；上下文会指明构建它时所用的策略版本。
  expect(details).not.toHaveProperty('rules')
  expect(details).toMatchObject({ trigger_id: trigger.id, strength: 'inferred', policy_version: policyVersion(h.runtime.store.settings()), thread: expect.objectContaining({ complete: true, loaded_messages: 0 }) })
  const decision = (id: string) => ({ trigger_id: id, decision: 'accept', title: '文案修订', worktree_name: 'copy-fix', scope: '改副标题', reason: 'explicit copy change', intent_evidence: 'quoted', acknowledgement: '收到，把副标题改成“浏览网页”。',
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'copy change' }, { rule_id: 'visual', matched: false, reason: 'not visual' }],
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'the message names the replacement' } })
  expect(await runTool(h.runtime.masterId, 'orchestrator_eval_decide', decision(trigger.id))).toMatchObject({ decision: 'ignore', reason: expect.stringContaining('Observe mode') })
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.runtime.store.decisions.byThread(`feishu:${CHAT}:om_3`)[0]!.audit).toMatchObject({ would_accept: true, proposal: { title: '文案修订' } })
  await observe('auto')
  const again = feishu('5', '把副标题改成“浏览网页”', { mentions: [] })
  await receive(again)
  await runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: again.id })
  const accepted = await runTool(h.runtime.masterId, 'orchestrator_eval_decide', decision(again.id))
  expect(accepted).toMatchObject({ decision: 'accept', ticket: { ticket_id: expect.any(String) } })
  const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  expect(ticket.mandate).toMatchObject({ strength: 'inferred', basis: expect.objectContaining({ via: 'admission', rules: ['copy'], observation: { mode: 'auto' } }) })
  expect(h.runtime.store.replyStatus(key('ack', again.id))).toBeDefined()
  expect(await runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}/assignment` })).toMatchObject({ text: expect.stringContaining('Proactively accepted under copy') })
})

it('accepts silently under a rule that says so, gives the worker the rule procedure, and closes it as dropped when nothing is left for a human', async () => {
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, rules: [...policy.rules, { id: 'silent-bugfix', name: '沉默地复现和修复', enabled: true, instruction: 'Reproduce minimally first; accept silently.' }] }, h.runtime.store.blockRevision('policy'), 'panel')
  await h.runtime.settings.save('eval', { ...h.runtime.store.settings().eval, mode: 'auto' }, h.runtime.store.blockRevision('eval'), 'panel')
  const trigger = feishu('20', '切换主题后刷新，图标颜色不对', { mentions: [] })
  await receive(trigger)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ items: [{ message_id: 'om_20', chat_id: CHAT }] })
  await runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: trigger.id })
  const accepted = await runTool(h.runtime.masterId, 'orchestrator_eval_decide', { trigger_id: trigger.id, decision: 'accept', title: '主题图标颜色', worktree_name: 'theme-icon-color', scope: 'bug', reason: 'reported defect', intent_evidence: 'quoted',
    rule_assessments: [{ rule_id: 'copy', matched: false, reason: 'no' }, { rule_id: 'visual', matched: false, reason: 'no' }, { rule_id: 'silent-bugfix', matched: true, reason: 'bug report' }],
    direction: { implementation_requested: true, target_basis: 'existing-standard', requires_design_decision: false, evidence: 'expected colour is the light palette' } })
  const ticket = h.runtime.store.tickets.get((accepted.ticket as { ticket_id: string }).ticket_id)!
  expect(h.runtime.store.replyStatus(key('ack', trigger.id))).toBeUndefined()
  await h.runtime.idle()
  expect(h.sections.get(`worker-${ticket.id}`)!.text({})).toContain(mandateInstructions({ strength: 'inferred' }))
  expect(await runTool(`worker-${ticket.id}`, 'orchestrator_read', { resource: `ticket/${ticket.id}/assignment` })).toMatchObject({ text: expect.stringContaining('沉默地复现和修复 (silent-bugfix): Reproduce minimally first; accept silently.') })
  await expect(runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'x' })).rejects.toThrow('not ready')
  await runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'blocked', summary: 'needs a decision' })
  await expect(runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: 'x' })).rejects.toThrow('not ready')
  // 没有留给人的事：工单会关闭而不是等待，规则的最后一句仍可被投递。
  await runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'dropped', summary: 'too complex; recorded in #123' })
  expect(h.runtime.store.tickets.get(ticket.id)).toMatchObject({ ended: expect.objectContaining({ by: 'executor', outcome: 'dropped' }) })
  expect(await runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, purpose: 'result', text: '看到这个问题我试了一下，能复现，修复需要较大改动，已记在 #123。' })).toEqual({ status: 'sent' })
})

it('tells both roles the execution environment through a generated prompt section, and each worker its own ticket\'s', async () => {
  const preview = h.runtime.prompts.preview(h.runtime.prompts.current().config)
  const section = preview.parts.worker.at(-1)!
  expect(section.name).toBe('runtime/environment')
  expect(section.text).toContain('DSH_SUPERAGENT_FEISHU_BOT')
  // 工单之外没有工单目录。
  expect(section.text).not.toContain('DSH_SUPERAGENT_DIR')
  // 主会话的策略部分紧随其后。
  expect(preview.orchestrator).toContain(`${section.text}\n\n## 策略`)
  const { ticket, sessionId } = await acceptedTicket()
  expect(h.sections.get(sessionId)!.text({})).toContain(`- DSH_SUPERAGENT_DIR = ${JSON.stringify(ticket.execution!.directory)}`)
  expect(h.sections.get(h.runtime.masterId)!.text({})).not.toContain('DSH_SUPERAGENT_DIR')
  const next = await restart({}, { feishu: null })
  await next.ready
  expect(Object.keys(next.prompts.preview(next.prompts.current().config).skills)).not.toContain('feishu')
})

it('lets a worker read the prompt version it works under and the ones it worked under before, also after a restart, and no other', async () => {
  const { sessionId } = await acceptedTicket()
  const save = () => { const { config, revision } = h.runtime.prompts.current(); return h.runtime.prompts.save({ ...config, delivery: `${config.delivery}.` }, revision, 'panel').revision }
  // 模型请求会读取系统提示词，它会将会话绑定到当时的版本。
  const request = () => h.sections.get(sessionId)!.text({ signal: new AbortController().signal })
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
  expect(h.runtime.sessions.status().sessions).toContainEqual({ sessionId, revision: third })
  const next = await restart()
  await next.ready
  expect([next.sessions.promptVersion(sessionId).revision, next.sessions.mayRead(sessionId, second), next.sessions.mayRead(sessionId, first)])
    .toEqual([third, true, false])
})

it('passes team text with template braces to every Session literally, without reading them as prompt variables', async () => {
  const delivery = 'Pin the build to ${{ github.sha }}; keep {{x}} as written.'
  const current = h.runtime.prompts.current()
  h.runtime.prompts.save({ ...current.config, delivery }, current.revision, 'panel')
  const { sessionId } = await acceptedTicket()
  for (const id of [h.runtime.masterId, sessionId]) {
    const section = h.sections.get(id)!
    const text = renderPrompt({ sections: [{ name: section.name, text: section.text({}), interpolate: section.interpolate }], contexts: [], tools: [], variables: {} })
    expect(text).toContain(delivery)
  }
})

it('credits each human reviewer once in the review skill, with a trigger line in the default delivery requirements, never with an empty commit', async () => {
  const delivery = h.runtime.prompts.current().config.delivery
  // delivery 默认文本只留触发指引与重复 PR 处置；记功流程在仅注册给 worker 的 review 技能中按需进入上下文。
  expect(delivery).toContain('完整流程在 dsh-superagent-review 技能中；首次评估人工评审者的反馈时先打开它')
  expect(delivery).toContain('立即用 gh 关闭本工单的 PR，无需询问任何人')
  const review = composeSkill(defaultPrompts(), 'review')
  expect(review).toContain('Co-authored-by: <name or login> <id+login@users.noreply.github.com>')
  expect(review).toContain('在该 PR 分支的每个提交上')
  expect(review).toContain('git filter-branch -f --msg-filter')
  expect(review).toContain('绝不要为了给审查者记功而推送空提交。')
  expect(review).toContain('不要给 bot')
})

it('refuses the main Session a bash command that runs sleep and a long job wait, as reports arrive by themselves, and no worker', async () => {
  const bash = (command: string) => ({ name: 'bash', arguments: { command, description: 'x' } })
  const main = h.guards.get(h.runtime.masterId)!
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
  ;(h.agents.get(h.runtime.masterId) as unknown as { session: { header: { agentPreset: string } } }).session.header = { agentPreset: 'standard' }
  expect(main(timed('gh pr checks 7 --watch'))).toMatch(/^This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000/)
  expect(main(timed('gh pr checks 7 --watch', { run_in_background: true }))).toBeUndefined()
  expect(main(timed('gh api repos/acme/widgets/pulls', { timeoutMs: 20_000 }))).toBeUndefined()
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true } })).toMatch(/^Reports/)
  expect(main({ name: 'job_output', arguments: { job_id: 'j', wait: true, timeout_ms: 5_000 } })).toBeUndefined()
  // worker 会在需要时等待自己的工作。
  const { sessionId } = await acceptedTicket()
  expect(h.guards.get(sessionId)!(bash('sleep 60'))).toBeUndefined()
  // 主会话的角色说明了这一点。
  expect(masterPrompt).toContain('worker 报告、follow_up 通知、新候选以及后台任务的结束及其输出会作为消息自行到达')
})

it('reads the main Session\'s preset from a registry with or without presetForSession, and takes standard\'s caps when it cannot', async () => {
  const watch = { name: 'bash', arguments: { command: 'gh pr checks 7 --watch', description: 'x' } }
  const route = { name: 'orchestrator_route', arguments: { decisions: [] } }
  const guard = async (registry: Record<string, unknown>, projections?: Record<string, unknown>) => {
    h.services.agentPresets = registry
    if (projections) h.services.sessionProjections = projections; else delete h.services.sessionProjections
    await (await restart()).ready
    return h.guards.get(h.runtime.masterId)!
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
  expect(h.guards.get(sessionId)!()).toBeUndefined()
  h.runtime.engine.stopTicket(ticket.id)
  expect(h.guards.get(sessionId)!()).toBe('Ticket ended; new work needs a new authorized ticket')
  expect(h.restricts.get(h.runtime.masterId)).toEqual([{ allow: ['skill', SHELL, 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }])
  // worker 只保留配置文件中的工作工具：没有要求人、更改配置文件、在 worker 槽位之外安排或启动工作、
  // 访问其他会话或编辑文档的工具，无论它们何时注册。
  expect(h.restricts.get(sessionId)).toEqual([{ allow: ['read', 'read_image', 'grep', SHELL, 'job_output', 'job_list', 'job_kill', 'web_search', 'skill'] }])
})

it('gives an explicit ticket\'s worker a prompt without the limits of an inferred Mandate', async () => {
  const { sessionId } = await acceptedTicket()
  await h.runtime.idle()
  expect(h.sections.get(sessionId)!.text({})).not.toContain(mandateInstructions({ strength: 'inferred' }))
})

it('creates an Executor Session under the bundle\'s worker preset, and the main Session under its router preset', async () => {
  const { sessionId } = await acceptedTicket()
  const created = h.controller.create.mock.calls.map(([options]) => options as { sessionId: string; agentPreset: string })
  expect(created.find(options => options.sessionId === sessionId)).toMatchObject({ agentPreset: 'dsh-superagent-worker' })
  expect(created.find(options => options.sessionId === h.runtime.masterId)).toMatchObject({ agentPreset: 'dsh-superagent-router' })
})

it('selects its own preset again for a main Session or worker a person switched before its first turn, and not after it', async () => {
  const { sessionId } = await acceptedTicket()
  // DSH 的预设注册表，仅在会话首个回合之前接受选择。
  const started = new Set<string>()
  const presets = { select: vi.fn(async (agent: { id: string }, preset: string) => {
    if (started.has(agent.id)) throw Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' })
    return preset
  }) }
  h.services.agentPresets = presets
  await (await restart()).ready
  const emit = (sessionId: string, preset: string) => (h.runtime as unknown as { ctx: Context }).ctx.emit('agent-preset/selected', sessionId, preset)
  // 有人在 DSH 的 Web UI 中打开了空白主会话，从而为其选择了默认预设。
  emit(h.runtime.masterId, 'standard')
  await vi.waitFor(() => expect(presets.select).toHaveBeenCalledWith(h.agents.get(h.runtime.masterId), 'dsh-superagent-router'))
  // 它自己的预设也以同样方式由该选择宣告，保持不动。
  presets.select.mockClear()
  emit(h.runtime.masterId, 'dsh-superagent-router'); await Promise.resolve()
  expect(presets.select).not.toHaveBeenCalled()
  emit(sessionId, 'standard')
  await vi.waitFor(() => expect(presets.select).toHaveBeenCalledWith(h.agents.get(sessionId), 'dsh-superagent-worker'))
  // 另一个会话不属于 dsh-superagent。
  presets.select.mockClear()
  emit('someone-else', 'standard'); emit('worker-nothing', 'standard'); await Promise.resolve()
  expect(presets.select).not.toHaveBeenCalled()
  // 首个回合之后，注册表会拒绝任何选择，这不会改变任何内容，也不是错误。
  started.add(h.runtime.masterId)
  emit(h.runtime.masterId, 'standard')
  await vi.waitFor(() => expect(presets.select).toHaveBeenCalledTimes(1))
  await expect(presets.select.mock.results[0]!.value).rejects.toMatchObject({ code: 'agent-preset/locked' })
})

it('gives a subagent of a worker only the worker\'s work tools, and none once the ticket ended', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  // DSH 会在 standard 预设下创建子代理，并以 worker 的会话作为其父级。
  await (h.controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: 'child-1' })
  const child = h.agents.get('child-1')! as unknown as { session: { header: { parentSession?: string } } }
  child.session.header = { parentSession: sessionId }
  await (h.runtime as unknown as { ctx: Context }).ctx.parallel('agent/created', { agent: child } as never)
  expect(h.restricts.get('child-1')).toEqual([{ allow: ['read', 'read_image', 'grep', SHELL, 'job_output', 'job_list', 'job_kill', 'web_search', 'skill'] }])
  expect(h.guards.get('child-1')!()).toBeUndefined()
  h.runtime.engine.stopTicket(ticket.id)
  expect(h.guards.get('child-1')!()).toBe('Ticket ended; new work needs a new authorized ticket')
  // 另一个会话的子代理保持不变。
  await (h.controller.create as (options: { sessionId: string }) => Promise<void>)({ sessionId: 'child-2' })
  const other = h.agents.get('child-2')! as unknown as { session: { header: { parentSession?: string } } }
  other.session.header = { parentSession: 'someone-else' }
  await (h.runtime as unknown as { ctx: Context }).ctx.parallel('agent/created', { agent: other } as never)
  expect(h.restricts.get('child-2')).toBeUndefined()
})

it('gives a subagent of a worker\'s subagent the same work tools and guard', async () => {
  const { ticket, sessionId } = await acceptedTicket()
  const create = h.controller.create as (options: { sessionId: string }) => Promise<void>
  const created = (h.runtime as unknown as { ctx: Context }).ctx
  for (const [id, parent] of [['child-1', sessionId], ['grandchild-1', 'child-1']] as const) {
    await create({ sessionId: id })
    const agent = h.agents.get(id)! as unknown as { session: { header: { parentSession?: string } } }
    agent.session.header = { parentSession: parent }
    await created.parallel('agent/created', { agent } as never)
  }
  expect(h.restricts.get('grandchild-1')).toEqual([{ allow: ['read', 'read_image', 'grep', SHELL, 'job_output', 'job_list', 'job_kill', 'web_search', 'skill'] }])
  h.runtime.engine.stopTicket(ticket.id)
  expect(h.guards.get('grandchild-1')!()).toBe('Ticket ended; new work needs a new authorized ticket')
})

it('ends the main Session\'s prompt with its Policy section, each rule on one line, and says orchestrator_eval holds no rules', async () => {
  const settings = h.runtime.store.settings()
  const rules = settings.policy.rules.map(rule => rule.id === 'copy'
    ? { ...rule, name: 'Copy\nfixes', instruction: 'Fix typos.\n- Keep the tone.\n\n## Not a heading' } : rule)
  await h.runtime.settings.save('policy', { ...settings.policy, rules }, h.runtime.store.blockRevision('policy'), 'panel')
  const prompt = (h.sections.get(h.runtime.masterId)!.text as (context: object) => string)({})
  const policy = prompt.slice(prompt.indexOf('## 策略'))
  // 该部分之后没有任何内容，其头部之后的行恰好是启用的规则。
  expect(policy.trimEnd().split('\n').slice(2)).toEqual(h.runtime.store.settings().policy.rules.filter(rule => rule.enabled)
    .map(rule => rule.id === 'copy' ? '- Copy fixes (copy): Fix typos. - Keep the tone. ## Not a heading' : `- ${rule.name} (${rule.id}): ${rule.instruction}`))
  expect(prompt.indexOf('## 策略')).toBeGreaterThan(prompt.indexOf('执行环境'))
  expect((h.tools.get(h.runtime.masterId)!.get('orchestrator_eval') as unknown as { description: string }).description).not.toMatch(/rules/)
})

it('keeps the Policy the main Session judges by in its prompt, after admission and the rest, as the latest save left it', async () => {
  const prompt = () => (h.sections.get(h.runtime.masterId)!.text as (context: object) => string)({})
  const policy = () => { const text = prompt(), at = text.indexOf('## 策略'); return text.slice(at, text.indexOf('\n\n', at)) }
  const settings = h.runtime.store.settings()
  const line = (rule: { id: string; name: string; instruction: string }) => `- ${rule.name} (${rule.id}): ${rule.instruction}`
  expect(prompt().indexOf('## 策略')).toBeGreaterThan(prompt().indexOf('你自己依据本提示词末尾策略部分中启用的规则评估主动候选'))
  expect(policy().split('\n').filter(item => item.startsWith('- '))).toEqual(settings.policy.rules.filter(rule => rule.enabled).map(line))
  expect(policy()).toContain(`策略版本 ${policyVersion(settings)}；accept 模式 ${settings.eval.mode}。`)
  // 规则只管辖主动候选；与明确请求一起阅读时，不能把它们当作拒绝该请求。
  expect(policy()).toContain('accept 模式和规则只决定主动候选：明确请求按路由部分所述路由，任何模式下且无论规则如何。')
  // 保存会从下一次请求开始改变它：一条规则被禁用，另一条的指令被更改。
  const rules = settings.policy.rules.map(rule => rule.id === 'copy' ? { ...rule, instruction: `${rule.instruction} Keep it short.` } : { ...rule, enabled: false })
  await h.runtime.settings.save('policy', { ...settings.policy, rules }, h.runtime.store.blockRevision('policy'), 'panel')
  const saved = h.runtime.store.settings()
  expect(policy()).toContain(`策略版本 ${policyVersion(saved)}`)
  expect(policy().split('\n').filter(item => item.startsWith('- '))).toEqual(rules.filter(rule => rule.enabled).map(line))
  // 没有启用任何规则时，主动候选只能被忽略。
  await h.runtime.settings.save('policy', { ...saved.policy, rules: rules.map(rule => ({ ...rule, enabled: false })) }, h.runtime.store.blockRevision('policy'), 'panel')
  expect(policy()).toContain('没有启用任何规则：主动候选只能被忽略。')
  expect(policy()).toContain('accept 模式和规则只决定主动候选')
})
