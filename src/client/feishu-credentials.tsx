/** 飞书凭据设置：与 Git 凭据相互独立，界面只显示掩码与指纹；「消息接入」页承载消息来源配置。 */
import { useEffect, useState } from 'react'
import type { FeishuCredentialInput, FeishuCredentialView } from '../feishu-credentials/kind.ts'
import type { SourceCheck } from '../setup.ts'
import { mergeChecks } from './checks.tsx'
import { Button, Input, SegmentedControl, Tag } from './controls.tsx'
import { CredentialChecks, CredentialVerifyModal, credentialDraftOf, credentialInputOf,
  type CredentialVerifyWords } from './credential-form.tsx'
import { usePanel } from './provider.tsx'
import { Field, useSettings } from './settings-kit.tsx'
import { SourceSettings } from './source.tsx'
import { errorText, type T } from './text.ts'
import { ConfirmButton, Hint } from './widgets.tsx'

/** 表单草稿；用 type 别名（而非 interface）以满足凭据基座的字符串记录约束。 */
type Draft = {
  name: string
  mode: 'app' | 'cli'
  appId: string
  appSecret: string
  cli: string
  note: string
}
const EMPTY: Draft = { name: '', mode: 'app', appId: '', appSecret: '', cli: '', note: '' }

/** 空字段不提交，避免把旧密钥覆盖成空字符串。 */
const inputOf = (draft: Draft): FeishuCredentialInput => credentialInputOf<Draft, FeishuCredentialInput>(draft,
  ['name', 'mode'], ['appId', 'appSecret', 'cli', 'note'])
const draftOf = (record: FeishuCredentialView): Draft =>
  credentialDraftOf(EMPTY, record, ['name', 'mode', 'appId', 'cli', 'note'])
const VERIFY_FIELDS = ['identity', 'space'] as const

/** 验证弹窗文案：补充查询是可选的知识库 spaceId。 */
const verifyWords = (t: T): CredentialVerifyWords => ({ title: t('feishuVerifyTitle'), description: t('feishuVerifyDescription'),
  queryLabel: t('feishuSpaceId'), queryHint: t('feishuSpaceIdHint'), queryPlaceholder: '6946842750923456789' })

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
      setChecks(mergeChecks({}, result.checks))
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
    <CredentialChecks fields={VERIFY_FIELDS} checks={checks} />
    {open && <form className="dt-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <CredentialFields draft={draft} edit={next => setDraft(current => ({ ...current, ...next }))} disabled={busy} />
      <div className="dt-row-buttons">
        <Button variant="primary" type="submit" disabled={busy || !draft.name.trim()}>{t('save')}</Button>
        <Button variant="outline" onClick={() => setOpen(false)}>{t('cancel')}</Button>
      </div>
    </form>}
    <CredentialVerifyModal open={verifyOpen} error={verifyError} words={verifyWords(t)} onClose={() => setVerifyOpen(false)}
      onVerify={spaceId => { void check(spaceId) }} fields={VERIFY_FIELDS} checks={checks} busy={checking} />
  </div>
}

/** 飞书凭据设置页：「凭据」与「消息接入」两页；消息来源（消息工单入口）在后者配置，与凭据身份同处一个域。 */
export function FeishuCredentialSettings({ initialTab, focus }: { initialTab?: string; focus?: string }) {
  const { t } = usePanel()
  const { settings } = useSettings()
  const [tab, setTab] = useState<'credentials' | 'ingress'>(initialTab === 'ingress' ? 'ingress' : 'credentials')
  return <>
    <SegmentedControl label={t('feishuSettingsTabs')} value={tab} onChange={setTab}
      options={[{ value: 'credentials' as const, label: t('feishuSettingsTabCredentials') },
        { value: 'ingress' as const, label: t('feishuSettingsTabIngress') }]} />
    {tab === 'credentials' ? <CredentialList /> : <>
      <p className="dt-hint">{t('feishuIngressIntro')}</p>
      {settings.kinds.length === 0 && settings.sources.length === 0
        ? <Hint>{t('feishuCredentialNone')}</Hint>
        : <SourceSettings {...focus ? { focus } : {}} />}
    </>}
  </>
}

/** 凭据列表：默认显示概要，由「新增」按钮展开新增区块。 */
function CredentialList() {
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
      setChecks(mergeChecks({}, result.checks))
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
      <CredentialChecks fields={VERIFY_FIELDS} checks={checks} />
      <CredentialVerifyModal open={verifyOpen} error={verifyError} words={verifyWords(t)} onClose={() => setVerifyOpen(false)}
        onVerify={spaceId => { void verify(spaceId) }} fields={VERIFY_FIELDS} checks={checks} busy={checking} />
    </div>}
    <div className="dt-cards">
      {items === null ? <Hint>{t('loading')}</Hint> : items.length === 0 ? <Hint>{t('feishuCredentialNone')}</Hint>
        : items.map(record => <CredentialCard key={`${record.id}:${record.revision}`} record={record} changed={load} />)}
    </div>
  </>
}
