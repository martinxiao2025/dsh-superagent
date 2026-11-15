/** Git 凭据设置：独立于代码仓库记录存储，界面只显示掩码与指纹；卡片与列表用凭据基座的共享组件。 */
import { useRef } from 'react'
import type { GitCredentialInput, GitCredentialView } from '../git-credentials/kind.ts'
import { Button, Input } from './controls.tsx'
import { CredentialCardsSection, credentialDraftOf, credentialInputOf,
  type CredentialDomain, type CredentialVerifyWords } from './credential-form.tsx'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { type T } from './text.ts'

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

/** Git 凭据域：卡片与列表的差异注入——真实 Git 地址作为验证补充查询，材料在场才能创建。 */
const gitDomain: CredentialDomain<GitCredentialView, Draft> = {
  listWords: t => ({ addTitle: t('credentialAddTitle'), addHint: t('gitCredentialAddHint'), none: t('gitCredentialNone') }),
  cardWords: (t, record) => ({ kindTag: record.kind === 'ssh' ? t('credentialKindSsh') : t('credentialKindHttps'),
    summary: record.hint || t('credentialNoMaterial') }),
  verifyWords,
  verifyFields: VERIFY_FIELDS,
  emptyDraft: EMPTY,
  draftOf,
  inputOf,
  fields: (draft, edit, disabled) => <CredentialFields draft={draft} edit={edit} disabled={disabled} />,
  canSave: draft => !!draft.name.trim(),
  canVerify: hasMaterial,
  canCreate: draft => !!draft.name.trim() && hasMaterial(draft),
  list: async call => (await call('GET git-credentials')).credentials,
  verifySaved: async (call, record, repository) =>
    (await call('POST git-credentials/verify', { body: { id: record.id, ...repository ? { repository } : {} } })).checks,
  verifyDraft: async (call, draft, repository) =>
    (await call('POST git-credentials/verify', { body: { value: inputOf(draft), ...repository ? { repository } : {} } })).checks,
  save: (call, record, draft) => call('PUT git-credentials/:id', { id: record.id, body: { value: inputOf(draft), revision: record.revision } }),
  create: (call, draft) => call('POST git-credentials', { body: { value: inputOf(draft) } }),
  remove: (call, record) => call('DELETE git-credentials/:id', { id: record.id }),
}

/** Git 凭据设置页：共享卡片/列表区块，域注入表单与调用。 */
export function GitCredentialSettings() {
  return <CredentialCardsSection domain={gitDomain} />
}
