/** GitHub 与 GitLab 共用的接收范围映射和策略接收表，避免两套适配器各写一份相同规则。 */
import { z } from 'zod'
import type { ScopeResult } from '../core/index.ts'
import { escapeRegExp } from '../infra/text.ts'
import type { AdmissionRowView, Localized, SourcePolicyPart } from './kind.ts'

/** 文本是否以词边界 @ 了 `login`（大小写不敏感），GitHub 与 GitLab 共用。 */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)

export type ForgeScope = 'issues' | 'pulls' | 'comments'
/** 解析 Trigger.meta 对应的接收范围；CI 仅 GitHub 使用。 */
export function scopeOfMeta(meta: Record<string, unknown>): ForgeScope | 'ci' | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review' ? 'comments' : undefined
}
/** 计算来源是否监听以及是否整类接收；两种 forge 的 Switch 字段名由 `observed` 提供。 */
export function forgeScope(meta: Record<string, unknown>, config: Record<string, unknown>,
  observed: Readonly<Partial<Record<ForgeScope | 'ci', string>>>): ScopeResult {
  const row = scopeOfMeta(meta)
  return { listened: true, observed: row !== undefined && !!config[observed[row] ?? ''], ...row ? { row } : {} }
}
/** `rows` 只读取配置的一部分，因此只要求 schema 提供 `partial()`。 */
interface PartialConfig { partial(): { parse(value: unknown): Record<string, unknown> } }
export interface ForgePolicyOptions {
  /** 来源配置 schema，用于解析策略页面里的接收范围行。 */
  config: PartialConfig
  /** 接收范围到配置字段名的映射；CI 只由传入 `ci` 的来源使用。 */
  observed: Readonly<Partial<Record<ForgeScope | 'ci', string>>>
  allowed: Localized
  allowedColumn: Localized
  /** 账号 schema 与表单 pattern 必须一致。 */
  accountPattern: RegExp
  accountInput: string
  bots: Localized
  botsHint: Localized
  botColumn: Localized
  botPattern: RegExp
  botInput: string
  explicit: Localized
  issues: Localized
  pulls: Localized
  comments: Localized
  /** 有 CI 的来源传入 CI 行；没有 CI 的来源不传。 */
  ci?: { key: string; label: Localized; received: Localized; notReceived: Localized }
}
/**
 * 生成 forge 类来源（GitHub、GitLab）共用的策略部分：允许账号、机器人名单和接收表。
 * 账号与机器人 pattern 由调用方给出，因此 GitHub 的文案、正则和行顺序保持原样。
 */
export function forgePolicy(options: ForgePolicyOptions): SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
  return {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(options.accountPattern) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(options.botPattern) }).strict()).optional(),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: options.allowed,
      columns: [{ key: 'id', type: 'text', label: options.allowedColumn, pattern: options.accountInput }] },
    { key: 'bots', type: 'rows', label: options.bots, hint: options.botsHint,
      columns: [{ key: 'id', type: 'text', label: options.botColumn, pattern: options.botInput }] }],
    explicit: options.explicit,
    rows(stored) {
      const config = options.config.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: ForgeScope, label: Localized): AdmissionRowView => ({ id, label, note: note(!!config[options.observed[id] ?? '']),
        cells: { listedUnaddressed: !!config[options.observed[id] ?? ''], unlistedAddressed: true,
          unlistedUnaddressed: !!config[options.observed[id] ?? ''] } })
      const rows = [row('issues', options.issues), row('pulls', options.pulls), row('comments', options.comments)]
      // CI 没有发送者，因此只有“名单外且没有 @ 智能体”这一格由开关决定。
      if (options.ci) rows.push({ id: 'ci', label: options.ci.label,
        note: config[options.ci.key] ? options.ci.received : options.ci.notReceived,
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config[options.ci.key] } })
      return rows
    },
  }
}
