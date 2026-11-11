/** 凭据校验结果：`code` 供面板本地化，`values` 填充提示中的占位符。 */
export interface CredentialCheck {
  field: string
  ok: boolean
  /** 与来源预检共用面板的 `check.<code>` 文案。 */
  scope: 'check'
  code: string
  values: Record<string, string>
}
/** 生成一条校验结果；默认没有占位符。 */
export function credentialCheck(field: string, ok: boolean, code: string, values: Record<string, string> = {}): CredentialCheck {
  return { field, ok, scope: 'check', code, values }
}
