/** GitLab 代码仓库类型：只提供仓库位置与 CLI 凭据，用于克隆与同步，不产生触发器。 */
import { z } from 'zod'
import { GitlabSourceSchema, type ResolvedSource } from '../deployment.ts'
import type { CodeRepoType } from '../code-repos/kind.ts'
import type { Localized } from '../sources/kind.ts'

const GitlabConfigSchema = GitlabSourceSchema.strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
export const gitlabType: CodeRepoType<GitlabConfig> = {
  kind: 'gitlab',
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号与项目；只用于克隆、同步代码和读取仓库文件，不接收 Issue、MR 或评论事件。', en: 'The agent\'s GitLab account and project; used only to clone, sync code and read repository files. It receives no Issues, merge requests or comments.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'instanceUrl', type: 'text', label: { zh: '实例地址', en: 'Instance URL' },
      hint: { zh: '留空使用 gitlab.com；自建 GitLab 填站点根地址，例如 https://gitlab.example.com。', en: 'Leave empty for gitlab.com; for a self-hosted GitLab, enter the site root such as https://gitlab.example.com.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)+', label: { zh: '代码仓库', en: 'GitLab project' },
      hint: { zh: '写作 group/project，支持多级命名空间。保存时检查 glab 登录的账号能否读取项目并有 Developer 及以上权限，然后重启 dsh-superagent。', en: 'Written group/project; multi-level namespaces are supported. Saving checks that the account signed in to glab can read the project with Developer access or higher, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，默认 glab。可用 GITLAB_TOKEN 或 glab auth login 登录智能体账号；智能体以它登录的账号行事。', en: 'A command name or absolute path, glab by default. Sign it in to the agent account with GITLAB_TOKEN or glab auth login; the agent acts as that account.' } },
  ],
  facts: (source): Record<string, Localized | string> => source?.kind === 'gitlab' ? {
    cli: { zh: `当前账号 @${source.login}`, en: `Current account @${source.login}` },
  } : {},
}
