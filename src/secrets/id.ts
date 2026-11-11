/** 从显示名称生成记录 ID：小写、连字符、字母开头，并限制长度。 */
export function credentialId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (!slug) return 'credential'
  return /^[a-z]/.test(slug) ? slug : `c-${slug}`
}
