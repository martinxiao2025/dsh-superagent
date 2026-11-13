/** 凭据表单基座：Git 与飞书凭据共享的草稿转换、空字段提交规则、预检展示与验证弹窗。 */
import { useEffect, useState } from 'react'
import type { SourceCheck } from '../setup.ts'
import { Button, Input, Modal } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { errorText, sourceCheckText, type T } from './text.ts'

/** 凭据草稿的公共形状：全部字段都是字符串，便于按声明式规格逐键读写。 */
export type CredentialDraft = Record<string, string>

/**
 * 把草稿转换为提交载荷；可选键只在非空时提交，避免把旧材料覆盖成空字符串。
 * 必填键 trim 后提交：名称可能带手输空白；枚举键来自受约束的下拉，trim 无副作用。
 */
export function credentialInputOf<Draft extends CredentialDraft, Input extends Record<string, string | undefined>>(
  draft: Draft, required: readonly (keyof Draft & keyof Input)[], optional: readonly (keyof Draft & keyof Input)[]): Input {
  const value: Record<string, string | undefined> = {}
  for (const key of required as readonly string[]) value[key] = (draft[key] ?? '').trim()
  for (const key of optional as readonly string[]) {
    const text = draft[key] ?? ''
    if (text.trim() !== '') value[key] = text
  }
  return value as Input
}

/** 用已保存记录回填草稿：从空白草稿开始，按声明的键复制记录中的字符串值。 */
export function credentialDraftOf<Draft extends CredentialDraft, View extends object>(
  empty: Draft, record: View, keys: readonly (keyof Draft & keyof View)[]): Draft {
  const draft: CredentialDraft = { ...empty }
  for (const key of keys as readonly string[]) {
    const value: unknown = record[key as keyof View]
    if (typeof value === 'string') draft[key] = value
  }
  return draft as Draft
}

/** 逐个展示预检结果，文案走 `check.*` 字典；`fields` 给出固定展示顺序。 */
export function CredentialChecks({ fields, checks }: { fields: readonly string[]; checks: Record<string, SourceCheck> }) {
  const { t } = usePanel()
  return <>{fields.map(field => checks[field] && <p key={field}
    className={checks[field]!.ok ? 'dt-hint dt-check' : 'dt-error dt-check'} role={checks[field]!.ok ? 'status' : 'alert'}>
    {sourceCheckText(t, checks[field]!)}
  </p>)}</>
}

/** 凭据验证弹窗的文案与补充查询字段；由各凭据域用当前语言解析后传入。 */
export interface CredentialVerifyWords {
  title: string
  description: string
  queryLabel: string
  queryHint: string
  queryPlaceholder: string
}

/** 验证弹窗：填写一个补充查询（Git 地址或知识库 spaceId），真实调用对应凭据域并展示结果；每次打开都从空结果开始。 */
export function CredentialVerifyModal({ open, error, words, onClose, onVerify, fields, checks, busy }: {
  open: boolean; error: string; words: CredentialVerifyWords; onClose: () => void; onVerify: (query: string) => void
  fields: readonly string[]; checks: Record<string, SourceCheck>; busy: boolean
}) {
  const { t } = usePanel()
  const [query, setQuery] = useState('')
  useEffect(() => { if (open) setQuery('') }, [open])
  const values = Object.values(checks)
  const failed = values.filter(check => !check.ok).length
  return <Modal open={open} onClose={onClose} title={words.title} closeLabel={t('close')}
    description={words.description}
    footer={<>
      <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => onVerify(query.trim())}>
        {busy ? t('verifyBusy') : t('verify')}
      </Button>
    </>}>
    <div className="dt-form">
      <Field label={words.queryLabel} hint={words.queryHint}>
        <Input value={query} placeholder={words.queryPlaceholder} onChange={event => setQuery(event.target.value)} />
      </Field>
      {busy ? <p className="dt-hint" role="status">{t('verifyBusy')}</p>
        : error ? <p className="dt-error" role="alert">{error}</p>
          : values.length > 0 ? <>
            <p className={failed ? 'dt-error dt-verify-summary' : 'dt-hint dt-verify-summary'} role={failed ? 'alert' : 'status'}>
              {failed ? t('verifySummaryFail', { failed: String(failed) }) : t('verifySummaryOk', { count: String(values.length) })}
            </p>
            <CredentialChecks fields={fields} checks={checks} />
          </> : null}
    </div>
  </Modal>
}
