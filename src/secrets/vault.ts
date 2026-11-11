/**
 * 凭据材料的加密存储与掩码：Git 凭据与飞书凭据各自一个目录，每条记录一个文件。
 * 密钥保存在 `<stateDir>/secrets/key`，首次使用时生成；材料不会进入设置快照。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 独立凭据区域：两个模块各自一个目录，互不读取对方的材料。 */
export type SecretArea = 'git' | 'feishu'
/** 材料只允许字符串键值；空字符串表示未填写，不会被写入文件。 */
export type SecretMaterial = Record<string, string>
/** 加密存储或读取失败；`code` 供上层映射成凭据错误码。 */
export class SecretError extends Error {
  constructor(readonly code: 'secretCorrupt' | 'secretUnreadable' | 'secretInvalidId', message: string) {
    super(message)
    this.name = 'SecretError'
  }
}
interface Envelope { v: 1; iv: string; tag: string; data: string }
const ID = /^[a-z][a-z0-9-]*$/

/** 掩码：保留末 4 位，其余用圆点代替；空值返回 `••••`。 */
export function mask(secret: string): string {
  const text = secret.trim()
  return text.length <= 4 ? '••••' : `••••${text.slice(-4)}`
}
/** 材料指纹（SHA-256 前 16 位十六进制）；轮换后变化，用来提示引用方复验。 */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

/** 加密材料存储：一区一目录，密钥单独落盘；记录只保存引用，材料不进设置快照。 */
export class SecretVault {
  constructor(private readonly stateDir: string) {}
  private areas(area?: SecretArea): string { return area === undefined ? join(this.stateDir, 'secrets') : join(this.stateDir, 'secrets', area) }
  /** 读取或首次生成 32 字节主密钥；文件权限尽量收紧到 0600。 */
  private key(): Buffer {
    const file = join(this.areas(), 'key')
    if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
    mkdirSync(this.areas(), { recursive: true, mode: 0o700 })
    const created = randomBytes(32)
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, created.toString('base64'), { mode: 0o600 })
    renameSync(temporary, file)
    this.restrict(file)
    return created
  }
  /** Windows 没有 POSIX 权限位，`chmod` 失败时保持默认权限即可。 */
  private restrict(file: string): void {
    try { chmodSync(file, 0o600) } catch { /* 非 POSIX 平台忽略。 */ }
  }
  private file(area: SecretArea, id: string): string {
    if (!ID.test(id)) throw new SecretError('secretInvalidId', `Invalid credential id: ${id}`)
    return join(this.areas(area), `${id}.json`)
  }
  /** 写入整份材料，覆盖旧值；空字符串字段不会落盘。 */
  save(area: SecretArea, id: string, material: SecretMaterial): void {
    const file = this.file(area, id)
    mkdirSync(this.areas(area), { recursive: true, mode: 0o700 })
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv)
    const body = JSON.stringify(Object.fromEntries(Object.entries(material).filter(([, value]) => value !== '')))
    const data = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()])
    const envelope: Envelope = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600 })
    renameSync(temporary, file)
    this.restrict(file)
  }
  /** 读取材料；文件不存在返回 undefined，损坏或无法解密抛出 `SecretError`。 */
  read(area: SecretArea, id: string): SecretMaterial | undefined {
    const file = this.file(area, id)
    if (!existsSync(file)) return undefined
    let envelope: Envelope
    try { envelope = JSON.parse(readFileSync(file, 'utf8')) as Envelope }
    catch (error) { throw new SecretError('secretCorrupt', `The ${area} credential ${id} is unreadable: ${error instanceof Error ? error.message : String(error)}`) }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')
      return JSON.parse(plain) as SecretMaterial
    } catch (error) {
      throw new SecretError('secretCorrupt', `The ${area} credential ${id} cannot be decrypted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /** 删除材料；不存在时为空操作。 */
  remove(area: SecretArea, id: string): void {
    try { rmSync(this.file(area, id), { force: true }) } catch (error) {
      throw new SecretError('secretUnreadable', `The ${area} credential ${id} could not be removed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /** 生成临时材料文件（例如 SSH 私钥），调用方负责在 finally 中删除。 */
  temporary(area: SecretArea, name: string, content: string): string {
    const directory = join(this.areas(area), 'tmp')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, `${process.pid}-${randomBytes(6).toString('hex')}-${name}`)
    writeFileSync(file, content, { mode: 0o600 })
    this.restrict(file)
    return file
  }
}
