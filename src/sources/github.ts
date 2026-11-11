/** GitHub 代码仓库类型：只提供仓库位置与 CLI 凭据，用于克隆与同步，不产生触发器。 */
import { z } from 'zod'
import { GithubSourceSchema, type ResolvedSource } from '../deployment.ts'
import type { CodeRepoType } from '../code-repos/kind.ts'
import type { Localized } from '../sources/kind.ts'

const GithubConfigSchema = GithubSourceSchema.strict()
export type GithubConfig = z.infer<typeof GithubConfigSchema>
export const githubType: CodeRepoType<GithubConfig> = {
  kind: 'github',
  title: { zh: 'GitHub', en: 'GitHub' },
  description: { zh: '智能体的 GitHub 账号与仓库；只用于克隆、同步代码和读取仓库文件，不接收 Issue、PR、评论或 CI 事件。', en: 'The agent\'s GitHub account and repository; used only to clone, sync code and read repository files. It receives no Issues, pull requests, comments or CI events.' },
  schema: GithubConfigSchema,
  fields: [
    { key: 'instanceUrl', type: 'text', label: { zh: '实例地址', en: 'Instance URL' },
      hint: { zh: '留空使用 github.com；自建 GitHub Enterprise 填站点根地址，例如 https://github.example.com。', en: 'Leave empty for github.com; for a self-hosted GitHub Enterprise, enter the site root such as https://github.example.com.' } },
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '代码仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。保存时检查智能体账号能否推送到它，然后重启 dsh-superagent。', en: 'Written owner/name. Saving checks that the agent account can push to it, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitHub CLI', en: 'Agent GitHub CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GH_CONFIG_DIR 登录智能体账号的 gh 包装脚本。智能体以它登录的账号行事，执行器以 gh 调用它。', en: 'A command name or absolute path, usually a gh wrapper signed in to the agent account through GH_CONFIG_DIR. The agent acts as the account it is signed in to, and the Executor calls it as gh.' } },
  ],
  facts: (source): Record<string, Localized | string> => source?.kind === 'github' ? {
    cli: { zh: `当前账号 @${source.login}`, en: `Current account @${source.login}` },
  } : {},
}
