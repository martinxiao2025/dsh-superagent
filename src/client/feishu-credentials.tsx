/** 飞书凭据设置：与飞书来源记录、Git 凭据相互独立，界面只显示掩码与指纹。 */
import { useEffect, useState } from 'react'
import type { FeishuCredentialInput, FeishuCredentialView } from '../feishu-credentials/kind.ts'
import type { SourceCheck } from '../setup.ts'
import { Button, Input, Tag } from './controls.tsx'
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
  /** 只用于预检，不会随凭据保存。 */
  spaceId: string
}
const EMPTY: Draft = { name: '', mode: 'app', appId: '', appSecret: '', cli: '', note: '', spaceId: '' }

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
    <Field label={t('feishuSpaceId')} hint={t('feishuSpaceIdHint')}>
      <Input disabled={disabled} value={draft.spaceId} onChange={event => edit({ spaceId: event.target.value })} />
    </Field>
    <Field label={t('credentialNote')}>
      <Input disabled={disabled} value={draft.note} onChange={event => edit({ note: event.target.value })} />
    </Field>
  </div>
}

/** 已保存凭据：编辑元数据与密钥、预检、删除。 */
function CredentialCard({ record, changed }: { record: FeishuCredentialView; changed: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const [draft, setDraft] = useState<Draft>(() => draftOf(record))
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    try {
      const result = await call('POST feishu-credentials/verify', { body: { id: record.id,
        ...draft.spaceId.trim() ? { spaceId: draft.spaceId.trim() } : {} } })
      setChecks(current => merge(current, result.checks))
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(false) }
  }
  const save = async () => {
    setBusy(true)
    try {
      const { revision } = await call('PUT feishu-credentials/:id', { id: record.id, body: { value: inputOf(draft),
        revision: record.revision } })
      notify(t('credentialSaved', { name: record.name, revision: String(revision) }))
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
        <Button variant="outline" size="sm" disabled={checking} aria-busy={checking} onClick={() => { void check() }}>
          {checking ? t('verifyBusy') : t('verify')}
        </Button>
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
    <form className="dt-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <CredentialFields draft={draft} edit={next => setDraft(current => ({ ...current, ...next }))} disabled={busy} />
      <div className="dt-row-buttons">
        <Button variant="primary" type="submit" disabled={busy || !draft.name.trim()}>{t('save')}</Button>
      </div>
    </form>
  </div>
}

/** 飞书凭据设置页：新增表单 + 已保存记录。 */
export function FeishuCredentialSettings() {
  const { t, call, notify } = usePanel()
  const [items, setItems] = useState<FeishuCredentialView[] | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const load = async () => setItems((await call('GET feishu-credentials')).credentials)
  useEffect(() => { load().catch(failure => notify(errorText(failure))) }, [])
  const verify = async () => {
    setChecking(true)
    try {
      const result = await call('POST feishu-credentials/verify', { body: { value: inputOf(draft),
        ...draft.spaceId.trim() ? { spaceId: draft.spaceId.trim() } : {} } })
      setChecks(current => merge(current, result.checks))
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(false) }
  }
  const create = async () => {
    setBusy(true)
    try {
      const { id } = await call('POST feishu-credentials', { body: { value: inputOf(draft) } })
      notify(t('credentialAdded', { id }))
      setDraft(EMPTY)
      setChecks({})
      await load()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  return <>
    <div className="dt-source-add" role="group" aria-label={t('feishuCredentialAddTitle')}>
      <div className="dt-row-main">
        <div className="dt-row-title"><span className="dt-card-title">{t('feishuCredentialAddTitle')}</span></div>
        <p className="dt-hint">{t('feishuCredentialAddHint')}</p>
      </div>
      <CredentialFields draft={draft} edit={next => setDraft(current => ({ ...current, ...next }))} disabled={busy} />
      <div className="dt-row-buttons">
        <Button variant="outline" disabled={checking} aria-busy={checking} onClick={() => { void verify() }}>
          {checking ? t('verifyBusy') : t('verifyAll')}
        </Button>
        <Button variant="primary" disabled={busy || !draft.name.trim()} onClick={() => { void create() }}>{t('credentialAdd')}</Button>
      </div>
      <Checks checks={checks} />
    </div>
    <div className="dt-cards">
      {items === null ? <Hint>{t('loading')}</Hint> : items.length === 0 ? <Hint>{t('feishuCredentialNone')}</Hint>
        : items.map(record => <CredentialCard key={`${record.id}:${record.revision}`} record={record} changed={load} />)}
    </div>
  </>
}
