/** 用于编辑提示词段落/技能并计算折叠行差异的纯函数辅助工具。 */
import type { PromptConfig, PromptsView } from './api.ts'
import { valueLabel, type T } from './text.ts'

type TeamSection = PromptsView['sections'][number]
export type BuiltInPart = PromptsView['parts'][number]
export const isSkill = (name: string): name is `skill/${string}` => name.startsWith('skill/')
/** 内置部分，编辑器将其命名为 `part/<key>`，区别于团队技能（`skill/<name>`）。 */
export const isPart = (name: string): name is `part/${string}` => name.startsWith('part/')
export const partKey = (name: `part/${string}`): string => name.slice(5)
export const sections = (config: PromptConfig): string[] => [...Object.keys(config).filter(name => name !== 'skills' && name !== 'overrides'),
  ...Object.keys(config.skills).map(name => `skill/${name}`), ...Object.keys(config.overrides ?? {}).map(key => `part/${key}`)]
/** 返回团队段落或团队技能的文本、内置部分的覆盖文本，或团队未编写的部分的 `undefined`。 */
export const sectionText = (config: PromptConfig, name: string): string | undefined => isPart(name) ? config.overrides?.[partKey(name)]?.text
  : isSkill(name) ? config.skills[name.slice(6)]
  : name !== 'skills' && name !== 'overrides' && Object.hasOwn(config, name) ? config[name as TeamSection] : undefined
/**
 * 按编辑器的保持方式，将配置及其覆盖项（无覆盖项时为空映射）一并返回：草稿与其迁移到的版本之后会逐个覆盖项合并，
 * 因为宿主将没有覆盖项存为 none。传入 `parts` 时，只保留这些部分的覆盖项，因为从历史加载的版本可能覆盖了当前版本
 * 已不存在的部分。
 */
export const withOverrides = (config: PromptConfig, parts?: readonly { key: string }[]): PromptConfig => ({ ...config,
  overrides: Object.fromEntries(Object.entries(config.overrides ?? {}).filter(([key]) => !parts || parts.some(part => part.key === key))) })
/** 内置部分实际读取的文本：团队的覆盖文本，否则为内置文本。 */
export const partText = (config: PromptConfig, part: BuiltInPart): string => config.overrides?.[part.key]?.text ?? part.text
/**
 * 用 `text` 覆盖内置部分：覆盖项会保留其编辑来源的内置文本（新建或 `rebase` 时为当前文本），
 * 当其文本重新等于内置文本时则移除。
 */
export function withOverride(config: PromptConfig, part: BuiltInPart, text: string | undefined, rebase = false): PromptConfig {
  const { [part.key]: previous, ...others } = config.overrides ?? {}
  const base = rebase ? part.base : previous?.base ?? part.base
  return { ...config, overrides: text === undefined || text === part.text ? others : { ...others, [part.key]: { text, base } } }
}
export function withSection(config: PromptConfig, name: string, text: string): PromptConfig {
  return isSkill(name) ? { ...config, skills: { ...config.skills, [name.slice(6)]: text } } : { ...config, [name]: text }
}
export function withoutSkill(config: PromptConfig, name: string): PromptConfig {
  const { [name.slice(6)]: _removed, ...skills } = config.skills
  return { ...config, skills }
}
/** 草稿中与已保存版本不同的段落、技能与覆盖项；经过变基的覆盖项也会计入。 */
export const changedSections = (config: PromptConfig, saved: PromptConfig): string[] =>
  [...new Set([...sections(config), ...sections(saved)])].filter(name => isPart(name)
    ? JSON.stringify(config.overrides?.[partKey(name)]) !== JSON.stringify(saved.overrides?.[partKey(name)])
    : sectionText(config, name) !== sectionText(saved, name))
export const sectionLabel = (t: T, view: Pick<PromptsView, 'skillPrefix'>, name: string): string =>
  isPart(name) ? valueLabel(t, 'promptPart', partKey(name)) : isSkill(name) ? `${view.skillPrefix}${name.slice(6)}` : valueLabel(t, 'promptPart', name)
export const skillNameFree = (name: string, config: PromptConfig, view: Pick<PromptsView, 'skillName' | 'builtin'>): boolean =>
  new RegExp(view.skillName).test(name) && !Object.hasOwn(config.skills, name) && !view.builtin.includes(name)
/** 将团队提示词部分格式化并附上其标题（技能没有标题，故省略）。 */
export const partWith = (part: { name: string; heading?: string | undefined }, base: string): string =>
  part.heading === undefined ? base : `${part.heading}\n${base}`

export type DiffLine = { kind: 'same' | 'del' | 'ins'; text: string } | { kind: 'fold'; count: number }
/** 计算行差异，将超过四行的连续未变行折叠为其边界行与一个计数。 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n')
  // 从末尾填充 LCS 表，使下面的正向遍历能按顺序重建差异。
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1
    : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const lines: { kind: 'same' | 'del' | 'ins'; text: string }[] = []
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: 'same', text: a[i]! }); i++; j++ }
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) lines.push({ kind: 'ins', text: b[j++]! })
    else lines.push({ kind: 'del', text: a[i++]! })
  }
  const folded: DiffLine[] = []
  for (let k = 0; k < lines.length;) {
    let end = k
    while (end < lines.length && lines[end]!.kind === 'same') end++
    if (end - k > 4) folded.push(lines[k]!, { kind: 'fold', count: end - k - 2 }, lines[end - 1]!)
    else folded.push(...lines.slice(k, Math.max(end, k + 1)))
    k = Math.max(end, k + 1)
  }
  return folded
}
