/** 凭据记录 ID 的共享叶子：Git 与飞书两个凭据域都从这里取用，域间互不引用。 */
import { z } from 'zod'

/** 从显示名称生成记录 ID：小写、连字符、字母开头，并限制长度。 */
export function credentialId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (!slug) return 'credential'
  return /^[a-z]/.test(slug) ? slug : `c-${slug}`
}

/** 凭据记录 ID 与其它记录使用同一套命名规则，避免拼出目录穿越的路径。 */
export const CredentialIdSchema = z.string().trim().regex(/^[a-z][a-z0-9-]*$/, '凭据 ID')
