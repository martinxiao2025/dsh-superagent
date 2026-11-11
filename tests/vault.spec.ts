/** 凭据材料存储：分区隔离、AES-GCM 加密、掩码与指纹、损坏与 ID 校验。 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SecretError, SecretVault, fingerprint, mask } from '../src/secrets/vault.ts'

const temporary = (): string => mkdtempSync(join(tmpdir(), 'dsh-vault-'))

describe('secret vault', () => {
  it('round-trips material and never writes it in plain text', () => {
    const stateDir = temporary()
    const vault = new SecretVault(stateDir)
    vault.save('git', 'deploy-key', { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n', passphrase: '' })
    expect(vault.read('git', 'deploy-key')).toEqual({ privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n' })
    const file = join(stateDir, 'secrets', 'git', 'deploy-key.json')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('BEGIN OPENSSH')
    // 密钥单独落盘，且在另一个实例里仍可解密。
    expect(existsSync(join(stateDir, 'secrets', 'key'))).toBe(true)
    expect(new SecretVault(stateDir).read('git', 'deploy-key')).toEqual({ privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n' })
  })

  it('keeps the Git and Feishu areas apart', () => {
    const stateDir = temporary()
    const vault = new SecretVault(stateDir)
    vault.save('git', 'shared-id', { token: 'ghp_token' })
    expect(vault.read('feishu', 'shared-id')).toBeUndefined()
    vault.save('feishu', 'shared-id', { appSecret: 'app_secret' })
    expect(vault.read('git', 'shared-id')).toEqual({ token: 'ghp_token' })
    expect(vault.read('feishu', 'shared-id')).toEqual({ appSecret: 'app_secret' })
    expect(readdirSync(join(stateDir, 'secrets')).sort()).toEqual(['feishu', 'git', 'key'])
  })

  it('returns undefined for missing material and removes what it wrote', () => {
    const vault = new SecretVault(temporary())
    expect(vault.read('git', 'never-saved')).toBeUndefined()
    vault.save('git', 'temp', { token: 'x' })
    vault.remove('git', 'temp')
    expect(vault.read('git', 'temp')).toBeUndefined()
    expect(() => vault.remove('git', 'temp')).not.toThrow()
  })

  it('reports corrupt material instead of guessing', () => {
    const stateDir = temporary()
    const vault = new SecretVault(stateDir)
    vault.save('git', 'broken', { token: 'x' })
    writeFileSync(join(stateDir, 'secrets', 'git', 'broken.json'), '{"v":1,"iv":"AAAA","tag":"AAAA","data":"AAAA"}', 'utf8')
    expect(() => vault.read('git', 'broken')).toThrow(SecretError)
    try { vault.read('git', 'broken') } catch (error) { expect(error).toMatchObject({ code: 'secretCorrupt' }) }
  })

  it('refuses ids that could escape the credential directory', () => {
    const vault = new SecretVault(temporary())
    for (const id of ['../escape', 'Upper', 'has space', '中文']) {
      expect(() => vault.save('git', id, { token: 'x' })).toThrow(SecretError)
      expect(() => vault.read('git', id)).toThrow(SecretError)
    }
  })

  it('creates temporary material with the requested name for callers to delete', () => {
    const vault = new SecretVault(temporary())
    const file = vault.temporary('git', 'id_ed25519', 'key material')
    expect(file.endsWith('id_ed25519')).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('key material')
    rmSync(file)
    expect(existsSync(file)).toBe(false)
  })

  it('masks all but the last four characters and fingerprints material stably', () => {
    expect(mask('abcdefgh')).toBe('••••efgh')
    expect(mask(' abc ')).toBe('••••')
    expect(mask('')).toBe('••••')
    expect(fingerprint('secret')).toHaveLength(16)
    expect(fingerprint('secret')).toBe(fingerprint('secret'))
    expect(fingerprint('secret')).not.toBe(fingerprint('secret '))
  })
})
