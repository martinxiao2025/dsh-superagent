/** 词数统计与统一脱敏的边界：IM 限制依赖 `wordCount`，凭据不得经诊断文本泄漏（`redact` 各模式逐一验证）。 */
import { describe, expect, it } from 'vitest'
import { redact, wordCount } from '../src/infra/text.ts'

describe('wordCount', () => {
  it('counts word-like segments and ignores punctuation and spacing', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('。！？，')).toBe(0)
    expect(wordCount('a  b')).toBe(2)
    expect(wordCount('fix the login bug')).toBe(4)
    // 中文按词计数；不加空格的成词结果由捆绑运行时的 ICU 词库决定，这里钉住当前词库的行为。
    expect(wordCount('修复 login bug')).toBe(3)
    expect(wordCount('配置文件已经修复')).toBe(4)
  })
})
describe('redact', () => {
  it('masks credentials embedded in URLs, twice and case-precisely, and leaves plain URLs alone', () => {
    expect(redact('clone https://user:pass@github.com/acme/widgets.git'))
      .toBe('clone https://***@github.com/acme/widgets.git')
    expect(redact('ssh://git@github.com/acme/widgets.git then https://Ops:Secret@example.com/x'))
      .toBe('ssh://***@github.com/acme/widgets.git then https://***@example.com/x')
    expect(redact('open https://github.com/acme/widgets.git')).toBe('open https://github.com/acme/widgets.git')
    // 无 scheme 前缀的邮件地址不是 URL 凭据。
    expect(redact('write to user@example.com')).toBe('write to user@example.com')
  })
  it('masks authorization headers before the bearer rule sees them, in every spelling', () => {
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: ***')
    expect(redact('x-authORIZATION=Basic Zm9v')).toBe('x-authORIZATION= ***')
    // 分隔符后的空白随值一起被遮蔽，统一替换为单个空格。
    expect(redact('authorization:\tblah')).toBe('authorization: ***')
    // 换行终止遮蔽：下一行不受影响。
    expect(redact('authorization: one\nkeep: two')).toBe('authorization: ***\nkeep: two')
  })
  it('masks the value after a standalone bearer word', () => {
    expect(redact('bearer\tTOKEN-1')).toBe('bearer\t***')
    expect(redact('BEARER 1a2b')).toBe('BEARER ***')
    // 规则按文本激进命中：普通语句里的 "bearer <词>" 也会被遮蔽（脱敏宁可误伤）。
    expect(redact('the bearer of bad news')).toBe('the bearer *** bad news')
  })
  it('masks token-shaped query parameters without touching their neighbors', () => {
    expect(redact('https://hook.example.com/x?access_token=a1b2&ok=1'))
      .toBe('https://hook.example.com/x?access_token=***&ok=1')
    expect(redact('ACCESS-TOKEN=zzz')).toBe('ACCESS-TOKEN=***')
    // 无 `access` 前缀的 `token=` 后缀也命中。
    expect(redact('refresh_token=r8s')).toBe('refresh_token=***')
    expect(redact('tokens=1')).toBe('tokens=1')
  })
  it('masks private key bodies but keeps both markers, across lines and key formats', () => {
    const key = (format: string): string => `-----BEGIN ${format} PRIVATE KEY-----\nabc123\n-----END ${format} PRIVATE KEY-----`
    expect(redact(`before\n${key('RSA')}\nafter`))
      .toBe('before\n-----BEGIN RSA PRIVATE KEY-----***-----END RSA PRIVATE KEY-----\nafter')
    expect(redact(key('OPENSSH'))).toBe('-----BEGIN OPENSSH PRIVATE KEY-----***-----END OPENSSH PRIVATE KEY-----')
  })
  it('masks quoted authorization values in JSON, YAML and shell spellings, keeping the quotes', () => {
    expect(redact('{"Authorization":"Basic dXNlcjpwYXNz"}')).toBe('{"Authorization":"***"}')
    expect(redact('"authorization": "secret-value"')).toBe('"authorization": "***"')
    // 单引号变体同样命中。
    expect(redact("'authorization': 'secret'")).toBe("'authorization': '***'")
    // 裸键带引号值不再残留原文。
    expect(redact('authorization: "secret"')).toBe('authorization: "***"')
    // 引号内的 bearer 值一并遮蔽；curl 参数的收尾引号不再被吞，结构保持完整。
    expect(redact('bearer "abc"')).toBe('bearer "***"')
    expect(redact('curl -H "Authorization: Bearer abc" https://example.com'))
      .toBe('curl -H "Authorization: ***" https://example.com')
  })
  it('leaves ordinary diagnostics untouched', () => {
    const text = 'gh api failed with 404 for acme/widgets (ticket fix-1); retry after 5s'
    expect(redact(text)).toBe(text)
  })
})
