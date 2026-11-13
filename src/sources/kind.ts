/** SourceKind 插件契约：配置 schema、UI 表单字段、策略集成、频道适配器和线程上下文读取器。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { z } from 'zod'
import type { OutboundMessage, ScopeResult, Trigger } from '../core/index.ts'
import type { ResolvedFeishuSource, ResolvedGithubSource, ResolvedGitlabSource, ResolvedSource } from '../deployment.ts'
import type { FieldSpec, Localized } from '../fields.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceContext, SourceHost } from './host.ts'

export interface VariableSpec { key: string; description: Localized }
export interface EnvironmentInput<C> { source: ResolvedSource | undefined; config: C; trigger?: Trigger }
export interface AdmissionRowView { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }
/** 来源种类的策略扩展，定义允许的发送者、接收表行以及可选的外部名单同步。 */
export interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** 校验策略中属于来源的部分，包括 `allowed`（可以发起工作的发送者）。 */
  schema: z.ZodType<P>
  /** 策略部分的表单字段；第一个是 `allowed`。 */
  fields: FieldSpec[]
  /** 描述来源把什么标记为已向智能体提出，允许的发送者的明确请求需要它。 */
  explicit: Localized
  /** 原始发送者 ID 不可读时，名单外的人类或机器人发送者的兜底显示标签。 */
  unnamed?: { person: Localized; bot: Localized }
  /** `config` 下策略接收表的接收范围（与 `scope().row` 对应）；没有 `rows` 的种类使用接收表的默认值。 */
  rows?(config: Record<string, unknown>): AdmissionRowView[]
  /** 可选的外部名单同步（例如群成员）；`ready` 报告 `part` 是否指定了要刷新的目标。 */
  sync?: { label: Localized; ready(part: P): boolean; run(host: SourceHost, id: string, part: P, signal: AbortSignal): Promise<P> }
}
/** 频道地址的 UI 链接；`triggerId` 指定触发器，在可用时优先使用它自己的深链。 */
export interface ChannelLink { url: string; label: Localized; triggerId?: string }
export type ChannelLinks = { github?: ResolvedGithubSource; feishu?: ResolvedFeishuSource; gitlab?: ResolvedGitlabSource }
/** 来源种类的线程所用的出站消息适配器。 */
export interface SourceChannel<C> {
  /** 回复是否仍可发往 `address`；没有它时，任何地址都可以收到回复。 */
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * 按 ID 幂等地发送消息；目标会话不再接受回复时返回 `'gone'`。
   * @throws 投递失败但稍后重试可能成功时抛出。
   */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>
  /** 返回 `address` 的 URL 和标签；当 `links` 缺少所需的部署信息时 `url` 为空。 */
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink
}
/** 线程上下文读取器返回的规范化消息；`bot` 标记非人类发送者，其消息本身永远不能授权工作（最多是推断的候选）。 */
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number
}
export type ContextPartName = 'thread' | 'root' | 'parent'
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }
/** 评估用于检查触发器周围消息和图片的有界线程上下文读取器。 */
export interface ThreadContext<C> {
  /** 触发器的消息在其线程消息中的 ID。 */
  messageId(trigger: Trigger): string
  /** 读取一页线程消息（`thread`，省略 `cursor` 时为第一页）、话题根消息（`root`）或被回复的消息（`parent`）。 */
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
  /** 从 `image` 可读取的消息文本中提取图片键；不支持图片的种类省略此项。 */
  images?(text: string): string[]
  /** 把触发器线程中某条消息的一张图片读取为 `agent` 的附件。 */
  image?(agent: Agent, commands: Commands, trigger: Trigger, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
export interface TriggerContext {
  readonly messageId: string
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>
  images(text: string): string[]
  /** @throws 对不支持图片的种类抛出。 */
  image(agent: Agent, commands: Commands, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
/** 注册到 SourceRegistry 的可插拔来源种类描述符。 */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** 稳定 ID；来源记录按这个值选择适配器。 */
  kind: string
  title: Localized
  description: Localized
  /** 由记录解析出的来源派生的只读状态事实（记录尚未解析时为 undefined），按字段键索引。 */
  facts?(source: ResolvedSource | undefined): Record<string, Localized | string>
  /** 校验已存储和提交的配置并填充默认值。 */
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** 此种类在健康面板上声明的条目名；第一条以来源记录 ID 命名，其余为 `<记录ID>:<条目名>`。 */
  health: string[]
  /** 此种类触发器（或记录的 Mandate 依据）的监听规则；没有 `scope` 的种类监听它产生的一切，且不观察其中任何内容。 */
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  /** 出站回复适配器；没有 `channel` 的种类不产生回复或频道检查。 */
  channel?: SourceChannel<C>
  /** 评估用的有界上下文读取器；没有 `threadContext` 的种类的评估不读取任何内容。 */
  threadContext?: ThreadContext<C>
  /** 把搜索查询映射为一条来源记录的候选线程键（例如 `github:12`）和触发器搜索词（例如飞书 `om_` ID）。 */
  find?(instance: SourceInstance, query: string): { threads: string[]; terms: string[] }
  /** 在不进行网络读取即可推导时，返回此触发器所回复消息的触发器 ID。 */
  repliesTo?(trigger: Trigger): string | undefined
  /** 发送者拥有自身身份的种类所用的策略部分。 */
  policy?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  /** 重新读取行键的显示名（例如群名），把解析出的名字存到 `KV.sources.labels(id)` 并返回。 */
  refreshLabels?(host: SourceHost, id: string, signal?: AbortSignal): Promise<Record<string, string>>
  /** 此种类注册到执行环境中的变量及其值的计算方式。 */
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
}

export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; name: string; enabled: boolean; config: C }

/** 内置适配器：种类描述符与按来源记录运行的轮询循环。 */
export interface SourceAdapter<C extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: SourceKind<C>
  /** 为记录 `id` 运行循环，直到 `signal` 中止；循环内的失败报告为该记录的健康状态，不会向外抛出。 */
  watch(host: SourceHost, id: string, signal: AbortSignal): Promise<void>
}
