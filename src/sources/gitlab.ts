/** GitLab 代码仓库类型：只提供仓库位置与 CLI 凭据，用于克隆与同步，不产生触发器。 */
import { z } from 'zod'
import { GitlabSourceSchema, type ResolvedSource } from '../deployment.ts'
import type { CodeRepoType } from '../code-repos/kind.ts'
import type { Localized } from '../fields.ts'

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
    { key: 'auth', type: 'select', options: [
      { value: 'https', label: { zh: 'HTTPS + 智能体凭据', en: 'HTTPS with agent credentials' } },
      { value: 'ssh', label: { zh: 'SSH + 本机密钥', en: 'SSH with local key' } },
    ], label: { zh: '认证方式', en: 'Authentication' },
      hint: { zh: 'HTTPS 使用 glab 登录的凭据；SSH 使用本机 SSH key，并且不再依赖 glab。', en: 'HTTPS uses the credentials glab is signed in with; SSH uses the local SSH key and no longer depends on glab.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)+', label: { zh: '代码仓库', en: 'GitLab project' },
      hint: { zh: '写作 group/project，支持多级命名空间。预检按钮会按认证方式检查项目是否可访问。', en: 'Written group/project; multi-level namespaces are supported. The verify button checks accessibility per auth mode.' } },
    { key: 'remote', type: 'text', label: { zh: '自定义远端地址', en: 'Custom remote' }, advanced: true,
      hint: { zh: '可选，例如 git@gitlab.com:group/project.git；留空时按认证方式生成。地址不能内嵌用户名或密码。', en: 'Optional, e.g. git@gitlab.com:group/project.git; generated from the auth mode when empty. Addresses cannot embed credentials.' } },
    { key: 'sshKey', type: 'text', label: { zh: 'SSH 私钥路径', en: 'SSH key path' }, advanced: true,
      hint: { zh: '仅 SSH 使用；留空时由 ssh-agent 或 ~/.ssh/config 选择密钥。支持 ~ 开头的路径。', en: 'SSH only; leave empty to let ssh-agent or ~/.ssh/config pick the key. Paths starting with ~ are supported.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '仅 HTTPS 使用：命令名或绝对路径，默认 glab。可用 GITLAB_TOKEN 或 glab auth login 登录智能体账号。', en: 'HTTPS only: a command name or absolute path, glab by default. Sign it in with GITLAB_TOKEN or glab auth login.' } },
  ],
  checkFields: ['auth', 'project', 'remote', 'sshKey', 'cli'],
  facts: (source): Record<string, Localized | string> => source?.kind === 'gitlab' ? {
    cli: source.auth === 'ssh' ? { zh: 'SSH（不依赖 glab）', en: 'SSH (no glab)' } : { zh: `当前账号 @${source.login}`, en: `Current account @${source.login}` },
  } : {},
}
