/** 执行环境按工单来源记录注入变量：其他记录不进入该工单，同名变量不再互相覆盖。 */
import { describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
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
