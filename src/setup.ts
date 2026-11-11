/** 结构化的启动和配置错误，附带运维者可用于修复问题的设置位置。 */
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
