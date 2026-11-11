/** Git 凭据设置：独立于代码仓库记录存储，界面只显示掩码与指纹。 */
import { useEffect, useState } from 'react'
import type { GitCredentialInput, GitCredentialView } from '../git-credentials/kind.ts'
import type { SourceCheck } from '../setup.ts'
import { Button, Input, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { errorText, sourceCheckText } from './text.ts'
import { ConfirmButton, Hint } from './widgets.tsx'

interface Draft {
  name: string
  kind: 'ssh' | 'https'
  provider: 'github' | 'gitlab' | 'generic'
  username: string
  privateKey: string
  keyPath: string
  passphrase: string
  token: string
  note: string
}
const EMPTY: Draft = { name: '', kind: 'ssh', provider: 'github', username: '', privateKey: '', keyPath: '', passphrase: '', token: '', note: '' }

/** 空字段不提交，避免把旧材料覆盖成空字符串。 */
function inputOf(draft: Draft): GitCredentialInput {
  const value: Record<string, string> = { name: draft.name.trim(), kind: draft.kind, provider: draft.provider }
  for (const key of ['username', 'privateKey', 'keyPath', 'passphrase', 'token', 'note'] as const) {
    if (draft[key].trim() !== '') value[key] = draft[key]
  }
  return value as unknown as GitCredentialInput
}
function draftOf(record: GitCredentialView): Draft {
  return { ...EMPTY, name: record.name, kind: record.kind, provider: record.provider, username: record.username, note: record.note }
}
/** 收集预检结果：同一字段的旧结果被新结果覆盖。 */
function merge(current: Record<string, SourceCheck>, checks: readonly SourceCheck[]): Record<string, SourceCheck> {
  const next = { ...current }
  for (const check of checks) next[check.field] = check
  return next
}
const VERIFY_FIELDS = ['material', 'key', 'repository'] as const

/** 逐个展示预检结果，文案走 `check.*` 字典。 */
function Checks({ checks }: { checks: Record<string, SourceCheck> }) {
  const { t } = usePanel()
  return <>{VERIFY_FIELDS.map(field => checks[field] && <p key={field}
    className={checks[field]!.ok ? 'dt-hint dt-check' : 'dt-error dt-check'} role={checks[field]!.ok ? 'status' : 'alert'}>
    {sourceCheckText(t, checks[field]!)}
  </p>)}</>
}

/** 凭据表单：认证方式决定要填私钥还是访问令牌。 */
function CredentialFields({ draft, edit, disabled }: { draft: Draft; edit: (next: Partial<Draft>) => void; disabled: boolean }) {
  const { t } = usePanel()
  return <div className="dt-add-grid">
    <Field label={t('credentialName')} hint={t('credentialNameHint')}>
      <Input required disabled={disabled} value={draft.name} placeholder={t('credentialNamePlaceholder')}
        onChange={event => edit({ name: event.target.value })} />
    </Field>
    <Field label={t('credentialKind')}>
      <select className="dt-select" disabled={disabled} value={draft.kind} onChange={event => edit({ kind: event.target.value as Draft['kind'] })}>
        <option value="ssh">{t('credentialKindSsh')}</option>
        <option value="https">{t('credentialKindHttps')}</option>
      </select>
    </Field>
    <Field label={t('credentialProvider')}>
      <select className="dt-select" disabled={disabled} value={draft.provider}
        onChange={event => edit({ provider: event.target.value as Draft['provider'] })}>
        <option value="github">GitHub</option>
        <option value="gitlab">GitLab</option>
        <option value="generic">{t('credentialProviderGeneric')}</option>
      </select>
    </Field>
    {draft.kind === 'ssh' ? <>
      <Field label={t('credentialPrivateKey')} hint={t('credentialPrivateKeyHint')}>
        <textarea className="dt-textarea dt-mono" rows={4} disabled={disabled} value={draft.privateKey}
          placeholder={t('credentialPrivateKeyPlaceholder')} onChange={event => edit({ privateKey: event.target.value })} />
      </Field>
      <Field label={t('credentialKeyPath')} hint={t('credentialKeyPathHint')}>
        <Input disabled={disabled} value={draft.keyPath} placeholder="~/.ssh/id_ed25519"
          onChange={event => edit({ keyPath: event.target.value })} />
      </Field>
      <Field label={t('credentialPassphrase')} hint={t('credentialPassphraseHint')}>
        <Input type="password" disabled={disabled} value={draft.passphrase}
          onChange={event => edit({ passphrase: event.target.value })} />
      </Field>
    </> : <>
      <Field label={t('credentialToken')} hint={t('credentialTokenHint')}>
        <Input type="password" disabled={disabled} value={draft.token} onChange={event => edit({ token: event.target.value })} />
      </Field>
      <Field label={t('credentialUsername')} hint={t('credentialUsernameHint')}>
        <Input disabled={disabled} value={draft.username} placeholder="x-access-token"
          onChange={event => edit({ username: event.target.value })} />
      </Field>
    </>}
    <Field label={t('credentialNote')}>
      <Input disabled={disabled} value={draft.note} onChange={event => edit({ note: event.target.value })} />
    </Field>
  </div>
}

/** 已保存凭据：编辑元数据与材料、预检、删除。 */
function CredentialCard({ record, changed }: { record: GitCredentialView; changed: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const [draft, setDraft] = useState<Draft>(() => draftOf(record))
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    try {
      const result = await call('POST git-credentials/verify', { body: { id: record.id } })
      setChecks(current => merge(current, result.checks))
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(false) }
  }
  const save = async () => {
    setBusy(true)
    try {
      const { revision } = await call('PUT git-credentials/:id', { id: record.id, body: { value: inputOf(draft),
        revision: record.revision } })
      notify(t('credentialSaved', { name: record.name, revision: String(revision) }))
      await changed()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  return <div className="dt-card">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <span className="dt-card-title">{record.name}</span><Tag>{record.id}</Tag>
        <Tag>{record.kind === 'ssh' ? t('credentialKindSsh') : t('credentialKindHttps')}</Tag>
        {!record.configured && <Tag>{t('credentialUnconfigured')}</Tag>}
      </div>
      <div className="dt-row-buttons">
        <Button variant="outline" size="sm" disabled={checking} aria-busy={checking} onClick={() => { void check() }}>
          {checking ? t('verifyBusy') : t('verify')}
        </Button>
        <ConfirmButton label={t('credentialDelete')} title={t('credentialDeleteTitle')}
          message={t('credentialDeleteConfirm', { name: record.name })} icon="trash" variant="outline"
          onConfirm={async () => {
            await call('DELETE git-credentials/:id', { id: record.id })
            notify(t('credentialDeleted', { name: record.name }))
            await changed()
          }} />
      </div>
    </div>
    <p className="dt-hint">{record.hint || t('credentialNoMaterial')}{' · '}{t('credentialFingerprint', { fingerprint: record.fingerprint || '—' })}</p>
    <Checks checks={checks} />
    <form className="dt-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <CredentialFields draft={draft} edit={next => setDraft(current => ({ ...current, ...next }))} disabled={busy} />
      <div className="dt-row-buttons">
        <Button variant="primary" type="submit" disabled={busy || !draft.name.trim()}>{t('save')}</Button>
      </div>
    </form>
  </div>
}

/** Git 凭据设置页：新增表单 + 已保存记录。 */
export function GitCredentialSettings() {
  const { t, call, notify } = usePanel()
  const [items, setItems] = useState<GitCredentialView[] | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const load = async () => setItems((await call('GET git-credentials')).credentials)
  useEffect(() => { load().catch(failure => notify(errorText(failure))) }, [])
  const verify = async () => {
    setChecking(true)
    try {
      const result = await call('POST git-credentials/verify', { body: { value: inputOf(draft) } })
      setChecks(current => merge(current, result.checks))
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(false) }
  }
  const create = async () => {
    setBusy(true)
    try {
      const { id } = await call('POST git-credentials', { body: { value: inputOf(draft) } })
      notify(t('credentialAdded', { id }))
      setDraft(EMPTY)
      setChecks({})
      await load()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  return <>
    <div className="dt-source-add" role="group" aria-label={t('credentialAddTitle')}>
      <div className="dt-row-main">
        <div className="dt-row-title"><span className="dt-card-title">{t('credentialAddTitle')}</span></div>
        <p className="dt-hint">{t('gitCredentialAddHint')}</p>
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
      {items === null ? <Hint>{t('loading')}</Hint> : items.length === 0 ? <Hint>{t('gitCredentialNone')}</Hint>
        : items.map(record => <CredentialCard key={`${record.id}:${record.revision}`} record={record} changed={load} />)}
    </div>
  </>
}
