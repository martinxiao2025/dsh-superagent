/** 执行环境按工单来源记录注入变量：其他记录不进入该工单，同名变量不再互相覆盖。 */
import { describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { environmentOf, projectDirectory, projectDirectoryName, ticketDirectoryName } from '../src/app/execution-environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment, testFeishu } from './fixtures/deployment.ts'
import type { Variable } from '../src/app/execution-environment.ts'

/** 三条已启用的飞书记录：alpha 与 beta 用来验证同名变量不会互相覆盖。 */
const settings = () => SettingsSchema.parse({ sources: {
  alpha: { kind: 'feishu', name: 'Alpha', enabled: true, config: {} },
  beta: { kind: 'feishu', name: 'Beta', enabled: true, config: {} },
  feishu: { kind: 'feishu', name: 'Feishu', enabled: true, config: {} },
} })
/** 与 `settings` 对应的已解析来源。 */
const deployment = testDeployment({ sources: {
  alpha: testFeishu({ id: 'alpha', name: 'Alpha Bot', botId: 'ou_alpha' }),
  beta: testFeishu({ id: 'beta', name: 'Beta Bot', botId: 'ou_beta' }),
  feishu: testFeishu(),
} })
/** 新建一个注册了飞书适配器的注册表。 */
const registry = (): SourceRegistry => {
  const sources = new SourceRegistry(settings)
  sources.register(feishuKind)
  return sources
}
const ticket = { id: 't1', name: 'fix', directory: '/work/fix' }
/** 只关心来源记录的触发器；线程与配置让执行环境取出该工单的飞书群。 */
const trigger = (source: string): Trigger => ({ source, threads: [{ source, id: 'thread' }], meta: { chatId: 'oc_team' } }) as unknown as Trigger
/** 变量列表转为按键索引的对象，便于断言同名键只剩一个值。 */
const keys = (variables: Variable[]): Record<string, string> => Object.fromEntries(variables.map(variable => [variable.key, variable.value]))

describe('ticket execution environment', () => {
  it('injects only the ticket\'s own Source record, so records with the same variable names cannot overwrite each other', () => {
    const values = keys(environmentOf({ deployment, sources: registry(), settings: settings(), ticket, trigger: trigger('alpha') }))
    expect(values.DSH_SUPERAGENT_SOURCE).toBe('alpha')
    expect(values.DSH_SUPERAGENT_FEISHU_BOT).toBe('Alpha Bot')
    expect(values.DSH_SUPERAGENT_FEISHU_CHAT).toBe('oc_team')
    // 另一条飞书记录不进入这个工单。
    expect(Object.keys(values).filter(key => key === 'DSH_SUPERAGENT_FEISHU_BOT')).toHaveLength(1)
    expect(values.DSH_SUPERAGENT_FEISHU_BOT).not.toBe('Beta Bot')
    expect(Object.keys(keys(environmentOf({ deployment, sources: registry(), settings: settings(), ticket, trigger: trigger('beta') })))
      .filter(key => key === 'DSH_SUPERAGENT_FEISHU_BOT')).toHaveLength(1)
  })
  it('injects no Source record variables when the ticket has lost its trigger', () => {
    const values = keys(environmentOf({ deployment, sources: registry(), settings: settings(), ticket }))
    expect(values.DSH_SUPERAGENT_SOURCE).toBe('')
    expect(Object.keys(values).filter(key => /^DSH_SUPERAGENT_FEISHU_/.test(key))).toEqual([])
  })
  it('keeps every enabled record in the declaration view used without a ticket', () => {
    const variables = environmentOf({ deployment, sources: registry(), settings: settings() })
    expect(variables.filter(variable => variable.key === 'DSH_SUPERAGENT_FEISHU_BOT').map(variable => variable.value)).toEqual(['Alpha Bot', 'Beta Bot', 'Widgets Bot'])
    expect(variables.some(variable => variable.key === 'DSH_SUPERAGENT_SOURCE')).toBe(false)
    expect(variables.some(variable => variable.key === 'DSH_SUPERAGENT_FEISHU_CHAT')).toBe(true)
  })
})

describe('project directory names', () => {
  /** 代码仓库记录不属于消息来源，因此不参与工单项目目录。 */
  const withCodeRepos = (repos: Record<string, string>) => SettingsSchema.parse({ codeRepos: Object.fromEntries(
    Object.entries(repos).map(([id, repository]) => [id, { kind: 'github', name: id, enabled: true, config: { repository } }])) })

  it('names the directory after the ticket\'s Source record, never after the ticket', () => {
    const value = SettingsSchema.parse({ sources: { alpha: { kind: 'feishu', name: 'Alpha', enabled: true, config: {} } } })
    expect(projectDirectory(value, 'alpha', 'ticket-name')).toBe('alpha')
  })

  it('falls back to the worktree name without a Source record, including for a code repository id', () => {
    const value = withCodeRepos({ alpha: 'acme/Demo.ProjectOnline' })
    expect(projectDirectory(value, 'alpha', 'quiet-otter-123456789012')).toBe('quiet-otter-123456789012')
    expect(projectDirectory(value, undefined, 'quiet-otter-123456789012')).toBe('quiet-otter-123456789012')
  })

  it('strips path separators, Windows-illegal characters and trailing dots, and escapes reserved device names', () => {
    expect(projectDirectoryName('acme\\app')).toBe('app')
    expect(projectDirectoryName('acme/app.')).toBe('app')
    expect(projectDirectoryName('..')).toBe('')
    expect(projectDirectoryName('CON')).toBe('project-CON')
    expect(projectDirectoryName('a:b*c?')).toBe('a-b-c-')
  })
})

describe('ticket directory names', () => {
  it('keeps an id that is already a safe directory name unchanged', () => {
    expect(ticketDirectoryName('0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef')
  })

  it('sanitizes illegal ids by the same rules as project names and adds a hash so distinct ids never share a directory', () => {
    expect(ticketDirectoryName('a/b')).toMatch(/^b-[0-9a-f]{12}$/)
    // 不同原始 id 清洗后相同，但哈希后缀把它们分开。
    expect(ticketDirectoryName('a/b')).not.toBe(ticketDirectoryName('a\\b'))
    expect(ticketDirectoryName('CON')).toMatch(/^project-CON-[0-9a-f]{12}$/)
  })

  it('falls back to a hashed ticket directory when nothing usable remains', () => {
    expect(ticketDirectoryName('..')).toMatch(/^ticket-[0-9a-f]{12}$/)
    expect(ticketDirectoryName('')).toMatch(/^ticket-[0-9a-f]{12}$/)
    // 结果只由 id 决定，便于重试与重启后落到同一目录。
    expect(ticketDirectoryName('..')).toBe(ticketDirectoryName('..'))
  })
})
