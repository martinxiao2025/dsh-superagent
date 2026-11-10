/** 测试用的默认部署与机器夹具。 */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, Machine, ResolvedFeishuSource, ResolvedGithubSource, ResolvedGitlabSource, ResolvedSource } from '../../src/deployment.ts'

/** 用于模拟实时配置更新的可变 Volatile 引用。 */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
export const testGithub = (overrides: Partial<ResolvedGithubSource> = {}): ResolvedGithubSource => ({
  id: 'github', kind: 'github', instanceUrl: '', cli: '/bin/false', repository: 'acme/widgets',
  login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com', ...overrides,
})
export const testFeishu = (overrides: Partial<ResolvedFeishuSource> = {}): ResolvedFeishuSource => ({
  id: 'feishu', kind: 'feishu', instanceUrl: '', cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu',
  name: 'Widgets Bot', ...overrides,
})
export const testGitlab = (overrides: Partial<ResolvedGitlabSource> = {}): ResolvedGitlabSource => ({
  id: 'gitlab', kind: 'gitlab', instanceUrl: '', cli: '/bin/false', project: 'acme/widgets', projectId: 42, login: 'agent-bot',
  userId: 7, ...overrides,
})
export interface TestDeploymentOptions extends Partial<Machine> {
  github?: ResolvedGithubSource | undefined
  feishu?: ResolvedFeishuSource | undefined
  gitlab?: ResolvedGitlabSource | undefined
  /** 直接给出完整来源映射；设置后忽略上面的单类型选项。 */
  sources?: Readonly<Record<string, ResolvedSource>> | undefined
}
/**
 * 默认给出一条 GitHub 记录和一条飞书记录；把 `feishu`/`gitlab`/`github` 显式设为 `undefined` 可以移除该类型的默认记录，
 * 从而模拟记录未配置或尚未解析的状态。
 */
export const testDeployment = (options: TestDeploymentOptions = {}): Deployment => {
  const { github: githubOption, feishu: feishuOption, gitlab: gitlabOption, sources, ...machine } = options
  if (sources) return { ...testMachine(machine), sources }
  const resolved: Record<string, ResolvedSource> = {}
  const github = 'github' in options ? githubOption : testGithub()
  const feishu = 'feishu' in options ? feishuOption : testFeishu()
  const gitlab = 'gitlab' in options ? gitlabOption : undefined
  if (github) resolved[github.id] = github
  if (feishu) resolved[feishu.id] = feishu
  if (gitlab) resolved[gitlab.id] = gitlab
  return { ...testMachine(machine), sources: resolved }
}
