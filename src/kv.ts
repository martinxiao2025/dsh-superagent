/**
 * 类型化的键值存储键，以及按拥有并写入各族的单一组件分组的键族。
 * 读写方通过这里的条目引用记录，使每个键只以带值类型的形式拼写一次。
 */
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
/** 值为类型 `V` 的 KV 记录的键；普通字符串表示无类型的键。 */
export type Key<V> = string & { readonly __value?: V }
/** 共享前缀的 KV 记录族：可调用以由名称各部分构建键，并暴露用于列举的 `prefix`。 */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** 定义单个类型化 KV 键；外部来源插件用 `record` 和 `family` 为自己的键指定类型。 */
export const record = <V>(key: string) => key as Key<V>
/** 定义 KV 键族，其键以 `:`（或自定义 `format`）连接 `prefix` 和名称各部分。 */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** 存储：当前数据库 schema 版本。 */
  store: { schema: record<number>('schema') },
  /** 设置：当前修订号、按块的修订号，以及已保存的设置快照（包括当前快照）。 */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** 提示词：当前修订号和已保存的提示词版本。 */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** 被覆盖编辑过的提示词部件的内置文本，按 `base` 存放，用于显示升级带来的变化。 */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** 运行时：主会话的 ID。 */
  runtime: { masterId: record<string>('master-id') },
  /** 会话：每个会话工作过的提示词修订号，按从旧到新排列；最后一项（`.at(-1)`）是其活动修订号。 */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 迁移：导入到效果表中的遗留主会话队列。 */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** 按来源解析的显示名称，把有名称的 ID（例如飞书会话 ID）映射到其显示名称。 */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * 飞书来源：按记录记录已知会话（私聊为 `true`）；按记录与会话记录的历史游标，以及把话题 ID 映射到最近可见时间戳的活动话题；
   * 以及按轮询线程记录的已见消息 ID 和初始化标记（线程键已含记录）。
   */
  feishu: { chats: family<Record<string, boolean>, [record: string]>('feishu-chats:'),
    history: family<string, [record: string, chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [record: string, chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
}
