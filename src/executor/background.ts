/**
 * 工作单元在 DSH 中的后台工作：其会话拥有的 shell 作业（`ctx.jobs`）及其子智能体（`ctx.subagents`）。
 * 它们在回合结束后仍让工作单元保持忙碌，并随其任务分配一起停止。两者都没有的配置则一无所有。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 执行器使用 DSH 作业登记表的部分：会话可见的作业、它们的事件、对单个作业的等待和终止。 */
interface Jobs {
  list(caller: string): readonly { id: string; owner?: string; status: string; label?: string }[]
  wait(id: string, timeoutMs: number, caller: string, signal?: AbortSignal): Promise<{ status: string }>
  kill(id: string, caller: string, reason?: string): unknown
  readonly events: { subscribe(filter: { owner: string }, listener: (event: { type: string }) => void): () => void }
}
/** 执行器使用 DSH 子智能体的部分：等待工作单元的子智能体完成、列出其子智能体，以及释放它们。 */
interface Subagents {
  waitForChildren(parent: Agent): Promise<boolean>
  listChildren(parentSessionId: string): Promise<readonly { id: string }[]>
  drainChildren(parent: Agent, childIds: readonly string[]): Promise<void>
}
/** 停止时等待被终止作业结束的时长，并收集其结束事件，以免工作单元被唤醒去听它。 */
const KILL_WAIT_MS = 10_000
/** 释放子智能体可能耗费的时长；它会拖住关闭流程，因此 DSH 自己的调用方也会对其设限。 */
const DRAIN_LIMIT_MS = 10_000
/** 一次收集作业结束的等待运行时长；若结束时作业仍在运行，则由下一次等待接续。 */
const COLLECT_WAIT_MS = 10 * 60_000

const registry = (ctx: Context): Jobs | undefined => ctx.get('jobs') as Jobs | undefined
const subagentsOf = (ctx: Context): Subagents | undefined => ctx.get('subagents') as Subagents | undefined
const running = (status: string) => status === 'running' || status === 'stopping'
/** 会话拥有的正在运行的作业，`except` 中的除外（例如留给人的那些）。 */
const owned = (jobs: Jobs, sessionId: string, except?: ReadonlySet<string>) =>
  jobs.list(sessionId).filter(job => job.owner === sessionId && running(job.status) && !except?.has(job.id))
/** `work`，或在 `signal` 中止或先超过 `ms` 时为 false。 */
export function until<T>(work: Promise<T>, signal?: AbortSignal, ms?: number): Promise<T | false> {
  if (signal?.aborted) return Promise.resolve(false)
  let stop!: () => void
  const stopped = new Promise<false>(resolve => { stop = () => { resolve(false) } })
  signal?.addEventListener('abort', stop, { once: true })
  const timer = ms === undefined ? undefined : setTimeout(stop, ms)
  timer?.unref?.()
  return Promise.race([work, stopped]).finally(() => { signal?.removeEventListener('abort', stop); clearTimeout(timer) })
}
/** 其子智能体被停止操作取消的回合所属的工作单元；它们的下一次空闲会结束那个回合，而不是它们自己的回合。 */
export const cancelled = new WeakSet<Agent>()
/** 每个工作单元子智能体待完成的汇合；DSH 无法取消它，因此后续的查看会汇合到同一个。 */
const joins = new WeakMap<Agent, Promise<boolean>>()
function childrenEnd(subagents: Subagents, agent: Agent): Promise<boolean> {
  let join = joins.get(agent)
  if (!join) {
    join = subagents.waitForChildren(agent).finally(() => { joins.delete(agent) })
    joins.set(agent, join)
  }
  return join
}

/** 按 id 和标签首行标识的作业。 */
const named = (job: { id: string; label?: string }) => { const line = job.label?.split('\n')[0]?.trim(); return line ? `${job.id} (${line})` : job.id }
/** 会话拥有的仍在运行的 shell 作业（`except` 中的除外）及其名称。 */
export const runningJobs = (ctx: Context, sessionId: string, except?: ReadonlySet<string>): { id: string; name: string }[] => {
  const jobs = registry(ctx)
  return jobs ? owned(jobs, sessionId, except).map(job => ({ id: job.id, name: named(job) })) : []
}

/**
 * 等待会话拥有的 shell 作业全部结束；若原本没有作业运行，或 `signal` 先中止，则立即返回 false。
 * 该等待不是任何作业的等待者，因此每个作业的结束仍会送达工作单元。
 */
function jobsEnd(ctx: Context, sessionId: string, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  const jobs = registry(ctx)
  if (!jobs || !owned(jobs, sessionId, except).length) return Promise.resolve(false)
  return new Promise(resolve => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true; unsubscribe(); signal.removeEventListener('abort', aborted); resolve(value)
    }
    const aborted = () => { done(false) }
    // 只有结束事件才会让所有作业停止运行；作业的输出不会。
    const unsubscribe = jobs.events.subscribe({ owner: sessionId }, event => {
      if ((event.type === 'settled' || event.type === 'removed') && !owned(jobs, sessionId, except).length) done(true)
    })
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

/**
 * 等待进入空闲的工作单元再无任何运行：其 shell 作业（`except` 中的除外）及其子智能体。作业或子智能体的结束会带着结果
 * 唤醒工作单元，从而结束本次查看：它启动的回合会以自己的空闲结束，再重新查看。
 * @returns 当上述全部结束时工作单元处于空闲则为 true；当工作单元重新运行，或 `signal` 先中止时（例如宿主停止或查看超时）为 false。
 */
export async function untilQuiet(ctx: Context, agent: Agent, signal: AbortSignal, except?: ReadonlySet<string>): Promise<boolean> {
  for (;;) {
    const subagents = subagentsOf(ctx)
    const children = subagents ? await until(childrenEnd(subagents, agent), signal) : false
    const jobs = await jobsEnd(ctx, agent.id, signal, except)
    if (signal.aborted || agent.status !== 'idle') return false
    if (!children && !jobs) return true
  }
}

/**
 * 终止会话拥有的 shell 作业（`except` 中的除外），并收集每次结束事件，以免工作单元被唤醒去听它。
 * 单个失败不会阻止其他作业终止。
 */
export async function killJobs(ctx: Context, sessionId: string, reason: string, except?: ReadonlySet<string>): Promise<void> {
  const jobs = registry(ctx)
  const live = jobs ? owned(jobs, sessionId, except) : []
  const failures: unknown[] = []
  // 等待先于终止启动，因此每次结束都会被计为已收集。
  const collected = live.map(job => jobs!.wait(job.id, KILL_WAIT_MS, sessionId).catch(() => undefined))
  for (const job of live) try { jobs!.kill(job.id, sessionId, reason) } catch (error) { failures.push(error) }
  await Promise.all(collected)
  if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`)
}

/**
 * 收集会话拥有的某个 shell 作业的结束，使其不唤醒任何人，直到 `signal` 中止。
 * @returns 作业结束时返回其名称和状态；`signal` 先中止时返回 undefined。
 */
export async function collectJob(ctx: Context, sessionId: string, job: { id: string; name: string }, signal: AbortSignal):
  Promise<{ name: string; status: string } | undefined> {
  const jobs = registry(ctx)
  while (jobs && !signal.aborted) {
    const view = await jobs.wait(job.id, COLLECT_WAIT_MS, sessionId, signal).catch(() => undefined)
    if (!view) return undefined
    if (!running(view.status)) return { name: job.name, status: view.status }
  }
  return undefined
}

/**
 * 在限定时间内释放工作单元仍在运行的子智能体。DSH 会在释放返回前把每个子智能体的结束送达工作单元并唤醒它，
 * 因此随后取消工作单元的回合，在 `keepInbox` 时保留其收件箱，停止便以该回合的结束收尾。其会话仍可接纳子智能体。
 */
export async function stopSubagents(ctx: Context, agent: Agent, keepInbox = false): Promise<void> {
  const subagents = subagentsOf(ctx)
  if (!subagents) return
  // 目录列出了会话曾有过的全部子智能体；已结束的子智能体没有对应的 agent。
  const live = (await subagents.listChildren(agent.id)).map(child => child.id).filter(id => ctx.agents.get(id as SessionId))
  if (!live.length) return
  try { await until(subagents.drainChildren(agent, live), undefined, DRAIN_LIMIT_MS) }
  finally {
    if (agent.status !== 'idle') cancelled.add(agent)
    agent.cancel({ kind: 'user' }, { keepInbox })
    await until(agent.whenIdle(), undefined, DRAIN_LIMIT_MS)
  }
}

/**
 * 任务分配结束时，停止工作单元在后台运行的内容：终止其 shell 作业并释放其子智能体（参见
 * `stopSubagents`）。未加载的会话没有在工作的子智能体。单个失败不会阻止其他停止操作。
 */
export async function stopBackground(ctx: Context, sessionId: string, reason: string, keepInbox = false): Promise<void> {
  const failures: unknown[] = []
  await killJobs(ctx, sessionId, reason).catch((error: unknown) => { failures.push(error) })
  const agent = ctx.agents.get(sessionId as SessionId)
  if (agent) await stopSubagents(ctx, agent, keepInbox).catch((error: unknown) => { failures.push(error) })
  if (failures.length) throw new AggregateError(failures, `Stopping the background work of ${sessionId} failed`)
}
