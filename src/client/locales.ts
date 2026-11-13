/**
 * 双语 UI 字典（`[zh, en]`）与术语表分组的合并出口，遵循 `docs/001-domain.md` 中的领域术语。
 * 字典按命名空间拆分在 `./locales/` 下；本文件的键集合与值形状、`zh`/`en`、
 * 术语表常量与 module augmentation 的行为与拆分前一致，client 其余文件仍从这里导入。
 */
import type { UserErrorCode } from '../core/errors.ts'
import type { ReasonCode } from '../core/reasons.ts'
import type { TicketStage } from '../core/stage.ts'
import type { HealthCode } from '../infra/health.ts'
import type { SetupCode } from '../setup.ts'
import { checksText } from './locales/checks.ts'
import { GLOSSARY, GLOSSARY_VALUES, glossaryText } from './locales/glossary.ts'
import { pagesText } from './locales/pages.ts'
import { reasonsText } from './locales/reasons.ts'
import { setupHealthText } from './locales/setup-health.ts'
import { settingsText } from './locales/settings.ts'
import { sharedText } from './locales/shared.ts'
import { userErrorText } from './locales/user-error.ts'

const TEXT = {
  ...sharedText,
  ...pagesText,
  ...settingsText,
  ...reasonsText,
  ...glossaryText,
  ...userErrorText,
  ...setupHealthText,
  ...checksText,
} as const satisfies Record<string, readonly [string, string]>
export type DshSuperagentKey = keyof typeof TEXT
const language = (index: 0 | 1) => Object.fromEntries(Object.entries(TEXT).map(([key, pair]) => [key, pair[index]])) as Record<DshSuperagentKey, string>
export const zh = language(0), en = language(1)

/** 编译期穷举守卫：可枚举前缀的每个代码都必须在字典中有键；缺键在类型层报错，而不是运行时回退显示代码本身。 */
type Assert<T extends true> = T
type InDict<K extends string> = K extends DshSuperagentKey ? true : false
// reason.*：REASONS 登记的每个代码都必须有键（`said` 由 text.ts 特判，不进字典）；自由字符串代码仍走运行时回退。
type _ReasonCoverage = Assert<{ [C in Exclude<ReasonCode, 'said'>]: InDict<`reason.${C}`> }[Exclude<ReasonCode, 'said'>]>
// stage.*：工单在人阶段的每个动作，加上排队、工作与空闲，都必须有键。
type StageAction = Extract<TicketStage, { stage: 'person' }>['action'] | 'queued' | 'working' | 'idle'
type _StageCoverage = Assert<{ [A in StageAction]: InDict<`stage.${A}`> }[StageAction]>
// setup.* 与 userError.*：宿主的每个初始化问题码与用户错误码都必须有键。
type _SetupCoverage = Assert<{ [C in SetupCode]: InDict<`setup.${C}`> }[SetupCode]>
type _UserErrorCoverage = Assert<{ [C in UserErrorCode]: InDict<`userError.${C}`> }[UserErrorCode]>
// healthCode.*：宿主登记的每个健康码都必须有键。
type _HealthCodeCoverage = Assert<{ [C in HealthCode]: InDict<`healthCode.${C}`> }[HealthCode]>

export { GLOSSARY, GLOSSARY_VALUES }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { dshSuperagent: DshSuperagentKey }
}
