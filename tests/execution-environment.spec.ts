/** 执行环境按工单来源记录注入变量：其他记录不进入该工单，同名变量不再互相覆盖。 */
import { describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { environmentOf, projectDirectory, projectDirectoryName, ticketDirectoryName } from '../src/app/execution-environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment, testFeishu, testGithub } from './fixtures/deployment.ts'
import type { Variable } from '../src/app/execution-environment.ts'

/** 三条已启用记录：两条 GitHub（同名变量）与一条飞书。 */
const settings = () => SettingsSchema.parse({ sources: {
  alpha: { kind: 'github', enabled: true, config: { repository: 'acme/alpha' } },
  beta: { kind: 'github', enabled: true, config: { repository: 'acme/beta' } },
  feishu: { kind: 'feishu', enabled: true, config: {} },
} })
/** 与 `settings` 对应的已解析来源。 */
const deployment = testDeployment({ sources: {
  alpha: testGithub({ id: 'alpha', repository: 'acme/alpha', login: 'alpha-bot' }),
  beta: testGithub({ id: 'beta', repository: 'acme/beta', login: 'beta-bot' }),
  feishu: testFeishu(),
} })
/** 新建一个注册了 GitHub 与飞书适配器的注册表。 */
const registry = (): SourceRegistry => {
  const sources = new SourceRegistry(settings)
  sources.register(githubKind); sources.register(feishuKind)
  return sources
}
const ticket = { id: 't1', name: 'fix', directory: '/work/fix' }
/** 只关心来源记录的触发器；`threads` 为空表示工单不是由 Issue 或 PR 发起。 */
const trigger = (source: string): Trigger => ({ source, threads: [] }) as unknown as Trigger
/** 变量列表转为按键索引的对象，便于断言同名键只剩一个值。 */
const keys = (variables: Variable[]): Record<string, string> => Object.fromEntries(variables.map(variable => [variable.key, variable.value]))

describe('ticket execution environment', () => {
  it('injects only the ticket\'s own Source record, so records with the same variable names cannot overwrite each other', () => {
    const values = keys(environmentOf({ deployment, sources: registry(), settings: settings(), ticket, trigger: trigger('alpha') }))
    expect(values.DSH_SUPERAGENT_SOURCE).toBe('alpha')
    expect(values.DSH_SUPERAGENT_GITHUB_REPOSITORY).toBe('acme/alpha')
    expect(values.DSH_SUPERAGENT_GITHUB_ACCOUNT).toBe('alpha-bot')
    // 另一条 GitHub 记录与飞书记录都不进入这个工单。
    expect(Object.keys(values).filter(key => key.startsWith('DSH_SUPERAGENT_FEISHU_'))).toEqual([])
    expect(Object.keys(keys(environmentOf({ deployment, sources: registry(), settings: settings(), ticket, trigger: trigger('beta') })))
      .filter(key => key === 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).toHaveLength(1)
  })
  it('injects no Source record variables when the ticket has lost its trigger', () => {
    const values = keys(environmentOf({ deployment, sources: registry(), settings: settings(), ticket }))
    expect(values.DSH_SUPERAGENT_SOURCE).toBe('')
    expect(Object.keys(values).filter(key => /^DSH_SUPERAGENT_(GITHUB|FEISHU)_/.test(key))).toEqual([])
  })
  it('keeps every enabled record in the declaration view used without a ticket', () => {
    const variables = environmentOf({ deployment, sources: registry(), settings: settings() })
    expect(variables.filter(variable => variable.key === 'DSH_SUPERAGENT_GITHUB_REPOSITORY').map(variable => variable.value)).toEqual(['acme/alpha', 'acme/beta'])
    expect(variables.some(variable => variable.key === 'DSH_SUPERAGENT_SOURCE')).toBe(false)
    expect(variables.some(variable => variable.key === 'DSH_SUPERAGENT_FEISHU_CHAT')).toBe(true)
  })
})

describe('project directory names', () => {
  /** 用给定的 GitHub 仓库构造设置，用于验证项目名与同名冲突。 */
  const withRepos = (repos: Record<string, string>) => SettingsSchema.parse({ sources: Object.fromEntries(
    Object.entries(repos).map(([id, repository]) => [id, { kind: 'github', enabled: true, config: { repository } }])) })

  it('names the directory after the repository, never after the ticket', () => {
    const value = withRepos({ alpha: 'acme/Demo.ProjectOnline' })
    expect(projectDirectory(value, 'alpha', 'ticket-name')).toBe('Demo.ProjectOnline')
  })

  it('falls back to the record id for sources without a project, and to the worktree name without a record', () => {
    const value = SettingsSchema.parse({ sources: { feishu: { kind: 'feishu', enabled: true, config: {} } } })
    expect(projectDirectory(value, 'feishu', 'ticket-name')).toBe('feishu')
    expect(projectDirectory(value, undefined, 'quiet-otter-123456789012')).toBe('quiet-otter-123456789012')
  })

  it('suffixes both records when two projects sanitize to the same name instead of sharing a directory', () => {
    const value = withRepos({ alpha: 'acme/app', beta: 'other/app' })
    expect(projectDirectory(value, 'alpha', 'x')).toBe('app-alpha')
    expect(projectDirectory(value, 'beta', 'x')).toBe('app-beta')
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
