/** 暴露给每种来源的范围化运行时上下文，使来源与 Store 或 Engine 的直接访问相隔离。 */
import type { EngineForSources, ReceiveResult, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Commands } from '../infra/commands.ts'
import type { SetupProblem } from '../setup.ts'
import type { SourceContext } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'

export interface SourceContextDeps {
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'threads' | 'tickets' | 'triggers' | 'read'>
  readonly outbox: Pick<Outbox, 'send'>
  readonly engine: Pick<EngineForSources, 'bindThread' | 'threadClosed'>
  /** 应用状态目录；需要自有工作目录的来源使用它。 */
  readonly stateDir: string
  readonly commands: Commands
  readonly sources: SourceRegistry
  /** 在初始初始化完成之前访问会抛出异常。 */
  readonly deployment: Deployment
  readonly ready: Promise<void>
  configured(): boolean
  /** 按记录 ID 索引的初始化问题；`context.problem` 取本记录的那一项。 */
  readonly sourceProblems?: Readonly<Record<string, SetupProblem>> | undefined
  /** 将触发器交给引擎，并安排对其进行评估的轮次。 */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
}

/**
 * 为一条来源记录构建上下文。健康报告仅限于该记录声明的条目，
 * 并绑定到活动注册；一旦取消注册即成为空操作。
 */
export function sourceContextOf(deps: SourceContextDeps, kind: { kind: string; health: readonly string[] }, id: string): SourceContext {
  const { store } = deps
  const health = deps.sources.healthEntries(id, kind)
  return {
    id,
    get deployment() { return deps.deployment },
    get source() { return deps.deployment.sources[id] },
    commands: deps.commands.scope(id),
    stateDir: deps.stateDir,
    ready: deps.ready,
    configured: () => deps.configured(),
    get problem() { return deps.sourceProblems?.[id] },
    config: <C extends Record<string, unknown>>() => {
      const instance = deps.sources.instance<C>(id)
      return instance?.enabled ? instance.config : undefined
    },
    receive: trigger => deps.receive(trigger),
    atomic: work => store.atomic(work),
    state: {
      get: name => store.get(name),
      set: (name, value) => { if (value === undefined) store.delete(name); else store.set(name, value) },
      keys: prefix => store.keys(prefix),
    },
    threads: {
      get: key => store.threads.get(key),
      subscribed: source => store.read.subscribedThreads(source),
      describe: (key, description) => store.threads.describe(key, description),
      patch: (key, meta) => { store.threads.patchMeta(key, meta) },
    },
    tickets: {
      get: id => store.tickets.get(id),
      open: () => store.tickets.open(),
      bindThread: (id, thread, own) => { deps.engine.bindThread(id, thread, own) },
      threadClosed: (thread, outcome, at) => { deps.engine.threadClosed(thread, outcome, at) },
    },
    triggers: { get: id => store.triggers.get(id), latest: thread => store.read.threadTriggers(thread, 1)[0] },
    notify: message => { deps.outbox.send(message) },
    report: (entry, value) => {
      if (!kind.health.includes(entry)) throw new Error(`The ${kind.kind} Source has no health entry ${entry}`)
      health.get(entry)?.set(value)
    },
  }
}
