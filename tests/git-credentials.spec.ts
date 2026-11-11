/** Git 凭据：独立存储、引用计数、轮换与真实探测的注入实现。 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import type { GitCredential } from '../src/git-credentials/kind.ts'
import { GitCredentials, classifyProbeError, type GitCredentialRepository } from '../src/git-credentials/service.ts'
import { SecretVault } from '../src/secrets/vault.ts'

const temporary = (): string => mkdtempSync(join(tmpdir(), 'dsh-git-credential-'))
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----'

function setup(projects: Record<string, { gitCredential?: string }> = {}) {
  const stateDir = temporary()
  const vault = new SecretVault(stateDir)
  const records = new Map<string, GitCredential>()
  const repository: GitCredentialRepository = { get: id => records.get(id), list: () => [...records.values()],
    save: value => { records.set(value.id, value) }, remove: id => { records.delete(id) } }
  const probe = vi.fn(async () => ({ branches: 3 }))
  const credentials = new GitCredentials({ credentials: repository, vault, projects: () => projects, probe,
    now: () => '2026-11-11T00:00:00Z' })
  return { stateDir, vault, records, probe, credentials }
}

const ssh = (name = '部署机器人') => ({ name, kind: 'ssh' as const, provider: 'github' as const, privateKey: KEY })

describe('Git credentials', () => {
  it('stores the material encrypted and exposes only a mask and fingerprint', () => {
    const { credentials, vault } = setup()
    const { id, revision } = credentials.create(ssh('Deploy Bot Key'))
    expect(id).toBe('deploy-bot-key')
    expect(revision).toBe(1)
    expect(vault.read('git', id)).toEqual({ privateKey: KEY })
    const view = credentials.get(id)
    expect(view).toMatchObject({ id, name: 'Deploy Bot Key', kind: 'ssh', configured: true, origin: 'pasted', revision: 1 })
    expect(view.fingerprint).toHaveLength(16)
    expect(view.hint).toBe('private key')
    expect(JSON.stringify(view)).not.toContain('BEGIN OPENSSH')
  })

  it('refuses to create a credential without material', () => {
    const { credentials } = setup()
    expect(() => credentials.create({ name: 'empty', kind: 'ssh' })).toThrow(UserError)
    expect(() => credentials.create({ name: 'empty', kind: 'https' })).toThrow(/private key or an access token/)
  })

  it('reads a local key file and rejects relative or missing paths', () => {
    const { credentials } = setup()
    const file = join(temporary(), 'id_ed25519')
    writeFileSync(file, KEY, 'utf8')
    const { id } = credentials.create({ name: 'file key', kind: 'ssh', keyPath: file })
    expect(credentials.get(id)).toMatchObject({ origin: 'file', keyPath: file, configured: true })
    expect(() => credentials.create({ name: 'relative', kind: 'ssh', keyPath: 'id_ed25519' }))
      .toThrow(/must be absolute/)
    expect(() => credentials.create({ name: 'missing', kind: 'ssh', keyPath: join(temporary(), 'absent') }))
      .toThrow(/does not exist/)
  })

  it('requires the current revision and replaces material on update', () => {
    const { credentials } = setup()
    const { id } = credentials.create({ name: 'token', kind: 'https', token: 'ghp_one' })
    const before = credentials.get(id)
    expect(() => credentials.update(id, { name: 'token', kind: 'https' }, 9)).toThrow(/changed since it was loaded/)
    const { revision } = credentials.update(id, { name: 'token 2', kind: 'https', token: 'ghp_two' }, before.revision)
    expect(revision).toBe(2)
    const after = credentials.get(id)
    expect(after.name).toBe('token 2')
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.hint).toBe('••••_two')
  })

  it('rotates material only and bumps the revision', () => {
    const { credentials, vault } = setup()
    const { id } = credentials.create(ssh())
    const { revision } = credentials.rotate(id, { privateKey: KEY.replace('key', 'rotated') })
    expect(revision).toBe(2)
    expect(vault.read('git', id)?.privateKey).toContain('rotated')
  })

  it('refuses to delete a credential a Project still references', () => {
    const projects: Record<string, { gitCredential?: string }> = {}
    const { credentials, vault } = setup(projects)
    const { id } = credentials.create(ssh())
    projects.content = { gitCredential: id }
    expect(() => credentials.remove(id)).toThrow(/still used by 1 Projects/)
    delete projects.content
    expect(credentials.remove(id)).toEqual({ removed: true })
    expect(vault.read('git', id)).toBeUndefined()
  })

  it('verifies material and probes the remote with the stored secret', async () => {
    const { credentials, probe } = setup()
    const { id } = credentials.create({ name: 'token', kind: 'https', token: 'ghp_secret' })
    const checks = await credentials.verify({ id, repository: 'https://github.com/acme/widgets.git' })
    expect(probe).toHaveBeenCalledWith({ remote: 'https://github.com/acme/widgets.git', kind: 'https',
      material: { token: 'ghp_secret' } })
    expect(checks).toEqual([
      { field: 'material', ok: true, scope: 'check', code: 'gitCredentialMaterialOk', values: { hint: '••••cret' } },
      { field: 'repository', ok: true, scope: 'check', code: 'gitCredentialRemoteOk', values: { branches: '3' } },
    ])
  })

  it('reports a malformed key without probing, and a mismatched remote', async () => {
    const { credentials, probe } = setup()
    const checks = await credentials.verify({ input: { name: 'x', kind: 'ssh', privateKey: 'not a key' } })
    expect(checks).toEqual([{ field: 'material', ok: true, scope: 'check', code: 'gitCredentialMaterialOk',
      values: { hint: '' } }, { field: 'key', ok: false, scope: 'check', code: 'gitCredentialKeyInvalid', values: {} }])
    const mismatch = await credentials.verify({ input: { name: 'x', kind: 'https', token: 't' }, repository: 'git@github.com:a/b.git' })
    expect(mismatch.at(-1)).toMatchObject({ field: 'repository', ok: false, code: 'gitCredentialKindMismatch' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('classifies probe failures and redacts credentials in the message', async () => {
    expect(classifyProbeError(new Error('fatal: could not read from remote repository: Permission denied'))).toBe('gitCredentialForbidden')
    expect(classifyProbeError(new Error('ssh: Could not resolve hostname github.com'))).toBe('gitCredentialUnreachable')
    expect(classifyProbeError(new Error('repository not found'))).toBe('gitCredentialRepositoryMissing')
    expect(classifyProbeError(new Error('weird failure'))).toBe('gitCredentialProbeFailed')
    const { credentials, probe } = setup()
    probe.mockRejectedValueOnce(new Error("fatal: Authentication failed for 'https://user:secret@github.com/acme/widgets.git/'"))
    const { id } = credentials.create({ name: 'token', kind: 'https', token: 't' })
    const checks = await credentials.verify({ id, repository: 'https://github.com/acme/widgets.git' })
    const repository = checks.find(check => check.field === 'repository')
    expect(repository).toMatchObject({ ok: false, code: 'gitCredentialForbidden' })
    expect(repository?.values?.error).not.toContain('secret')
    expect(repository?.values?.error).toContain('//***@')
  })

  it('reports unreadable stored material instead of a usable credential', async () => {
    const { credentials, vault, stateDir } = setup()
    const { id } = credentials.create({ name: 'token', kind: 'https', token: 't' })
    writeFileSync(join(stateDir, 'secrets', 'git', `${id}.json`), '{"v":1,"iv":"AAAA","tag":"AAAA","data":"AAAA"}', 'utf8')
    expect(credentials.get(id)).toMatchObject({ configured: false, fingerprint: '' })
    await expect(credentials.verify({ id })).resolves.toEqual([{ field: 'material', ok: false, scope: 'check',
      code: 'gitCredentialUnreadable', values: {} }])
    expect(() => vault.read('git', id)).toThrow()
  })
})
