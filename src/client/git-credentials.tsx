/** Git 凭据设置：独立于代码仓库记录存储，界面只显示掩码与指纹。 */
import { useEffect, useRef, useState } from 'react'
import type { GitCredentialInput, GitCredentialView } from '../git-credentials/kind.ts'
import type { SourceCheck } from '../setup.ts'
import { mergeChecks } from './checks.tsx'
import { Button, Input, Tag } from './controls.tsx'
import { CredentialChecks, CredentialVerifyModal, credentialDraftOf, credentialInputOf,
  type CredentialVerifyWords } from './credential-form.tsx'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { errorText, type T } from './text.ts'
import { ConfirmButton, Hint } from './widgets.tsx'

/** 表单草稿；用 type 别名（而非 interface）以满足凭据基座的字符串记录约束。 */
type Draft = {
  name: string
  kind: 'ssh' | 'https'
  provider: 'github' | 'gitlab' | 'generic'
  username: string
  privateKey: string
  passphrase: string
  token: string
  note: string
}
const EMPTY: Draft = { name: '', kind: 'ssh', provider: 'github', username: '', privateKey: '', passphrase: '', token: '', note: '' }
/** 上传文件的大小上限，避免误选大文件。 */
const MAX_UPLOAD = 64 * 1024

/** 读取文本文件；优先用 Blob.text，环境不支持时回退 FileReader。 */
async function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsText(file)
  })
}

/** 按文件内容初始化草稿：私钥走 SSH，令牌走 HTTPS，并按文件名补默认名称。 */
function draftOfFile(fileName: string, text: string): Partial<Draft> {
  const name = fileName.replace(/\.[^.]+$/, '') || fileName
  if (/PRIVATE KEY|PuTTY-User-Key-File/.test(text)) return { name, kind: 'ssh', privateKey: text }
  const provider = /(^|\n)\s*glpat-/.test(text) ? 'gitlab' : /(^|\n)\s*(ghp_|github_pat_)/.test(text) ? 'github' : undefined
  return { name, kind: 'https', token: text.trim(), ...provider ? { provider } : {} }
}

/** 文件选择按钮：把选中的文本文件交给调用方初始化表单。 */
function UploadFile({ label, disabled, onFile }: { label: string; disabled: boolean; onFile: (file: File) => void }) {
  const { t } = usePanel()
  const input = useRef<HTMLInputElement>(null)
  return <span className="dt-upload">
    <input ref={input} type="file" hidden accept=".pem,.key,.ppk,.txt,text/plain" aria-label={label}
      onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file) onFile(file)
      }} />
    <Button variant="outline" size="sm" disabled={disabled} onClick={() => input.current?.click()}>{label}</Button>
    <span className="dt-hint">{t('credentialUploadHint')}</span>
  </span>
}

/** 空字段不提交，避免把旧材料覆盖成空字符串。 */
const inputOf = (draft: Draft): GitCredentialInput => credentialInputOf<Draft, GitCredentialInput>(draft,
  ['name', 'kind', 'provider'], ['username', 'privateKey', 'passphrase', 'token', 'note'])
const draftOf = (record: GitCredentialView): Draft =>
  credentialDraftOf(EMPTY, record, ['name', 'kind', 'provider', 'username', 'note'])
const VERIFY_FIELDS = ['material', 'key', 'repository'] as const

/** 验证弹窗文案：补充查询是真实 Git 地址。 */
const verifyWords = (t: T): CredentialVerifyWords => ({ title: t('credentialVerifyTitle'),
  description: t('credentialVerifyDescription'), queryLabel: t('credentialRepository'),
  queryHint: t('credentialRepositoryHint'), queryPlaceholder: 'git@github.com:owner/repo.git' })

/** 是否已提供可校验的材料：SSH 看私钥内容，HTTPS 看令牌。 */
function hasMaterial(draft: Draft): boolean {
  return draft.kind === 'ssh' ? draft.privateKey.trim() !== '' : draft.token.trim() !== ''
}

/** 凭据表单：认证方式决定要填私钥还是访问令牌。 */
function CredentialFields({ draft, edit, disabled }: { draft: Draft; edit: (next: Partial<Draft>) => void; disabled: boolean }) {
  const { t, notify } = usePanel()
  /** 读取上传文件并初始化名称、认证方式与材料；已填名称保持不变。 */
  const upload = async (file: File) => {
    if (file.size > MAX_UPLOAD) { notify(t('credentialUploadTooBig')); return }
    try {
      const next = draftOfFile(file.name, await readText(file))
      edit({ ...next, name: draft.name.trim() || next.name || file.name })
    } catch { notify(t('credentialUploadFailed')) }
  }
  return <div className="dt-add-grid">
    <Field label={t('credentialName')} hint={t('credentialNameHint')}>
      <Input required disabled={disabled} value={draft.name} placeholder={t('credentialNamePlaceholder')}
        onChange={event => edit({ name: event.target.value })} />
    </Field>
    <Field label={t('credentialProvider')}>
      <select className="dt-select" disabled={disabled} value={draft.provider}
        onChange={event => edit({ provider: event.target.value as Draft['provider'] })}>
        <option value="github">GitHub</option>
        <option value="gitlab">GitLab</option>
        <option value="generic">{t('credentialProviderGeneric')}</option>
      </select>
    </Field>
    <Field label={t('credentialKind')}>
      <select className="dt-select" disabled={disabled} value={draft.kind} onChange={event => edit({ kind: event.target.value as Draft['kind'] })}>
        <option value="ssh">{t('credentialKindSsh')}</option>
        <option value="https">{t('credentialKindHttps')}</option>
      </select>
    </Field>
    {draft.kind === 'ssh' ? <>
      <Field label={t('credentialPrivateKey')} hint={t('credentialPrivateKeyHint')}
        note={<UploadFile label={t('credentialUploadKey')} disabled={disabled} onFile={file => { void upload(file) }} />}>
        <textarea className="dt-textarea dt-mono" rows={4} disabled={disabled} value={draft.privateKey}
          placeholder={t('credentialPrivateKeyPlaceholder')} onChange={event => edit({ privateKey: event.target.value })} />
      </Field>
      <Field label={t('credentialPassphrase')} hint={t('credentialPassphraseHint')}>
        <Input type="password" disabled={disabled} value={draft.passphrase}
          onChange={event => edit({ passphrase: event.target.value })} />
      </Field>
    </> : <>
      <Field label={t('credentialToken')} hint={t('credentialTokenHint')}
        note={<UploadFile label={t('credentialUploadToken')} disabled={disabled} onFile={file => { void upload(file) }} />}>
        <Input type="password" disabled={disabled} value={draft.token} onChange={event => edit({ token: event.target.value })} />
      </Field>
      <Field label={t('credentialUsername')} hint={t('credentialUsernameHint')}>
        <Input disabled={disabled} value={draft.username} placeholder="x-access-token"
          onChange={event => edit({ username: event.target.value })} />
      </Field>
    </>}
    <Field label={t('credentialNote')}>
      <textarea className="dt-textarea" rows={2} disabled={disabled} value={draft.note}
        onChange={event => edit({ note: event.target.value })} />
    </Field>
  </div>
}

/** 已保存凭据：默认只显示概要，编辑时才展开表单。 */
function CredentialCard({ record, changed }: { record: GitCredentialView; changed: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const [draft, setDraft] = useState<Draft>(() => draftOf(record))
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [open, setOpen] = useState(false)
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [verifyError, setVerifyError] = useState('')
  /** 用已保存凭据验证给定 Git 地址；每次验证都从空结果开始，地址为空时只做本地检查。 */
  const check = async (repository: string) => {
    setChecking(true); setChecks({}); setVerifyError('')
    try {
      const result = await call('POST git-credentials/verify', { body: { id: record.id, ...repository ? { repository } : {} } })
      setChecks(mergeChecks({}, result.checks))
    } catch (failure) {
      setVerifyError(errorText(failure)); notify(errorText(failure))
    } finally { setChecking(false) }
  }
  const save = async () => {
    setBusy(true)
    try {
      const { revision } = await call('PUT git-credentials/:id', { id: record.id, body: { value: inputOf(draft),
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
        <Tag>{record.kind === 'ssh' ? t('credentialKindSsh') : t('credentialKindHttps')}</Tag>
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
            await call('DELETE git-credentials/:id', { id: record.id })
            notify(t('credentialDeleted', { name: record.name }))
            await changed()
          }} />
      </div>
    </div>
    <p className="dt-hint">{record.hint || t('credentialNoMaterial')}{' · '}{t('credentialFingerprint', { fingerprint: record.fingerprint || '—' })}</p>
    <CredentialChecks fields={VERIFY_FIELDS} checks={checks} />
    {open && <form className="dt-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <CredentialFields draft={draft} edit={next => setDraft(current => ({ ...current, ...next }))} disabled={busy} />
      <div className="dt-row-buttons">
        <Button variant="primary" type="submit" disabled={busy || !draft.name.trim()}>{t('save')}</Button>
        <Button variant="outline" onClick={() => setOpen(false)}>{t('cancel')}</Button>
      </div>
    </form>}
    <CredentialVerifyModal open={verifyOpen} error={verifyError} words={verifyWords(t)} onClose={() => setVerifyOpen(false)}
      onVerify={repository => { void check(repository) }} fields={VERIFY_FIELDS} checks={checks} busy={checking} />
  </div>
}

/** Git 凭据设置页：新增表单 + 已保存记录。 */
export function GitCredentialSettings() {
  const { t, call, notify } = usePanel()
  const [items, setItems] = useState<GitCredentialView[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [verifyError, setVerifyError] = useState('')
  const load = async () => setItems((await call('GET git-credentials')).credentials)
  useEffect(() => { load().catch(failure => notify(errorText(failure))) }, [])
  /** 收起新增区块并清空草稿与预检结果。 */
  const closeAdd = () => { setAdding(false); setVerifyOpen(false); setDraft(EMPTY); setChecks({}); setVerifyError('') }
  /** 用草稿材料验证给定 Git 地址；每次验证都从空结果开始，地址为空时只做本地检查。 */
  const verify = async (repository: string) => {
    setChecking(true); setChecks({}); setVerifyError('')
    try {
      const result = await call('POST git-credentials/verify', { body: { value: inputOf(draft), ...repository ? { repository } : {} } })
      setChecks(mergeChecks({}, result.checks))
    } catch (failure) {
      setVerifyError(errorText(failure)); notify(errorText(failure))
    } finally { setChecking(false) }
  }
  const create = async () => {
    setBusy(true)
    try {
      const { id } = await call('POST git-credentials', { body: { value: inputOf(draft) } })
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
    {adding && <div className="dt-source-add" role="group" aria-label={t('credentialAddTitle')}>
      <div className="dt-row-main">
        <div className="dt-row-title"><span className="dt-card-title">{t('credentialAddTitle')}</span></div>
        <p className="dt-hint">{t('gitCredentialAddHint')}</p>
      </div>
      <CredentialFields draft={draft} edit={next => setDraft(current => ({ ...current, ...next }))} disabled={busy} />
      <div className="dt-row-buttons">
        <Button variant="outline" disabled={!hasMaterial(draft)}
          onClick={() => { setChecks({}); setVerifyError(''); setVerifyOpen(true) }}>{t('verify')}</Button>
        <Button variant="primary" disabled={busy || !draft.name.trim() || !hasMaterial(draft)} onClick={() => { void create() }}>{t('credentialNew')}</Button>
        <Button variant="outline" onClick={closeAdd}>{t('cancel')}</Button>
      </div>
      <CredentialChecks fields={VERIFY_FIELDS} checks={checks} />
      <CredentialVerifyModal open={verifyOpen} error={verifyError} words={verifyWords(t)} onClose={() => setVerifyOpen(false)}
        onVerify={repository => { void verify(repository) }} fields={VERIFY_FIELDS} checks={checks} busy={checking} />
    </div>}
    <div className="dt-cards">
      {items === null ? <Hint>{t('loading')}</Hint> : items.length === 0 ? <Hint>{t('gitCredentialNone')}</Hint>
        : items.map(record => <CredentialCard key={`${record.id}:${record.revision}`} record={record} changed={load} />)}
    </div>
  </>
}
