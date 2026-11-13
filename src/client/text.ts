/** 本地化、原因格式化、消息标记清理，以及相对时间戳辅助工具。 */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { DshSuperagentKey } from './locales.ts'
import type { Localized } from '../fields.ts'
import type { SetupProblem, SourceCheck } from '../setup.ts'
import type { Health } from '../infra/health.ts'
import { reasonText, type Reason } from '../core/reasons.ts'

export type T = Translate<DshSuperagentKey>
export const errorText = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure)
export const localized = (t: T, text: Localized | string | undefined): string =>
  typeof text === 'string' ? text : text ? text[t('lang') === 'en' ? 'en' : 'zh'] : ''
export const actorName = (t: T, actor: { name?: Localized } | undefined): string => actor?.name ? localized(t, actor.name)
  : t('automatedNotice')
/** 字典中实际存在的「组.键」命名空间；`valueLabel` 的组参数据此编译期穷举，拼错的组名直接编译报错。 */
type LabelGroup = { [K in DshSuperagentKey]: K extends `${infer G}.${string}` ? G : never }[DshSuperagentKey]
/** 组内取值的措辞；键是运行时数据，缺键时回退显示键本身（可枚举前缀的覆盖已由 locales.ts 的编译期守卫保证）。 */
export function valueLabel<G extends LabelGroup>(t: T, group: G, key: string | undefined): string {
  if (!key) return ''
  const name = `${group}.${key}` as DshSuperagentKey
  const text = t(name)
  return text === name ? key : text
}
/** 以当前 UI 语言格式化一个或多个结构化或原始原因，并将多行宿主错误截断为其第一行。 */
export function reasonLabel(t: T, reason: string | Reason | readonly Reason[] | undefined): string {
  if (typeof reason === 'string') return reason ? label(t, { code: reason }) : ''
  return [reason ?? []].flat().map(item => label(t, item)).filter(Boolean).join('；')
}
function label(t: T, reason: Reason): string {
  const key = `reason.${reason.code}` as DshSuperagentKey
  const text = reason.code === 'said' ? reason.values?.text ?? '' : t(key, reason.values)
  if (reason.code !== 'said' && text !== key) return text
  const written = reason.code === 'said' ? text : reasonText({ ...reason, triggerId: undefined })
  if (/^\w*Error\b/.test(written)) { const first = written.split('\n')[0]!; return first.length > 140 ? `${first.slice(0, 140)}…` : first }
  return written
}
export const setupText = (t: T, problem: Pick<SetupProblem, 'code' | 'values'>): string => t(`setup.${problem.code}`, problem.values)
/** 新增来源的字段级预检结果：初始化问题复用 `setup.*`，其余走 `check.*`。 */
export const sourceCheckText = (t: T, check: Pick<SourceCheck, 'scope' | 'code' | 'values'>): string => check.scope === 'setup'
  ? setupText(t, { code: check.code as SetupProblem['code'], values: check.values })
  : t(`check.${check.code}` as DshSuperagentKey, check.values)
export const healthText = (t: T, health: Pick<Health, 'detail' | 'code' | 'values'>): string =>
  health.code ? t(`healthCode.${health.code}` as const, health.values) : health.detail
/** 将飞书与 GitHub 内容占位符（图片、卡片、媒体、转发、未解析的提及）替换为本地化标签。 */
export function readableMarkers(t: T, text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]|\[image\]/g, t('imageMarker'))
    .replace(/\[Chat card: [^\]]*\]/g, t('cardMarker'))
    .replace(/\[Media: [^\]]*\]/g, t('mediaMarker')).replace(/\[Merged forward\]/g, t('forwardMarker'))
    .replace(/@_user_\d+/g, t('unknownMention'))
}
const timeLocale = (lang: string) => lang === 'en' ? 'en' : 'zh-CN'
export function when(value: string | undefined, lang: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  if (Math.abs(seconds) < 86_400) {
    const relative = new Intl.RelativeTimeFormat(timeLocale(lang), { numeric: 'auto' })
    if (Math.abs(seconds) < 60) return relative.format(0, 'second')
    if (Math.abs(seconds) < 3600) return relative.format(Math.round(seconds / 60), 'minute')
    return relative.format(Math.round(seconds / 3600), 'hour')
  }
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const year = sameYear ? {} : { year: 'numeric' } as const
  return date.toLocaleString(timeLocale(lang), { ...year, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
export function fullTime(value: string | undefined, lang: string): string {
  const date = new Date(value ?? '')
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(timeLocale(lang))
}
