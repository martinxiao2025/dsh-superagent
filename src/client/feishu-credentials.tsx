/** 飞书凭据设置：与飞书来源记录、Git 凭据相互独立，界面只显示掩码与指纹。 */
import { useEffect, useState } from 'react'
import type { FeishuCredentialInput, FeishuCredentialView } from '../feishu-credentials/kind.ts'
import type { SourceCheck } from '../setup.ts'
import { Button, Input, Modal, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { errorText, sourceCheckText } from './text.ts'
import { ConfirmButton, Hint } from './widgets.tsx'

interface Draft {
  name: string
  mode: 'app' | 'cli'
  appId: string
  appSecret: string
  cli: string
  note: string
}
const EMPTY: Draft = { name: '', mode: 'app', appId: '', appSecret: '', cli: '', note: '' }

/** 空字段不提交，避免把旧密钥覆盖成空字符串。 */
function inputOf(draft: Draft): FeishuCredentialInput {
  const value: Record<string, string> = { name: draft.name.trim(), mode: draft.mode }
  for (const key of ['appId', 'appSecret', 'cli', 'note'] as const) {
    if (draft[key].trim() !== '') value[key] = draft[key]
  }
  return value as unknown as FeishuCredentialInput
}
function draftOf(record: FeishuCredentialView): Draft {
  return { ...EMPTY, name: record.name, mode: record.mode, appId: record.appId, cli: record.cli, note: record.note }
}
/** 收集预检结果：同一字段的旧结果被新结果覆盖。 */
function merge(current: Record<string, SourceCheck>, checks: readonly SourceCheck[]): Record<string, SourceCheck> {
  const next = { ...current }
  for (const check of checks) next[check.field] = check
  return next
}
const VERIFY_FIELDS = ['identity', 'space'] as const

/** 逐个展示预检结果，文案走 `check.*` 字典。 */
function Checks({ checks }: { checks: Record<string, SourceCheck> }) {
  const { t } = usePanel()
  return <>{VERIFY_FIELDS.map(field => checks[field] && <p key={field}
    className={checks[field]!.ok ? 'dt-hint dt-check' : 'dt-error dt-check'} role={checks[field]!.ok ? 'status' : 'alert'}>
    {sourceCheckText(t, checks[field]!)}
  </p>)}</>
}

/** 验证弹窗：可选填写知识库 spaceId，真实调用飞书接口并展示结果；每次打开都从空结果开始。 */
function VerifyModal({ open, error, onClose, onVerify, checks, busy }: {
  open: boolean; error: string; onClose: () => void; onVerify: (spaceId: string) => void
  checks: Record<string, SourceCheck>; busy: boolean
}) {
  const { t } = usePanel()
  const [spaceId, setSpaceId] = useState('')
  useEffect(() => { if (open) setSpaceId('') }, [open])
  const values = Object.values(checks)
  const failed = values.filter(check => !check.ok).length
  return <Modal open={open} onClose={onClose} title={t('feishuVerifyTitle')} closeLabel={t('close')}
    description={t('feishuVerifyDescription')}
    footer={<>
      <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => onVerify(spaceId.trim())}>
        {busy ? t('verifyBusy') : t('verify')}
      </Button>
    </>}>
    <div className="dt-form">
      <Field label={t('feishuSpaceId')} hint={t('feishuSpaceIdHint')}>
        <Input value={spaceId} placeholder="6946842750923456789" onChange={event => setSpaceId(event.target.value)} />
      </Field>
      {busy ? <p className="dt-hint" role="status">{t('verifyBusy')}</p>
        : error ? <p className="dt-error" role="alert">{error}</p>
          : values.length > 0 ? <>
            <p className={failed ? 'dt-error dt-verify-summary' : 'dt-hint dt-verify-summary'} role={failed ? 'alert' : 'status'}>
              {failed ? t('verifySummaryFail', { failed: String(failed) }) : t('verifySummaryOk', { count: String(values.length) })}
            </p>
            <Checks checks={checks} />
          </> : null}
    </div>
  </Modal>
}

/** 凭据表单：身份来源决定要填应用密钥还是 CLI。 */
function CredentialFields({ draft, edit, disabled }: { draft: Draft; edit: (next: Partial<Draft>) => void; disabled: boolean }) {
  const { t } = usePanel()
  return <div className="dt-add-grid">
    <Field label={t('credentialName')} hint={t('credentialNameHint')}>
      <Input required disabled={disabled} value={draft.name} placeholder={t('credentialNamePlaceholder')}
        onChange={event => edit({ name: event.target.value })} />
    </Field>
    <Field label={t('feishuMode')}>
      <select className="dt-select" disabled={disabled} value={draft.mode} onChange={event => edit({ mode: event.target.value as Draft['mode'] })}>
        <option value="app">{t('feishuModeApp')}</option>
        <option value="cli">{t('feishuModeCli')}</option>
      </select>
    </Field>
    {draft.mode === 'app' ? <>
      <Field label={t('feishuAppId')} hint={t('feishuAppIdHint')}>
        <Input disabled={disabled} value={draft.appId} placeholder="cli_a1b2c3d4" onChange={event => edit({ appId: event.target.value })} />
      </Field>
      <Field label={t('feishuAppSecret')} hint={t('feishuAppSecretHint')}>
        <Input type="password" disabled={disabled} value={draft.appSecret} placeholder={t('feishuAppSecretPlaceholder')}
          onChange={event => edit({ appSecret: event.target.value })} />
      </Field>
    </> : <Field label={t('feishuCli')} hint={t('feishuCliHint')}>
      <Input disabled={disabled} value={draft.cli} placeholder="lark" onChange={event => edit({ cli: event.target.value })} />
    </Field>}
    <Field label={t('credentialNote')}>
      <textarea className="dt-textarea" rows={2} disabled={disabled} value={draft.note}
        onChange={event => edit({ note: event.target.value })} />
    </Field>
  </div>
}

/** 已保存凭据：默认只显示概要，编辑时才展开表单。 */
function CredentialCard({ record, changed }: { record: FeishuCredentialView; changed: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const [draft, setDraft] = useState<Draft>(() => draftOf(record))
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [open, setOpen] = useState(false)
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [verifyError, setVerifyError] = useState('')
  /** 用已保存凭据验证身份；每次验证都从空结果开始，填写 spaceId 时一并检查知识库权限。 */
  const check = async (spaceId: string) => {
    setChecking(true); setChecks({}); setVerifyError('')
    try {
      const result = await call('POST feishu-credentials/verify', { body: { id: record.id,
        ...spaceId ? { spaceId } : {} } })
      setChecks(merge({}, result.checks))
    } catch (failure) {
      setVerifyError(errorText(failure)); notify(errorText(failure))
    } finally { setChecking(false) }
  }
  const save = async () => {
    setBusy(true)
    try {
      const { revision } = await call('PUT feishu-credentials/:id', { id: record.id, body: { value: inputOf(draft),
        revision: record.revision } })
      notify(t('credentialSaved', { name: record.name, revision: String(revision) }))
      setOpen(false)
      await changed()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  return <div className="dt-card">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <span className="dt-card-title">{record.name}</span><Tag>{record.id}</Tag>
        <Tag>{record.mode === 'app' ? t('feishuModeApp') : t('feishuModeCli')}</Tag>
        {!record.configured && <Tag>{t('credentialUnconfigured')}</Tag>}
      </div>
      <div className="dt-row-buttons">
        <Button variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? t('close') : t('edit')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => { setChecks({}); setVerifyError(''); setVerifyOpen(true) }}>{t('verify')}</Button>
        <ConfirmButton label={t('credentialDelete')} title={t('credentialDeleteTitle')}
          message={t('credentialDeleteConfirm', { name: record.name })} icon="trash" variant="outline"
          onConfirm={async () => {
            await call('DELETE feishu-credentials/:id', { id: record.id })
            notify(t('credentialDeleted', { name: record.name }))
            await changed()
          }} />
      </div>
    </div>
    <p className="dt-hint">{record.mode === 'app' ? record.hint || t('credentialNoMaterial') : record.cli}
      {' · '}{t('credentialFingerprint', { fingerprint: record.fingerprint || '—' })}</p>
    <Checks checks={checks} />
    {open && <form className="dt-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <CredentialFields draft={draft} edit={next => setDraft(current => ({ ...current, ...next }))} disabled={busy} />
      <div className="dt-row-buttons">
        <Button variant="primary" type="submit" disabled={busy || !draft.name.trim()}>{t('save')}</Button>
        <Button variant="outline" onClick={() => setOpen(false)}>{t('cancel')}</Button>
      </div>
    </form>}
    <VerifyModal open={verifyOpen} error={verifyError} onClose={() => setVerifyOpen(false)}
      onVerify={spaceId => { void check(spaceId) }} checks={checks} busy={checking} />
  </div>
}

/** 飞书凭据设置页：默认显示列表，由「新增」按钮展开新增区块。 */
export function FeishuCredentialSettings() {
  const { t, call, notify } = usePanel()
  const [items, setItems] = useState<FeishuCredentialView[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [verifyError, setVerifyError] = useState('')
  const load = async () => setItems((await call('GET feishu-credentials')).credentials)
  useEffect(() => { load().catch(failure => notify(errorText(failure))) }, [])
  /** 收起新增区块并清空草稿与预检结果。 */
  const closeAdd = () => { setAdding(false); setVerifyOpen(false); setDraft(EMPTY); setChecks({}); setVerifyError('') }
  /** 用草稿凭据验证身份；每次验证都从空结果开始，填写 spaceId 时一并检查知识库权限。 */
  const verify = async (spaceId: string) => {
    setChecking(true); setChecks({}); setVerifyError('')
    try {
      const result = await call('POST feishu-credentials/verify', { body: { value: inputOf(draft),
        ...spaceId ? { spaceId } : {} } })
      setChecks(merge({}, result.checks))
    } catch (failure) {
      setVerifyError(errorText(failure)); notify(errorText(failure))
    } finally { setChecking(false) }
  }
  const create = async () => {
    setBusy(true)
    try {
      const { id } = await call('POST feishu-credentials', { body: { value: inputOf(draft) } })
      notify(t('credentialAdded', { id }))
      setDraft(EMPTY)
      setChecks({})
      setAdding(false)
      await load()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  return <>
    <div className="dt-row-buttons dt-add-trigger">
      <Button variant="primary" disabled={adding} onClick={() => setAdding(true)}>{t('credentialNew')}</Button>
    </div>
    {adding && <div className="dt-source-add" role="group" aria-label={t('feishuCredentialAddTitle')}>
      <div className="dt-row-main">
        <div className="dt-row-title"><span className="dt-card-title">{t('feishuCredentialAddTitle')}</span></div>
        <p className="dt-hint">{t('feishuCredentialAddHint')}</p>
      </div>
      <CredentialFields draft={draft} edit={next => setDraft(current => ({ ...current, ...next }))} disabled={busy} />
      <div className="dt-row-buttons">
        <Button variant="outline" disabled={!draft.name.trim()}
          onClick={() => { setChecks({}); setVerifyError(''); setVerifyOpen(true) }}>{t('verify')}</Button>
        <Button variant="primary" disabled={busy || !draft.name.trim()} onClick={() => { void create() }}>{t('credentialNew')}</Button>
        <Button variant="outline" onClick={closeAdd}>{t('cancel')}</Button>
      </div>
      <Checks checks={checks} />
      <VerifyModal open={verifyOpen} error={verifyError} onClose={() => setVerifyOpen(false)}
        onVerify={spaceId => { void verify(spaceId) }} checks={checks} busy={checking} />
    </div>}
    <div className="dt-cards">
      {items === null ? <Hint>{t('loading')}</Hint> : items.length === 0 ? <Hint>{t('feishuCredentialNone')}</Hint>
        : items.map(record => <CredentialCard key={`${record.id}:${record.revision}`} record={record} changed={load} />)}
    </div>
  </>
}
