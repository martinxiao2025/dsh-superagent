/** 结构化的启动和配置错误，附带运维者可用于修复问题的设置位置；以及来源、代码仓库与任务来源预检共享的结果构造与字段分派骨架。 */
import { z } from 'zod'
import { LIMITS } from './limits.ts'
import { fill } from './infra/text.ts'

/** 问题所在位置：`deployment` 表示机器级初始化，其他值是来源记录 ID。 */
export type SetupPlace = 'deployment' | (string & {})
export const SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  gitTooOld: ['deployment', 'git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.'],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  feishuCliUnset: ['feishu', 'The Feishu Source has no bot lark-cli.'],
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
  gitlabProjectUnset: ['gitlab', 'The GitLab Source names no project.'],
  gitlabCliUnset: ['gitlab', 'The agent GitLab CLI is not set.'],
  gitlabCliMissing: ['gitlab', 'The agent GitLab CLI was not found.'],
  gitlabCliSignedOut: ['gitlab', 'The agent GitLab CLI cannot read its account.'],
  gitlabNoAccount: ['gitlab', 'The agent GitLab CLI did not report a GitLab account.'],
  gitlabProjectUnreadable: ['gitlab', '@{account} cannot read {project} on GitLab.'],
  gitlabProjectUnreported: ['gitlab', 'The agent GitLab CLI did not return {project}.'],
  gitlabReadOnly: ['gitlab', '@{account} needs Developer access to {project} on GitLab.'],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string }
/**
 * 一次字段级预检的结果：`setup` 作用域的 `code` 来自 `SETUP_PROBLEMS`，
 * `check` 作用域的 `code` 由面板用 `check.<code>` 文案渲染。
 */
export interface SourceCheck {
  field: string
  ok: boolean
  scope: 'setup' | 'check'
  code: string
  values: Record<string, string>
}

/** 生成一条通过的预检结果；默认没有占位符。 */
export const checkPassed = (field: string, code: string, values: Record<string, string> = {}): SourceCheck =>
  ({ field, ok: true, scope: 'check', code, values })
/** 生成一条失败的预检结果；默认没有占位符。 */
export const checkFailed = (field: string, code: string, values: Record<string, string> = {}): SourceCheck =>
  ({ field, ok: false, scope: 'check', code, values })
/** 新增记录表单的显示名检查：必填、限长且不含控制字符。 */
export const checkName = (name: string): SourceCheck => {
  const value = name.trim()
  if (!value) return checkFailed('name', 'sourceNameRequired')
  if (value.length > LIMITS.sourceName) return checkFailed('name', 'sourceNameTooLong', { limit: String(LIMITS.sourceName) })
  if (/[\u0000-\u001f\u007f]/.test(value)) return checkFailed('name', 'sourceNameInvalid')
  return checkPassed('name', 'sourceNameOk', { name: value })
}
/** 新增记录表单的登记 ID 检查：留空自动生成；显式时须为小写字母开头的 kebab-case 且未被占用。 */
export const checkId = (id: string, taken?: (id: string) => boolean): SourceCheck => {
  if (!id) return checkPassed('id', 'sourceIdAuto')
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return checkFailed('id', 'sourceIdInvalid', { id })
  if (taken?.(id)) return checkFailed('id', 'sourceIdTaken', { id })
  return checkPassed('id', 'sourceIdOk', { id })
}
/**
 * 「按字段预检」的共享分派骨架：消息来源、代码仓库与任务来源的预检入口共用，
 * 保证类型未知、名称/ID/类型短路、schema 校验失败与逐字段循环的口径一致。
 * `identityFirst` 为任务来源风格：名称/ID/类型通过结果先于配置检查出现（含配置无效时），且 `kind` 在解析前短路。
 */
export async function verifyFields<C>(input: {
  /** 预检目标的类型名；类型未注册时各字段返回 `sourceKindUnknown`。 */
  kind: string
  /** 请求检查的字段；`'all'` 表示全部关键字段。 */
  field: string
  /** 候选配置。 */
  config: unknown
  /** 候选配置的 schema；类型未注册时省略。 */
  schema: z.ZodType<C> | undefined
  /** `field` 为 `'all'` 时除名称/ID/类型外依次检查的字段。 */
  allFields: readonly string[]
  /** 单字段检查回调；`name`、`id` 与 `kind` 已由骨架短路。 */
  check(field: string, data: C): Promise<SourceCheck[]> | SourceCheck[]
  /** 名称与登记 ID；提供时 `all` 先查它们，`name`/`id` 可单独短路。 */
  meta?: { name?: string; id?: string; taken?(id: string): boolean }
  identityFirst?: boolean
}): Promise<SourceCheck[]> {
  const { kind, field, config, schema, allFields, check, meta, identityFirst } = input
  if (!schema) return [checkFailed(field === 'all' ? 'kind' : field, 'sourceKindUnknown', { kind })]
  if (meta && field === 'name') return [checkName(meta.name ?? '')]
  if (meta && field === 'id') return [checkId(meta.id ?? '', meta.taken)]
  if (identityFirst && field === 'kind') return [checkPassed('kind', 'sourceKindOk', { kind })]
  /** 名称、登记 ID 与类型通过结果。 */
  const declared = (): SourceCheck[] => {
    const checks: SourceCheck[] = meta ? [checkName(meta.name ?? '')] : []
    if (meta?.id !== undefined) checks.push(checkId(meta.id, meta.taken))
    if (identityFirst) checks.push(checkPassed('kind', 'sourceKindOk', { kind }))
    return checks
  }
  const parsed = schema.safeParse(config ?? {})
  if (!parsed.success) {
    const invalid = [checkFailed(field === 'all' ? 'kind' : field, 'sourceConfigInvalid', {
      detail: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') })]
    return field === 'all' && identityFirst ? [...declared(), ...invalid] : invalid
  }
  if (field === 'kind') return [checkPassed('kind', 'sourceKindOk', { kind })]
  if (field !== 'all') return [...await check(field, parsed.data)]
  // 名称必填优先于来源配置：名称缺失时不应先暴露配置格式问题。
  const checks = declared()
  for (const name of allFields) checks.push(...await check(name, parsed.data))
  return checks
}

/**
 * 部署和账号校验检查在必需的 CLI、账号或仓库检查失败时抛出。
 * `Setup` 为管理总览记录它，HTTP 层返回 `problem` 以便面板本地化显示。
 * 来源记录的问题把记录 ID 作为 `place`，因此同类型多条记录的问题互不覆盖。
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {}, place?: string) {
    const [defaultPlace, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place ?? defaultPlace
  }
  get problem(): SetupProblem { return { place: this.place, code: this.code, values: this.values, detail: this.message } }
}
