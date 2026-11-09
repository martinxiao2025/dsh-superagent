/**
 * 按范围划分的受理矩阵，将收到的消息分类为显式请求、推断候选或忽略。
 * 名单内的发送者若点名智能体，总是构成显式请求（无表项）；未点名的消息不能是显式的。
 */
import type { AdmissionCell } from './core/model.ts'

export type { AdmissionCell }
export type Admission = 'explicit' | 'inferred' | 'ignore'
export const ADMISSION_OPTIONS = { listedUnaddressed: ['inferred', 'ignore'], unlistedAddressed: ['explicit', 'inferred', 'ignore'],
  unlistedUnaddressed: ['inferred', 'ignore'] } as const satisfies Record<AdmissionCell, readonly Admission[]>
export type AdmissionRow = { [C in AdmissionCell]?: typeof ADMISSION_OPTIONS[C][number] }
/** 默认受理规则（与引入表格前的行为一致）：名单内发送者的未点名消息为推断候选；名单外发送者被忽略。 */
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' }
