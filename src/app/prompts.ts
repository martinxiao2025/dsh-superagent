/** 独立于访问设置，管理带版本的角色提示词、行为策略和运营技能。 */
import { z } from 'zod'
import { UserError, key } from '../core/index.ts'
import { policyVersion, type Settings, type SettingsOrigin } from '../policy.ts'
import { masterPrompt, workerPrompt, sharedPrompt, guides, mainAdmissionPolicy, handoffPolicy, teamDefaults, sourceSkills, cliNotes } from './context.ts'
import { environmentLines, type Variable } from './execution-environment.ts'
import { promptsNotice } from './notices.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import { Versions } from './versions.ts'
import { KV } from '../kv.ts'

/** 团队编写的提示词部分；在团队覆盖之前，内置部分沿用 dsh-superagent 的文本。 */
export const TEAM_SECTIONS = ['communication', 'scope', 'delivery'] as const
export type TeamSection = typeof TEAM_SECTIONS[number]
/** 每个团队部分的 Markdown 标题；固定提示词部分按这些确切名称引用它们。 */
const TEAM_HEADINGS: Record<TeamSection, string> = { communication: '沟通方式', scope: '工单范围', delivery: '交付要求' }
export const SKILL_NAME = /^[a-z][a-z0-9-]*$/
/** 在 DSH 会话中注册技能名称时添加的前缀。 */
export const SKILL_PREFIX = 'dsh-superagent-'
const SkillNameSchema = z.string().regex(SKILL_NAME).refine(name => !(Object.keys(sourceSkills) as string[]).includes(name),
  'This name belongs to a built-in skill')
/** 团队可以覆盖的内置部分，按键列出：两个角色的部分、来源技能，以及生成部分的模板。 */
const PART_KEYS = ['runtime/shared', 'runtime/orchestrator', 'runtime/worker', 'runtime/subscriptions', 'runtime/replies',
  'runtime/dispatch', 'runtime/work', 'runtime/admission', 'runtime/handoff/orchestrator', 'runtime/handoff/worker', 'runtime/environment',
  'runtime/policy', 'runtime/policy/none', 'skill/feishu', 'skill/github', 'skill/gitlab'] as const
export type PartKey = typeof PART_KEYS[number]
/** 团队为某个内置部分提供的文本，以及 `base`，即它编辑自的内置文本的键。 */
const OverrideSchema = z.object({ text: z.string(),
  base: z.string().optional().describe('Key of the built-in text it was edited from; copy as read, or omit.') }).strict()
/**
 * 一份配置，其覆盖项可能指向后续版本已不存在的部分：当已保存的版本仍保留该部分时，`Prompts.validate` 会丢弃它，
 * 否则拒绝。
 */
export const PromptConfigSchema = z.object({ communication: z.string(), scope: z.string(), delivery: z.string(),
  skills: z.record(SkillNameSchema, z.string()), overrides: z.record(z.string(), OverrideSchema).optional()
    .describe('Text in place of a built-in part, by its key in prompts/defaults; a part not named follows its built-in text.') }).strict()
export type PromptConfig = z.infer<typeof PromptConfigSchema>
export interface PromptVersion { revision: number; previousRevision: number | null; savedAt: string; source: string; config: PromptConfig;
  /** 当无法跨 schema 版本比较差异时保留的原始未迁移配置。 */
  legacy?: { config: unknown } }
export const defaultPrompts = (): PromptConfig => ({ ...teamDefaults, skills: {} })

const ENVIRONMENT_HEADING = '执行环境（来自本安装的设置；它优先于这些说明中在别处指定的任何仓库或账户；空值表示此处未配置该部分）。工单目录的 prepare 命令读取相同的变量：'
const POLICY_HEAD = '## 策略\n策略版本 {version}；accept 模式 {mode}。accept 模式和规则只决定主动候选：明确请求按路由部分所述路由，任何模式下且无论规则如何。'
type Role = 'orchestrator' | 'worker'
/** 团队可以覆盖的内置部分：读取它的角色、它的文本，以及模板覆盖项必须保留的占位符。 */
interface BuiltInPart { roles: readonly Role[]; text: string; placeholders?: readonly string[] }
const BOTH: readonly Role[] = ['orchestrator', 'worker'], MAIN: readonly Role[] = ['orchestrator'], WORKER: readonly Role[] = ['worker']
let parts: Readonly<Record<PartKey, BuiltInPart>> | undefined
/**
 * 两个角色提示词的内置部分、三个来源技能，以及生成部分的模板（其数据由系统填入），按键索引，覆盖项按该键引用它们。
 * 首次使用时构建，因为它读取的文本存在循环导入。
 */
export const builtInParts = (): Readonly<Record<PartKey, BuiltInPart>> => parts ??= {
  'runtime/shared': { roles: BOTH, text: sharedPrompt }, 'runtime/orchestrator': { roles: MAIN, text: masterPrompt },
  'runtime/worker': { roles: WORKER, text: workerPrompt },
  'runtime/subscriptions': { roles: BOTH, text: `## 订阅\n${guides.subscriptions}` },
  'runtime/replies': { roles: BOTH, text: `## 回复与确认\n${guides.replies}` },
  'runtime/dispatch': { roles: MAIN, text: `## 路由\n${guides.dispatch}` }, 'runtime/work': { roles: WORKER, text: `## 执行\n${guides.work}` },
  'runtime/admission': { roles: MAIN, text: mainAdmissionPolicy },
  'runtime/handoff/orchestrator': { roles: MAIN, text: handoffPolicy('orchestrator') },
  'runtime/handoff/worker': { roles: WORKER, text: handoffPolicy('worker') },
  'runtime/environment': { roles: BOTH, text: `${ENVIRONMENT_HEADING}\n{variables}`, placeholders: ['{variables}'] },
  'runtime/policy': { roles: MAIN, text: `${POLICY_HEAD} 按名称和 ID 列出的启用规则：\n{rules}`, placeholders: ['{version}', '{mode}', '{rules}'] },
  'runtime/policy/none': { roles: MAIN, text: `${POLICY_HEAD} 没有启用任何规则：主动候选只能被忽略。`,
    placeholders: ['{version}', '{mode}'] },
  'skill/feishu': { roles: BOTH, text: `${sourceSkills.feishu}\n\n## CLI 用法\n${cliNotes}` },
  'skill/github': { roles: BOTH, text: `${sourceSkills.github}\n\n## CLI 用法\n${cliNotes}` },
  'skill/gitlab': { roles: BOTH, text: `${sourceSkills.gitlab}\n\n## CLI 用法\n${cliNotes}` },
}
/** 内置文本的键，覆盖项的 `base` 会记录它。 */
export const builtInBase = (text: string): string => key('prompt-built-in', text)
/** 键所指向的内置部分（如果有）；对象原型上的名称不指向任何部分。 */
export const builtInPart = (part: string): BuiltInPart | undefined =>
  Object.hasOwn(builtInParts(), part) ? builtInParts()[part as PartKey] : undefined
/** 内置部分的文本：团队覆盖项，否则为内置文本。 */
const builtIn = (config: PromptConfig, part: PartKey): string =>
  (config.overrides && Object.hasOwn(config.overrides, part) ? config.overrides[part]!.text : undefined) ?? builtInParts()[part].text
/** 一次性填充模板的占位符，这样填入的文本不会被再次当作占位符读取。 */
const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? values[name]! : match)
/** 执行环境部分：带变量的模板；若仍在等待设置，则说明正在等待。 */
export function environmentSection(config: PromptConfig, variables: Variable[] | undefined): string {
  return variables ? fill(builtIn(config, 'runtime/environment'), { variables: environmentLines(variables) })
    : '执行环境：dsh-superagent 正在等待设置；管理面板会说明缺少什么。'
}
/**
 * 主会话的策略部分：它据以评判主动候选的策略版本和 accept 模式，以及设置中保存的所有已启用规则，每条一行，
 * 因此指令中的一行不会被读作独立的规则或标题；设置会限制每条指令（`LIMITS.ruleInstruction`）。
 * `key` 指向它填充自的模板。
 */
export function policySection(settings: Settings, config: PromptConfig = defaultPrompts()): { key: string; text: string } {
  const line = (text: string) => text.replace(/\s*\n\s*/g, ' ')
  const rules = settings.policy.rules.filter(rule => rule.enabled).map(({ id, name, instruction }) => `- ${line(name)} (${id}): ${line(instruction)}`)
  const part = rules.length ? 'runtime/policy' : 'runtime/policy/none'
  return { key: part, text: fill(builtIn(config, part), { version: policyVersion(settings), mode: settings.eval.mode, rules: rules.join('\n') }) }
}
/**
 * 按顺序组装某个角色的系统提示词部分：固定模板、团队部分、生成的执行环境，最后是主会话生成的策略部分；
 * 策略部分之后没有任何内容，它的变化不影响其余部分。
 */
export function promptParts(config: PromptConfig, role: Role, environment?: string, policy?: { key: string; text: string }) {
  // 内置部分会指明其文本被覆盖时使用的键，交接部分中该键即角色名。
  const fixed = (name: string, part = name) => ({ name, kind: 'fixed' as const, key: part, text: builtIn(config, part as PartKey) })
  const team = (name: TeamSection) => ({ name, kind: 'team' as const, heading: `## ${TEAM_HEADINGS[name]}`,
    text: config[name] ? `## ${TEAM_HEADINGS[name]}\n${config[name]}` : '' })
  return [
    fixed('runtime/shared'), fixed(`runtime/${role}`),
    ...TEAM_SECTIONS.map(team),
    ...['subscriptions', 'replies', role === 'orchestrator' ? 'dispatch' : 'work'].map(name => fixed(`runtime/${name}`)),
    ...role === 'orchestrator' ? [fixed('runtime/admission')] : [],
    fixed('runtime/handoff', `runtime/handoff/${role}`),
    ...environment ? [{ name: 'runtime/environment', kind: 'generated' as const, key: 'runtime/environment', text: environment }] : [],
    ...role === 'orchestrator' && policy ? [{ name: 'runtime/policy', kind: 'generated' as const, ...policy }] : [],
  ].filter(part => part.text)
}
export function composePrompt(config: PromptConfig, role: Role, environment?: string, policy?: { key: string; text: string }): string {
  return promptParts(config, role, environment, policy).map(part => part.text).join('\n\n')
}
export function composeSkill(config: PromptConfig, name: string): string {
  return name === 'feishu' || name === 'github' || name === 'gitlab' ? builtIn(config, `skill/${name}`) : config.skills[name] ?? ''
}

/** 自其 `base` 以来内置文本已变化的覆盖项（若保留则带有该文本），或本版本已不存在的部分的覆盖项。 */
export interface DefaultChange { part: string; base?: string; previous?: string; removed?: true }
/**
 * 表示基于过期的基础修订版本保存提示词配置时的乐观并发冲突。
 * 由 `Prompts.save` 抛出，管理路由会将其转换为 HTTP 409 响应。
 */
export class PromptConflict extends Error {}
/**
 * 通过 `Versions` 把带编号的提示词配置存入 `Store`，并结合执行环境组合角色系统提示词和技能。
 * `Sessions` 为编排器和执行器运行读取组合后的提示词和技能，管理路由和工具则通过它校验、预览和保存修订版本。
 */
export class Prompts {
  private readonly versions: Versions<PromptVersion>
  constructor(private readonly store: Store, private readonly maxChars: () => number, private readonly environment: () => Variable[] | undefined,
    private readonly feishu: () => boolean) {
    this.versions = new Versions(store, KV.prompts.revision, KV.prompts.version)
  }
  /** 某个角色的提示词；主会话的策略部分在每次模型请求时按当前设置生成。 */
  compose(config: PromptConfig, role: Role, variables = this.environment()): string {
    return composePrompt(config, role, environmentSection(config, variables), role === 'orchestrator' ? policySection(this.store.settings(), config) : undefined)
  }
  /** 返回要在每个会话中注册的技能：内置来源技能（仅当配置了飞书机器人时才包含 `feishu`），随后是团队技能。 */
  skills(config: PromptConfig): [string, string][] {
    return [...this.feishu() ? ['feishu'] : [], 'github', 'gitlab', ...Object.keys(config.skills)].map(name => [name, composeSkill(config, name)])
  }
  current(): PromptVersion {
    const revision = this.versions.revision()
    return revision ? this.version(revision) : { revision: 0, previousRevision: null, savedAt: '', source: 'defaults', config: defaultPrompts() }
  }
  /** 按编号读取修订版本；在首次保存将其持久化之前，修订版本 0 解析为内置默认值。 */
  version(revision: number): PromptVersion {
    const version = this.versions.get(revision) ?? (revision === 0 && this.versions.revision() === 0 ? this.current() : undefined)
    if (!version) throw new UserError('unknownPromptRevision', { revision: String(revision) })
    return version
  }
  /**
   * 解析一份配置：覆盖项指向某个内置部分，包含文本并保留其模板的占位符，同时记录它编辑自的内置文本：
   * 除非显式指定，否则为已保存覆盖项记录的那份，否则为当前的内置文本。当文本重新等于内置文本时它会被移除；
   * 本版本已不存在的部分，若已保存的版本仍保留，也会被移除。
   */
  validate(value: unknown): PromptConfig {
    const { overrides, ...config } = PromptConfigSchema.parse(value)
    const saved = this.current().config.overrides ?? {}
    const kept = Object.entries(overrides ?? {}).flatMap(([name, override]) => {
      const part = builtInPart(name)
      if (!part && Object.hasOwn(saved, name)) return []
      if (!part) throw new UserError('unknownPromptPart', { part: name })
      if (!override.text.trim()) throw new UserError('promptPartEmpty', { part: name })
      const missing = (part.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      if (missing.length) throw new UserError('promptPlaceholders', { part: name, placeholders: missing.join(', ') })
      const base = override.base ?? (Object.hasOwn(saved, name) ? saved[name]!.base : undefined) ?? builtInBase(part.text)
      return override.text === part.text ? [] : [[name, { text: override.text, base }] as const]
    })
    const result: PromptConfig = { ...config, ...kept.length ? { overrides: Object.fromEntries(kept) } : {} }
    const limit = this.maxChars()
    if (JSON.stringify(result).length > limit) throw new UserError('promptTooLong', { limit: String(limit) })
    return result
  }
  /**
   * `config` 中自团队编辑以来内置部分发生变化的覆盖项，按键为其编辑自的 `base` 列出，若本安装保留了该基础的内置文本
   * 则一并给出；此外还包括本版本已不存在的部分的覆盖项。
   */
  defaultChanged(config: PromptConfig): DefaultChange[] {
    return Object.entries(config.overrides ?? {}).flatMap(([part, { base }]): DefaultChange[] => {
      const now = builtInPart(part)
      if (!now) return [{ part, ...base === undefined ? {} : { base }, removed: true as const }]
      if (base === undefined || base === builtInBase(now.text)) return []
      const previous = this.store.get(KV.prompts.builtIn(base))
      return [{ part, base, ...previous === undefined ? {} : { previous } }]
    })
  }
  preview(value: unknown) {
    const config = this.validate(value)
    const environment = environmentSection(config, this.environment()), policy = policySection(this.store.settings(), config)
    return { orchestrator: composePrompt(config, 'orchestrator', environment, policy), worker: composePrompt(config, 'worker', environment),
      parts: { orchestrator: promptParts(config, 'orchestrator', environment, policy), worker: promptParts(config, 'worker', environment) },
      skills: Object.fromEntries(this.skills(config)), scope: '团队部分、技能与内置部分的覆盖内容；在覆盖之前，它们沿用内置文本。worker 还会继承宿主提示词和仓库的 AGENTS.md。提示词文本改变的是告诉 agent 什么，而不是 dsh-superagent 允许什么：工具权限、准入检查和账户包装保持不变。' }
  }
  save(value: unknown, baseRevision: number, source: SettingsOrigin): PromptVersion {
    const config = this.validate(value)
    return this.store.atomic(() => {
      const previous = this.current()
      if (previous.revision !== baseRevision) throw new PromptConflict(`Prompt version changed to ${previous.revision}; compare the latest version before saving`)
      // 在记录第一个自定义修订版本之前，先把内置默认值持久化为修订版本 0。
      if (previous.revision === 0 && !this.versions.get(0)) this.versions.keep(previous)
      // 每个覆盖项编辑自的内置文本，保留以便展示升级对其做了哪些更改。
      for (const [part, { base }] of Object.entries(config.overrides ?? {})) {
        const text = builtInParts()[part as PartKey].text
        if (base === builtInBase(text) && this.store.get(KV.prompts.builtIn(base)) === undefined) this.store.set(KV.prompts.builtIn(base), text)
      }
      return this.versions.save(revision => ({ revision, previousRevision: previous.revision, savedAt: new Date().toISOString(), source, config }))
    })
  }
  history(offset = 0, limit = 20) {
    const current = this.current()
    const revisions = Array.from({ length: Math.min(limit, Math.max(0, current.revision + 1 - offset)) }, (_, i) => {
      const version = current.revision - offset - i === 0 && current.revision === 0 ? current : this.version(current.revision - offset - i)
      const { config, ...summary } = version
      const previous = version.previousRevision === null ? undefined : this.versions.get(version.previousRevision)?.config
      // 团队部分之前的修订版本无法逐字段比较。
      const legacy = version.legacy || (version.previousRevision !== null && this.versions.get(version.previousRevision)?.legacy)
      if (legacy) return { ...summary, changed: ['legacy'] }
      const entries = (value: PromptConfig) => ({ communication: value.communication, scope: value.scope, delivery: value.delivery,
        ...Object.fromEntries(Object.entries(value.skills).map(([name, text]) => ['skill/' + name, text])),
        // 覆盖项会随其文本或其所编辑自的内置文本而变化。
        ...Object.fromEntries(Object.entries(value.overrides ?? {}).map(([part, override]) => [part, JSON.stringify(override)])) })
      const before = previous ? entries(previous) : {}
      const after = entries(config)
      const changed = previous ? [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => (before as Record<string, string>)[name] !== (after as Record<string, string>)[name]) : []
      return { ...summary, changed }
    })
    return { revisions, next_offset: offset + revisions.length <= current.revision ? offset + revisions.length : null }
  }
}
/** 保存新的提示词修订版本，并在变更来自主会话自身工具调用之外时通知主会话。 */
export async function savePrompts(host: { store: Pick<Store, 'atomic'>; prompts: Pick<Prompts, 'save'>; sessions: Pick<Sessions, 'notify' | 'delivery'> },
  config: unknown, baseRevision: number, origin: SettingsOrigin) {
  const version = host.store.atomic(() => {
    const saved = host.prompts.save(config, baseRevision, origin)
    if (origin !== 'tool') host.sessions.notify(...promptsNotice(saved.revision))
    return saved
  })
  return { revision: version.revision, effect: 'next-request' as const, context_delivery: await host.sessions.delivery('prompts') }
}
