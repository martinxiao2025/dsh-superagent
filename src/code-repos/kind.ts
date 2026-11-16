/** 代码仓库类型描述：类型提供 schema、面板字段与只读事实。 */
import { z } from 'zod'
import type { ResolvedSource } from '../deployment.ts'
import type { FieldSpec, Localized } from '../fields.ts'

/** 代码仓库记录可选的类型；GitHub 与 GitLab 只负责克隆、同步与凭据，不产生任务。 */
export const CodeRepoKindSchema = z.enum(['github', 'gitlab'])
export type CodeRepoKind = z.infer<typeof CodeRepoKindSchema>
/**
 * 从完整远端地址推导站点主机与仓库路径；项目表单只让用户粘贴地址，记录字段由这里补齐。
 * 支持 `https://host/owner/repo[.git]`、`git@host:owner/repo[.git]` 与 `ssh://user@host/path[.git]`。
 */
export function repositoryOfRemote(remote: string): { host: string; repository: string } | undefined {
  const text = remote.trim()
  const https = text.match(/^https?:\/\/([^/\s]+)\/(.+?)(?:\.git)?\/?$/)
  if (https) return { host: https[1]!, repository: https[2]! }
  const ssh = text.match(/^(?:ssh:\/\/)?([^/@\s]+)@([^/:/\s]+)[:/](.+?)(?:\.git)?\/?$/)
  if (ssh) return { host: ssh[2]!, repository: ssh[3]! }
  return undefined
}

/** 代码仓库类型的静态描述；与记录的 `kind` 一一对应。 */
export interface CodeRepoType<C extends Record<string, unknown> = Record<string, unknown>> {
  kind: CodeRepoKind
  title: Localized
  description: Localized
  /** 校验已存储和提交的配置并填充默认值。 */
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** 「全部验证」按这个顺序检查的字段；名称、ID 与类型由服务端单独检查。 */
  checkFields: string[]
  /** 由记录解析出的仓库派生的只读状态事实（记录尚未解析时为 undefined），按字段键索引。 */
  facts?(source: ResolvedSource | undefined): Record<string, Localized | string>
}
