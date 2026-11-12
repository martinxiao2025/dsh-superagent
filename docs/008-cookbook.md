# 008 操作手册

本操作手册说明如何扩展 dsh-superagent。它使用 [001 领域模型](001-domain.md) 和 [002 授权](002-authorization.md) 中的术语，以及 [007 架构](007-architecture.md) 中的组件。

## 新增一个来源

本示例实现一个名为 `webhook` 的来源 kind。它通过一个虚构的 CLI `hookq` 读取虚构的消息队列，并把消息转换为触发器。其他所有接口都是 dsh-superagent 的一部分。

实现有四部分职责：转换事件、定义接收与授权规则、提供回复和上下文，以及维护轮询循环。以下编号步骤按顺序构建这些部分。

示例假设如下 CLI 契约：

- `hookq pull --after <n> --json` 打印位置 `n` 之后的消息，最旧在前：`{"me": "<the agent's id on the queue>", "items": […], "next": <position>}`。条目含 `id`、`conversation`、`thread`（开启其线程的消息 id，该消息本身没有）、含 `id` 和 `bot` 的 `sender`、`mentions_me`、`text`、`at` 和 `url`。
- `hookq reply --conversation <id> --to <message id> --key <key> --text <text>` 在一条消息下回复，每个 key 只回复一次。对话已删除时，它在标准错误上以 `{"error": {"code": 410, "message": "…"}}` 失败。
- `hookq thread --conversation <id> --root <message id> --json`，带 `--after <cursor>` 读取后续页，打印线程的一页，最旧在前：`{"items": […], "next": "<cursor>"}`，最后一页没有 `next`。

把该 kind 与适配器放在 `src/sources/webhook.ts` 中，参照 `src/sources/feishu.ts`（`github.ts` 与 `gitlab.ts` 只是代码仓库类型描述，不是消息来源）。如果来源变大，像飞书来源那样把转换、渠道和轮询代码拆到独立模块。适配器在 `src/sources/adapters.ts` 的内置清单中登记，不需要单独的插件入口。

### 1. 把事件映射到领域

写代码之前先选定稳定的映射。触发器 id、线程 id 和渠道地址会被持久化，因此之后更改它们可能断开已有记录。

| 概念 | 对应 webhook 队列 |
| --- | --- |
| Trigger | 一条消息 |
| Thread | 一个对话中的一条消息及其回复：`<conversation>:<第一条消息的 id>` |
| Actor | 发送者在队列上的 id，允许名单以它指名 |
| 渠道地址 | 回复所在的对话和消息 |
| 接收范围 | 一个对话，在准入表中有自己的行 |

### 2. 配置：架构、字段、事实和健康

模块导入以下步骤使用的内容：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { triggerKey } from './identity.ts'
import type { SourceAdapter, SourceKind } from './kind.ts'
```

```ts
const ConfigSchema = z.object({
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type WebhookConfig = z.infer<typeof ConfigSchema>

export const webhookKind: SourceKind<WebhookConfig> = {
  kind: 'webhook',
  title: { zh: 'Webhook 队列', en: 'Webhook queue' },
  description: { zh: '接收 webhook 队列里下列对话的消息。', en: 'Receives the messages of these conversations from the webhook queue.' },
  schema: ConfigSchema,
  fields: [
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['webhook'],
  // find、scope、channel、threadContext、policy 和 environment 在后续步骤中给出。
}
```

- `kind` 是稳定的类型名。每条来源记录的 ID 才是触发器的 `source`、线程键前缀、`source:<记录 ID>` 设置块和策略部分的键；`kind` 决定使用哪个适配器。
- `schema` 校验记录配置并提供默认值。新增来源时由面板选择类型并提交配置，registry 不会自动创建默认记录；默认值应让记录暂不接收任何内容，本示例默认没有对话。
- `fields` 无需自定义面板代码即可生成来源设置表单。`rows` 字段编辑以其第一列为键的条目；`advanced` 隐藏较少用的设置。如果来源能把 id 解析为显示名称，请实现 `refreshLabels`。把这些名称保存在 `KV.sources.labels(记录 ID)` 下。带 `choose` 和 `refresh` 的列随后可以提供它们。
- 可选的 `facts(deployment)` 显示安装派生的值，例如某个 CLI 背后的账号。安装按每种类型的 `SETUP_FIELDS` 检查记录，本示例不提供事实。
- `health` 声明来源的健康条目，初始为 `starting`。注册会按记录认领每个名称（第一项就是记录 ID，其余为 `<记录 ID>:<名称>`），并拒绝与 `runtime`、`reply`、`worker` 或副作用 kind 等条目冲突。使用该 kind 的名称，并把 `sync:<id>` 留给策略同步。`error` 会让状态脚本以 2 退出，并让每小时检查通知操作者，因此只在可能需要人处理时才报告它。

**记录 ID 即来源身份。** 它出现在所有持久化位置，因此创建后不可更改：

| 位置 | 规则 |
| --- | --- |
| `trigger.source`、`channel.source` | 记录 ID |
| `policy.sources` 键 | 记录 ID |
| 线程键 | `<记录ID>:<类型内后缀>`，例如 `feishu-1:oc_xxx:om_yyy` |
| 触发器去重 ID | `key('<记录ID>-<本地种类>', …)`，天然按记录隔离 |
| KV 键 | `<族名>:<记录ID>:<其余部分>`，按记录独立游标 |
| 健康项 | 首个声明名使用 `<记录ID>`，其余 `<记录ID>:<名称>` |
| 环境变量 | `DSH_SUPERAGENT_SOURCE` 为记录 ID；记录自己的变量沿用适配器声明的名称，工单只注入其来源记录的变量 |

所有身份拼接集中在 `src/sources/identity.ts`（`threadKey`、`triggerKey`、`kvKey`、`healthNames`），禁止在适配器里散落字符串拼接。

### 3. 把消息转换为触发器

转换之前先校验 CLI 响应：

```ts
/** 一条消息，形态与 `hookq pull` 和 `hookq thread` 打印的一致。 */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** `hookq pull` 的答复（其条目逐条读取），以及 `hookq thread` 的答复。 */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })
```

```ts
/** 一条队列消息的触发器；`source` 是产生它的来源记录 ID。智能体自己的消息不产生触发器。 */
export function webhookTrigger(message: QueueMessage, me: string, source: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  const thread = `${message.conversation}:${message.thread ?? message.id}`
  return {
    id: triggerKey(source, 'message', message.id),
    source,
    threads: [{ source, id: thread }],
    actor: { source, id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source, thread: threadKey(source, thread),
      address: { conversation: message.conversation, message: message.id, ...(message.url ? { url: message.url } : {}) } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id },
  }
}
```

- **稳定的 id。** 用 `triggerKey(记录 ID, …)` 从队列 id 派生触发器 id。对已存储的 id，`Engine.receive` 返回 `duplicate`，重复接受只创建一个工单。因此重复读取消息是安全的。若要把编辑视为新事件，请在 id 中包含编辑版本，就像 GitHub 对评论 `updated_at` 所做的那样。
- **线程。** 第一个线程是主线程，拥有评估。其他线程补充关联上下文。来源选择 id；其完整键由 `threadKey` 生成，即 `<记录 ID>:<id>`。
- **发送者。** 在 `actor` 中使用来源原生 id。对机器人和 CI 设置 `human: false`。名单中的机器人只能成为推断候选。空的 actor id（如 CI）使用针对未列入名单、未对智能体说话的发送者的准入单元格。只有当消息确实对智能体说话时，才把 `addressed` 设为 `mention` 或 `direct`；这会让允许名单上的人的消息具有明确强度。绝不为智能体自己的消息产生触发器。
- **回复目的地与元数据。** `channel` 指明回复的去处；`url` 链接到来源消息。`channel.thread` 对消息分组以便按序投递：工单较晚的消息会等待较早的消息，直到较早消息连续失败三次。其他工单不等待。把来源特有字段放在 `meta` 中，例如接收对话和线程根。`meta` 和 `text` 都是不可信数据，不是授权。

智能体可以通过 `orchestrator_read trigger/<id>` 和 `thread/<key>` 读取新的 kind。它们暴露消息文本、去向和相邻触发器。新的 kind 不会自动获得内置技能、原始服务记录的资源或拉取请求绑定。

文本搜索无需额外代码即可工作。当人们使用来源特有的引用（例如消息 id、URL 或 `#12`）时，请实现 `find(query)`。返回这些引用所标识的线程键和搜索词：

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

这里查询中的队列消息 id（例如 `m42`）会在触发器中进行搜索。

### 4. 来源接收什么：范围

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

Engine 对每个到达的触发器通过 `SourceRegistry` 调用 `scope`。范围之外的消息连同其理由存储为已过滤，不创建线程。请把消息传给 `receive`，而不是在轮询循环中静默丢弃，这样面板可以解释过滤。

`observed: true` 表示来源在该范围内接收未对智能体说话的消息，允许对它们使用准入表决定。`row` 标识对应的准入行。

重新校验会用授权中存储的元数据调用 `scope`。让它只依赖 `meta` 和配置。恢复需要 `listened`，而不是 `observed`。没有 `scope` 时，kind 接收它产生的每个触发器，但不观察任何内容。

### 5. 回复：渠道

```ts
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendWebhook,
    link: address => ({ url: address.url ?? '',
      label: { zh: `Webhook 对话 ${address.conversation}`, en: `Webhook conversation ${address.conversation}` } }),
  },
```

```ts
export async function sendWebhook(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing webhook reply target')
  try {
    await host.commands.run('hookq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id,
      '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
```

- **幂等发送。** Outbox 调用 `SourceRegistry.send`，后者调用 `channel.send`。记录不存在或类型未登记时消息等待。远程服务可能已收到消息但发送仍失败，因此重试绝不能重复消息。把 `message.id` 用作幂等键：`hookq` 支持 `--key`；GitHub 存储一个隐藏的评论标记；飞书接受幂等键。
- **永久失败与可重试失败。** 成功时返回 `sent`，只在投递永久不可能时返回 `gone`，例如示例中的 410。已消失的消息保留为已丢弃，永不再次入队；它出现在 `GET sources` 和来源页面上。其他失败请抛出，Outbox 会在 5 秒后重试，翻倍至 300 秒。`CliError.code` 是 CLI 输出报告的错误码。
- **允许的目的地。** `allowed(address, config)` 只检查已保存的地址和当前配置。把每个必需事实放进地址；例如飞书会记录对话是否为私信。不再被监听的目的地会被丢弃，而关闭的来源会让消息等待。没有 `allowed` 时，来源启用期间所有地址都允许。
- **链接。** `link(address, links)` 返回面板通过 `SourceRegistry.link` 显示的 URL 和标签。

### 6. 评估所需的线程上下文

```ts
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // 队列线程是扁平的：其根，以及一条回复所答复的消息，都在第一页，与 GitHub 相同。
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
```

主动评估需要触发器周围的对话。`orchestrator_eval` 读取初始窗口；`orchestrator_eval_read` 展开页面、根或父消息。实现可选的 `threadContext` 接口以提供这些读取：

- `read(commands, trigger, part, cursor, config)` 返回一个 `ContextPart`。其 `messages` 使用 `ContextMessage`：`{id, from, at, text}` 以及适用的 `bot`、`deleted`、`reply_to`、`url`、`path` 和 `line` 字段。最后一页省略 `next`。`body` 是展示给评估会话的内容，这里是相同的消息。可选的 `status` 可以描述特殊结果，例如飞书的 `chat_neighbours`。`part` 是 `thread`、`root` 或 `parent`。
- `messageId(trigger)` 在其中找到触发器自己的消息。
- `images(text)` 和 `image(…)` 用于消息携带图片的 kind，例如飞书；本示例省略它们。

没有 `threadContext` 的 kind 不会给评估提供线程上下文；触发器自己的文本仍可读取。

如果消息回复更早的消息，请添加 `repliesTo(trigger)`。它返回对应的触发器 id，使跟进通知和执行器输入在已存储时能显示被回复的消息。例如，如果 `hookq` 提供 `reply_to`，转换把它存储为 `meta.replyTo`：

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? triggerKey(trigger.source, 'message', trigger.meta.replyTo) : undefined,
```

### 7. 谁能发起工作：策略中的来源部分

```ts
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @ 智能体。', en: 'Someone on the list mentions the agent in a message.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
```

- `schema` 校验来源策略，包括 `allowed` 发送者 id。id 比较不区分大小写。准入表单独校验，并在各 kind 之间共享。该策略部分保存在 `policy.sources.<记录 ID>`，并参与策略版本。
- `fields` 在 **评估 → 各来源** 下生成表单，从 `allowed` 开始。`explicit` 说明如何对智能体说话。可选的 `unnamed: {person, bot}` 为不透明 id（例如飞书的 `ou_…`）提供显示标签；本示例因为队列 id 就是可读名称而省略它。
- `rows(config)` 列出准入范围及其可用单元格。每个行 id 必须与 `scope` 返回的 `row` 匹配。未对智能体说话的消息单元格只在来源观察这些消息的地方可用。没有 `rows` 的 kind 使用默认单元格。
- 可选的 `bots` 列出有资格成为推断候选的机器人，条目形态与 `allowed` 相同。没有它时，不接纳任何机器人。
- 可选的 `sync: {label, ready(part), run(host, part, signal)}` 在启动时和 **立即同步** 时刷新成员关系。飞书使用群成员关系。失败显示在 `sync:<id>` 下，一分钟后重试，翻倍至一小时，直到成功。

### 8. 执行器的变量

```ts
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEBHOOK_CONVERSATION', description: {
      zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空',
      en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ source, trigger }) => ({
      DSH_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === source?.id ? String(trigger.meta.conversation ?? '') : '' }),
  },
```

执行设置会在准备命令旁显示已声明的 `variables`，即使来源已关闭。来源启用期间，`values` 使用记录、配置和起始触发器提供工单专属的值。

准备命令读取环境变量；执行器在其指令中读取它们的值。变量名沿用 `DSH_SUPERAGENT_<KIND>_…` 形式，同一类型的多条记录共用一套名称，但运行时只注入工单来源记录的值；对来自其他记录的工单返回空值，绝不要包含凭据。

### 9. 适配器及其循环

```ts
export const webhookAdapter: SourceAdapter<WebhookConfig> = {
  kind: webhookKind,
  async watch(host, id, signal) {
    const ctx = sourceContext(host, webhookKind, id)
    // DSH 遇到未处理的 rejection 会结束进程，因此逃出循环的失败会成为该记录的健康状态。
    try { await watch(ctx, signal) }
    catch (error) { ctx.report('webhook', { state: 'error', detail: String(error) }) }
  },
}
```

适配器由主插件加载，`watch` 为每条已启用的记录调用一次，`id` 是记录 ID。`sourceContext(host, kind, id)` 把 registry、部署、命令与健康项收窄到该记录；停用、删除或应用停止会中止 `signal`，循环退出。

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // 安装解析账号后会重启 dsh-superagent；在那之前来源不读取任何内容。
  if (!ctx.configured()) { ctx.report('webhook', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WebhookConfig>()
    if (!config) ctx.report('webhook', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('webhook', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // 一次网络失败会在下一轮重试；连续三次才需要人处理。
        if (!signal.aborted && failures >= 3) {
          ctx.report('webhook', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** 读取游标之后的队列，接收每条消息，然后把游标移到它们之后。 */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.webhook.cursor(ctx.id)) ?? 0
  const output = await ctx.commands.withSignal(signal).run('hookq', ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The webhook Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = webhookTrigger(message.data, page.me, ctx.id)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref.source, ref.id), { facts: { conversation } })
  }
  ctx.state.set(KV.webhook.cursor(ctx.id), page.next)
  return { read: page.items.length, unreadable }
}
```


- **安装与开关。** 等待 `ctx.ready`，在 `ctx.configured()` 为 false 时不读取任何内容。每轮都读取 `ctx.config<WebhookConfig>()`：记录停用或配置无效时它为 undefined。
- **游标。** 使用 `KV`（`src/kv.ts`）中带类型的条目把读取位置存入 `ctx.state`，并按记录 ID 分键，例如 `webhook: {cursor: family<number, [record: string]>('webhook-cursor:')}`。`tests/store.spec.ts` 要求键字面量只出现在该注册表中。外部包可以用导出的 `record` 和 `family` 定义键。把值设为 `undefined` 会删除记录；`ctx.atomic` 把写入分组到一个事务中。

  只有在覆盖的触发器全部存储后，才推进游标。被中断的一轮保持游标不变；稳定的 id 使重放安全。对于时间戳游标，`src/sources/poll.ts` 中的 `cursorAt(started)` 会减去五秒，以容纳远程写入的延迟。
- **线程元数据。** 接收触发器后，调用 `ctx.threads.describe(key, {label, url, facts})` 填充其显示信息。`ctx.threads.patch(key, meta)` 委托给 `threads.patchMeta`，设置来源拥有的键，或在值为 `undefined` 时移除它们。两者都会忽略不存在的线程，包括已过滤触发器的线程。
- **逐项错误。** 统计格式错误的条目并继续，而不是让整批失败。`src/infra/commands.ts` 中的 `validItems(item, list, tally)` 支持这种模式。对于独立轮询的线程，使用 `src/sources/poll.ts` 中的 `pollThreads`；它把每个失败记录为 `pollError`。其 `polled` 谓词保留存活订阅，以及最后一次触发器与工单结束两者中较晚者之后的两周窗口。
- **健康。** 只通过 `ctx.report` 写已声明的条目。`health(state, code, values)` 提供固定消息，例如 `setupPending`、`sourceOff` 和 `pollFailures`。报告 `error` 之前先统计连续失败。
- **中止。** 把信号传给 `ctx.commands.withSignal(signal)` 和 `delay`，并在条目之间检查它，以便停止或重启时立即结束循环。

本示例不发送来源发起的通知。需要它们的来源调用 `ctx.notify`；Outbox 像其他回复一样投递它们。

它也不把线程绑定到工单完成。只有当来源的线程生命周期决定工作是否完成时（例如 GitHub 拉取请求），才使用 `ctx.tickets.bindThread` 和 `threadClosed`。工单何时结束仍由 Engine 决定。

### 10. 登记适配器

在 `src/sources/adapters.ts` 的内置清单中加入适配器：

```ts
import { feishuAdapter } from './feishu.ts'
import { webhookAdapter } from './webhook.ts'

export const ADAPTERS: readonly SourceAdapter[] = [feishuAdapter, webhookAdapter]
```

主插件在启动后为每条已存储的来源记录运行其适配器。没有 `tsdown` 入口、没有 `package.json` 子路径导出、没有 `cordis.patch.yml` 条目，也没有 profile 开关。构建并重启后，在面板的 **来源 → 新增来源** 中选择该类型创建记录；记录会出现在来源设置中，以及 **评估 → 各来源** 下。

把其模块和测试规格加入 [007 架构](007-architecture.md) 的模块表和测试表。`tests/docs.spec.ts` 会检查两个索引是否完整。

### 11. 测试

按照 `tests/sources.spec.ts` 的模式创建 `tests/webhook.spec.ts`：临时目录中的真实 Store、带 `HealthBoard` 的 `SourceRegistry`、带替身端口的 Engine，以及由 `sourceContextOf` 得到的 `SourceContext`。

通过监视 `Commands.run` 模拟 CLI 调用。还要监视 `withSignal`，因为它通常返回新的 `Commands` 实例。

```ts
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'webhook-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { webhook: { kind: 'webhook', enabled: true, config: { conversations: [{ id: 'ops', listen: 'mentions' }] } } },
    policy: { sources: { webhook: { allowed: [{ id: 'alice' }] } } },
  }))
  // registry 在 board 上认领该 kind 的健康条目，测试从这里读取它们。
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webhookKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // 来源自己的通知进入 outbox，后者保留其回执，在这里不发送任何内容。
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, webhookKind, 'webhook') }
}
/** `hookq` 答复的队列内容。 */
function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer()))
}

it('takes in what the queue holds after the cursor, once, and moves the cursor after it', async () => {
  const h = host()
  queue(h, () => ({ me: 'agent', items: [message('m1'), { id: 'broken' }, message('m2', { conversation: 'elsewhere' })], next: 3 }))
  expect(await pollQueue(h.ctx, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
  expect(await h.receive.mock.results[0]!.value).toBe('stored')
  expect(await h.receive.mock.results[1]!.value).toBe('filtered')
  expect(h.store.get(KV.webhook.cursor('webhook'))).toBe(3)
  // 名单上的发送者 @ 智能体，构成明确请求。
  expect(h.engine.candidate(triggerKey('webhook', 'message', 'm1'))?.strength).toBe('explicit')
  await pollQueue(h.ctx, new AbortController().signal)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})
```

`message(id, fields)` 构造一个队列条目。至少覆盖：

- 转换：稳定的 id、线程、行动者、`human` 和 `addressed`，以及智能体自己的消息不产生触发器；
- 一轮：触发器只存储一次，一个范围之外的被 `filtered`，游标移到它们之后，名单上发送者的 @ 被评估为 `explicit`；
- 被提前中断的一轮，其游标保持不变；
- `send`：`sent`、只在 410 时返回 `gone`，其他任何失败都抛出，CLI 的错误由 `commandError` 构造；
- 线程上下文：一页的消息和下一页的游标，如同 `tests/registry.spec.ts` 通过 `SourceRegistry.threadContext` 读取某个 kind 的线程；
- 适配器：`watch` 为每条记录建立上下文，安装等待期间报告 `setupPending`，逃出循环的失败成为该记录的健康状态而不是未处理的 rejection；停用、删除或应用停止会中止信号；
- 策略中的来源部分及其准入行，如同 `tests/registry.spec.ts` 和 `tests/policy.spec.ts` 检查飞书来源那样。

### 检查清单

1. 映射触发器、线程、行动者、渠道地址和接收范围。
2. 编写 kind：`schema`、`fields`、`health`，以及安装会派生值时所需的 `facts`。
3. 用稳定的 id 把事件转换为触发器，并丢弃智能体自己的消息。
4. 在 `scope` 中仅依据 `meta` 决定来源接收什么。
5. 提供渠道，其 `send` 对每条消息只发布一次，并且只在对话永远无法接收时答复 `gone`。
6. 如果来源能读取线程，为评估提供其线程上下文。
7. 提供策略中的来源部分，含 `allowed` 和准入行。
8. 注册其执行环境变量。
9. 编写适配器和循环：等待安装、跟随开关、在 `receive` 之后移动游标（按记录 ID 分键）、逐项保留错误、报告健康并在中止时停止；在 `adapters.ts` 中登记；
10. 在 `src/sources/adapters.ts` 登记适配器，并在 007 的表格中列出该模块及其测试规格。
11. 像 `tests/sources.spec.ts` 测试其他来源那样测试它。
