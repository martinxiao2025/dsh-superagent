/** 词数统计与字符串格式化工具，用于 IM 消息限制和模板。 */
const words = new Intl.Segmenter('zh', { granularity: 'word' })
export const IM_WORDS = 100
export const NOTE_WORDS = 30
/** 统计中文、英文和混合文本中的类词片段数量，忽略标点。 */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of words.segment(text)) if (segment.isWordLike) count++
  return count
}
/** 校验发往 IM 的 Markdown 消息不超过 `IM_WORDS`（链接文本和 URL 都计入限制）。 */
export function checkedImText(text: string): string {
  const count = wordCount(text)
  if (count > IM_WORDS) throw new Error(`IM message has ${count} words; maximum is ${IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`)
  return text
}
export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
/** 用于 GitHub 登录名和仓库名的大小写不敏感比较。 */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * 统一脱敏：URL 内嵌凭据、Authorization/Bearer 头（含带引号键与带引号值）、令牌型查询参数与私钥块。
 * CLI 输出与错误消息在进入日志、工单或面板之前统一调用，避免凭据经诊断文本泄漏。
 */
export function redact(text: string): string {
  return text
    .replace(/([a-zA-Z][\w+.-]*:\/\/)([^/@\s]+)@/g, '$1***@')
    // 裸键裸值先行：分隔符后（跳过空格/制表符）紧跟引号时不命中，带引号的形式完整留给下一条规则。
    .replace(/(authorization\s*[:=])(?![ \t]*["'])[^\n"'][^\n"']*/gi, '$1 ***')
    // 带引号的键与值（JSON、单引号 shell 参数）：值遮蔽在引号内进行，保留两侧引号。
    .replace(/(authorization["']?\s*[:=]\s*)(["'])[^"'\n]*\2/gi, '$1$2***$2')
    .replace(/(bearer\s+)(["'])[^"'\n]*\2/gi, '$1$2***$2')
    // 裸值不含引号：curl 参数等收尾引号留在原文中，不再被吞。
    .replace(/(bearer\s+)[^\s"'][^\s"']*/gi, '$1***')
    .replace(/((?:access[-_])?token=)[^&\s]+/gi, '$1***')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1***$2')
}
