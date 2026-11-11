/** 代码仓库记录与类型描述：记录只保存名称、启停与配置；类型提供 schema、面板字段与只读事实。 */
import { z } from 'zod'
import type { ResolvedSource } from '../deployment.ts'
import { LIMITS } from '../limits.ts'
import type { FieldSpec, Localized } from '../sources/kind.ts'

/** 代码仓库记录可选的类型；GitHub 与 GitLab 只负责克隆、同步与凭据，不产生任务。 */
export const CodeRepoKindSchema = z.enum(['github', 'gitlab'])
export type CodeRepoKind = z.infer<typeof CodeRepoKindSchema>
/** 一条代码仓库记录：正文由类型 schema 校验，这里只约束记录外壳。 */
export const CodeRepoRecordSchema = z.object({
  kind: CodeRepoKindSchema,
  /** 面板显示的名称，必填。 */
  name: z.string().trim().min(1).max(LIMITS.sourceName),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict()
export type CodeRepoRecord = z.infer<typeof CodeRepoRecordSchema>

/** 代码仓库类型的静态描述；与记录的 `kind` 一一对应。 */
export interface CodeRepoType<C extends Record<string, unknown> = Record<string, unknown>> {
  kind: CodeRepoKind
  title: Localized
  description: Localized
  /** 校验已存储和提交的配置并填充默认值。 */
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** 由记录解析出的仓库派生的只读状态事实（记录尚未解析时为 undefined），按字段键索引。 */
  facts?(source: ResolvedSource | undefined): Record<string, Localized | string>
}
