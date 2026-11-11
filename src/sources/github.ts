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
    { key: 'auth', type: 'select', options: [
      { value: 'https', label: { zh: 'HTTPS + 智能体凭据', en: 'HTTPS with agent credentials' } },
      { value: 'ssh', label: { zh: 'SSH + 本机密钥', en: 'SSH with local key' } },
    ], label: { zh: '认证方式', en: 'Authentication' },
      hint: { zh: 'HTTPS 使用智能体 GitHub CLI 的凭据；SSH 使用本机 SSH key，并且不再依赖 gh。', en: 'HTTPS uses the agent GitHub CLI\'s credentials; SSH uses the local SSH key and no longer depends on gh.' } },
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '代码仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。预检按钮会按认证方式检查仓库是否可访问；HTTPS 还会检查推送权限。', en: 'Written owner/name. The verify button checks accessibility per auth mode; HTTPS also checks push permission.' } },
    { key: 'remote', type: 'text', label: { zh: '自定义远端地址', en: 'Custom remote' }, advanced: true,
      hint: { zh: '可选，例如 git@github.com:owner/repo.git；留空时按认证方式生成。地址不能内嵌用户名或密码。', en: 'Optional, e.g. git@github.com:owner/repo.git; generated from the auth mode when empty. Addresses cannot embed credentials.' } },
    { key: 'sshKey', type: 'text', label: { zh: 'SSH 私钥路径', en: 'SSH key path' }, advanced: true,
      hint: { zh: '仅 SSH 使用；留空时由 ssh-agent 或 ~/.ssh/config 选择密钥。支持 ~ 开头的路径。', en: 'SSH only; leave empty to let ssh-agent or ~/.ssh/config pick the key. Paths starting with ~ are supported.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitHub CLI', en: 'Agent GitHub CLI' },
      hint: { zh: '仅 HTTPS 使用：命令名或绝对路径，通常是用 GH_CONFIG_DIR 登录智能体账号的 gh 包装脚本。', en: 'HTTPS only: a command name or absolute path, usually a gh wrapper signed in to the agent account through GH_CONFIG_DIR.' } },
  ],
  checkFields: ['auth', 'repository', 'remote', 'sshKey', 'cli'],
  facts: (source): Record<string, Localized | string> => source?.kind === 'github' ? {
    cli: source.auth === 'ssh' ? { zh: 'SSH（不依赖 gh）', en: 'SSH (no gh)' } : { zh: `当前账号 @${source.login}`, en: `Current account @${source.login}` },
  } : {},
}
