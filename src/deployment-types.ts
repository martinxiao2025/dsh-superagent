/**
 * 部署类型的叶子层：已解析来源记录与部署形态。deployment.ts、infra/* 与 executor/*
 * 都从这里导入，避免 deployment ↔ infra 互相 import 形成模块环（评审 P1-9）。
 * 只放类型与零依赖的守卫函数；任何依赖 schemastery/zod/Node 子进程的实现留在上层。
 */
/** 机器设置的易变字段形态：宿主注入的在位更新包装（`Volatile<T>`）的结构化最小类型。 */
export interface VolatileValue<T> { get(): T }

/** 代码仓库的远端认证方式：`https` 使用智能体 CLI 的凭据助手，`ssh` 使用本机 SSH key。 */
export type RepoAuth = 'https' | 'ssh'

/** 已解析的 GitHub 来源记录：一个记录一个智能体账号和一个仓库。 */
export interface ResolvedGithubSource {
  readonly id: string
  readonly kind: 'github'
  /** 站点根地址；空表示 github.com。 */
  readonly instanceUrl: string
  readonly cli: string
  readonly repository: string
  readonly login: string
  readonly noreply: string
  /** 远端认证方式；`ssh` 时不使用 CLI。 */
  readonly auth: RepoAuth
  /** 覆盖默认远端地址；空表示按认证方式推导。 */
  readonly remote: string
  /** SSH 私钥路径；空表示使用本机默认 SSH 配置。 */
  readonly sshKey: string
  /** 项目选择的 Git 凭据 ID；仅项目仓库来源携带。 */
  readonly gitCredential?: string
}
/** 已解析的 GitLab 来源记录。 */
export interface ResolvedGitlabSource {
  readonly id: string
  readonly kind: 'gitlab'
  readonly instanceUrl: string
  readonly cli: string
  readonly project: string
  readonly projectId: number
  readonly login: string
  /** GitLab 的数字用户 ID。 */
  readonly userId: number
  /** 远端认证方式；`ssh` 时不使用 CLI。 */
  readonly auth: RepoAuth
  readonly remote: string
  readonly sshKey: string
  /** 项目选择的 Git 凭据 ID；仅项目仓库来源携带。 */
  readonly gitCredential?: string
}
/** 已解析的飞书来源记录：一个记录一个机器人。 */
export interface ResolvedFeishuSource {
  readonly id: string
  readonly kind: 'feishu'
  readonly instanceUrl: string
  readonly cli: string
  readonly appId: string
  readonly brand: 'feishu' | 'lark'
  readonly botId: string
  readonly name: string
}
export type ResolvedSource = ResolvedGithubSource | ResolvedGitlabSource | ResolvedFeishuSource

/**
 * 机器设置：插件 Config 中稳定的路径与易变数值项。deployment.ts 实现它（用 Cordis 的
 * `Volatile<T>` 满足 `VolatileValue<T>`）；infra 与 executor 只看得到这个接口，不依赖配置 schema。
 */
export interface Machine {
  stateDir: string
  promptMaxChars: VolatileValue<number>
  admissionContextMaxPages: VolatileValue<number>
  admissionContextTimeoutMs: VolatileValue<number>
  commandTimeoutMs: VolatileValue<number>
  gitTimeoutMs: VolatileValue<number>
  githubCli: VolatileValue<string>
  gitlabCli: VolatileValue<string>
  githubHost: VolatileValue<string>
  gitlabHost: VolatileValue<string>
  workspaceRetentionDays: VolatileValue<number>
}
/** 机器设置加上按记录 ID 索引的已解析来源；同一类型可以有多条记录。 */
export interface Deployment extends Machine {
  readonly sources: Readonly<Record<string, ResolvedSource>>
}

export const isGithubSource = (source: ResolvedSource | undefined): source is ResolvedGithubSource => source?.kind === 'github'
export const isGitlabSource = (source: ResolvedSource | undefined): source is ResolvedGitlabSource => source?.kind === 'gitlab'
export const isFeishuSource = (source: ResolvedSource | undefined): source is ResolvedFeishuSource => source?.kind === 'feishu'
/** 某条来源记录已解析的来源；记录不存在或尚未解析时为 undefined。 */
export const sourceOf = (deployment: Deployment | undefined, id: string): ResolvedSource | undefined => deployment?.sources[id]
/** 某一类型的第一条已解析来源记录；工作单元垫片和通用工具只使用这一条。 */
export function firstSource<K extends ResolvedSource['kind']>(deployment: Deployment | undefined, kind: K): Extract<ResolvedSource, { kind: K }> | undefined {
  if (!deployment) return undefined
  for (const source of Object.values(deployment.sources)) if (source.kind === kind) return source as Extract<ResolvedSource, { kind: K }>
  return undefined
}
