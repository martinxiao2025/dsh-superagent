/** 飞书凭据：独立存储、引用计数、轮换与身份/知识库探测的注入实现。 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import type { FeishuCredential } from '../src/feishu-credentials/kind.ts'
import { FeishuCredentials, classifyFeishuError, type FeishuCredentialRepository } from '../src/feishu-credentials/service.ts'
import { SecretVault } from '../src/secrets/vault.ts'

const temporary = (): string => mkdtempSync(join(tmpdir(), 'dsh-feishu-credential-'))

function setup(referenced: string[] = []) {
  const stateDir = temporary()
  const vault = new SecretVault(stateDir)
  const records = new Map<string, FeishuCredential>()
  const repository: FeishuCredentialRepository = { get: id => records.get(id), list: () => [...records.values()],
    save: value => { records.set(value.id, value) }, remove: id => { records.delete(id) } }
  const probe = vi.fn(async (input: { spaceId?: string }) => ({ nodes: input.spaceId ? 2 : 0 }))
  const credentials = new FeishuCredentials({ credentials: repository, vault, references: () => referenced, probe,
    now: () => '2026-11-11T00:00:00Z' })
  return { stateDir, vault, records, probe, credentials, referenced }
}

describe('Feishu credentials', () => {
  it('stores the app secret encrypted and only shows a mask', () => {
    const { credentials, vault } = setup()
    const { id, revision } = credentials.create({ name: 'Task Bot', mode: 'app', appId: 'cli_123', appSecret: 'app_secret' })
    expect(id).toBe('task-bot')
    expect(revision).toBe(1)
    expect(vault.read('feishu', id)).toEqual({ appSecret: 'app_secret' })
    const view = credentials.get(id)
    expect(view).toMatchObject({ id, name: 'Task Bot', mode: 'app', appId: 'cli_123', configured: true, revision: 1 })
    expect(view.hint).toBe('••••cret')
    expect(view.fingerprint).toHaveLength(16)
    expect(JSON.stringify(view)).not.toContain('app_secret')
    // Git 区看不到飞书凭据的材料。
    expect(vault.read('git', id)).toBeUndefined()
  })

  it('requires an app id and secret in app mode, and a CLI in CLI mode', () => {
    const { credentials } = setup()
    expect(() => credentials.create({ name: 'no secret', mode: 'app', appId: 'cli_123' })).toThrow(UserError)
    expect(() => credentials.create({ name: 'no id', mode: 'app', appSecret: 'secret' })).toThrow(/App ID and secret/)
    expect(() => credentials.create({ name: 'no cli', mode: 'cli' })).toThrow(/CLI executable/)
    const { id } = credentials.create({ name: 'lark cli', mode: 'cli', cli: 'lark' })
    expect(credentials.get(id)).toMatchObject({ mode: 'cli', cli: 'lark', configured: true, hint: '', fingerprint: '' })
  })

  it('requires the current revision and replaces the secret on update', () => {
    const { credentials } = setup()
    const { id } = credentials.create({ name: 'bot', mode: 'app', appId: 'cli_1', appSecret: 'one' })
    const before = credentials.get(id)
    expect(() => credentials.update(id, { name: 'bot', mode: 'app', appId: 'cli_1' }, 9)).toThrow(/changed since it was loaded/)
    const { revision } = credentials.update(id, { name: 'bot 2', mode: 'app', appId: 'cli_2', appSecret: 'two' }, before.revision)
    expect(revision).toBe(2)
    const after = credentials.get(id)
    expect(after).toMatchObject({ name: 'bot 2', appId: 'cli_2', revision: 2 })
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('rotates the secret only and refuses to delete a referenced credential', () => {
    const { credentials, vault, referenced } = setup()
    const { id } = credentials.create({ name: 'bot', mode: 'app', appId: 'cli_1', appSecret: 'one' })
    expect(credentials.rotate(id, { appSecret: 'two' }).revision).toBe(2)
    expect(vault.read('feishu', id)).toEqual({ appSecret: 'two' })
    referenced.push(id)
    expect(() => credentials.remove(id)).toThrow(/still used by 1 TaskSources/)
    referenced.length = 0
    expect(credentials.remove(id)).toEqual({ removed: true })
    expect(vault.read('feishu', id)).toBeUndefined()
  })

  it('verifies the app identity and reads the wiki when a space is given', async () => {
    const { credentials, probe } = setup()
    const { id } = credentials.create({ name: 'bot', mode: 'app', appId: 'cli_1', appSecret: 'app_secret' })
    const checks = await credentials.verify({ id, spaceId: '742000000000000001' })
    expect(probe).toHaveBeenCalledWith({ mode: 'app', appId: 'cli_1', appSecret: 'app_secret', cli: '', spaceId: '742000000000000001' })
    expect(checks).toEqual([
      { field: 'identity', ok: true, scope: 'check', code: 'feishuCredentialAppOk', values: { appId: 'cli_1', secret: '••••cret' } },
      { field: 'space', ok: true, scope: 'check', code: 'feishuCredentialSpaceOk', values: { spaceId: '742000000000000001' } },
    ])
  })

  it('reports a skipped wiki, a missing draft and an empty space without pretending they are failures', async () => {
    const { credentials, probe } = setup()
    const skipped = await credentials.verify({ input: { name: 'bot', mode: 'app', appId: 'cli_1', appSecret: 'secret' } })
    expect(skipped.at(-1)).toMatchObject({ field: 'space', ok: true, code: 'feishuCredentialSpaceSkipped' })
    expect(probe).toHaveBeenCalledOnce()
    await expect(credentials.verify({ input: { name: 'bot', mode: 'app' } })).resolves.toEqual([
      { field: 'identity', ok: false, scope: 'check', code: 'feishuCredentialMaterialMissing', values: {} }])
    probe.mockResolvedValueOnce({ nodes: 0 })
    const empty = await credentials.verify({ input: { name: 'bot', mode: 'app', appId: 'cli_1', appSecret: 'secret' },
      spaceId: 'space' })
    expect(empty.at(-1)).toMatchObject({ field: 'space', ok: true, code: 'feishuCredentialSpaceEmpty' })
  })

  it('classifies probe failures and keeps unreadable material visible', async () => {
    expect(classifyFeishuError(new Error('permission denied'))).toBe('feishuCredentialForbidden')
    expect(classifyFeishuError(new Error('99991400 rate limit'))).toBe('feishuCredentialRateLimited')
    expect(classifyFeishuError(new Error('fetch failed'))).toBe('feishuCredentialUnreachable')
    expect(classifyFeishuError(new Error('1234 not found'))).toBe('feishuCredentialSpaceMissing')
    expect(classifyFeishuError(new Error('boom'))).toBe('feishuCredentialProbeFailed')
    const { credentials, probe, stateDir } = setup()
    const { id } = credentials.create({ name: 'bot', mode: 'app', appId: 'cli_1', appSecret: 'secret' })
    probe.mockRejectedValueOnce(new Error('99991663 permission denied'))
    const checks = await credentials.verify({ id, spaceId: 'space' })
    expect(checks.at(-1)).toMatchObject({ field: 'space', ok: false, code: 'feishuCredentialForbidden',
      values: { spaceId: 'space', error: '99991663 permission denied' } })
    writeFileSync(join(stateDir, 'secrets', 'feishu', `${id}.json`), '{"v":1,"iv":"AAAA","tag":"AAAA","data":"AAAA"}', 'utf8')
    expect(credentials.get(id)).toMatchObject({ configured: false, fingerprint: '' })
    await expect(credentials.verify({ id })).resolves.toEqual([{ field: 'material', ok: false, scope: 'check',
      code: 'feishuCredentialUnreadable', values: {} }])
  })
})
