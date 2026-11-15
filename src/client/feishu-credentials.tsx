/** 飞书凭据设置：与 Git 凭据相互独立，界面只显示掩码与指纹；卡片与列表用凭据基座的共享组件，「消息接入」页承载消息来源配置。 */
import { useState } from 'react'
import type { FeishuCredentialInput, FeishuCredentialView } from '../feishu-credentials/kind.ts'
import { Input, SegmentedControl } from './controls.tsx'
import { CredentialCardsSection, credentialDraftOf, credentialInputOf,
  type CredentialDomain, type CredentialVerifyWords } from './credential-form.tsx'
import { usePanel } from './provider.tsx'
import { Field, useSettings } from './settings-kit.tsx'
import { SourceSettings } from './source.tsx'
import { Hint } from './widgets.tsx'
import { type T } from './text.ts'

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

/** 飞书凭据域：卡片与列表的差异注入——补充查询是可选的知识库 spaceId，名称在场即可验证/创建。 */
const feishuDomain: CredentialDomain<FeishuCredentialView, Draft> = {
  listWords: t => ({ addTitle: t('feishuCredentialAddTitle'), addHint: t('feishuCredentialAddHint'), none: t('feishuCredentialNone') }),
  cardWords: (t, record) => ({ kindTag: record.mode === 'app' ? t('feishuModeApp') : t('feishuModeCli'),
    summary: record.mode === 'app' ? record.hint || t('credentialNoMaterial') : record.cli }),
  verifyWords,
  verifyFields: VERIFY_FIELDS,
  emptyDraft: EMPTY,
  draftOf,
  inputOf,
  fields: (draft, edit, disabled) => <CredentialFields draft={draft} edit={edit} disabled={disabled} />,
  canSave: draft => !!draft.name.trim(),
  canVerify: draft => !!draft.name.trim(),
  canCreate: draft => !!draft.name.trim(),
  list: async call => (await call('GET feishu-credentials')).credentials,
  verifySaved: async (call, record, spaceId) =>
    (await call('POST feishu-credentials/verify', { body: { id: record.id, ...spaceId ? { spaceId } : {} } })).checks,
  verifyDraft: async (call, draft, spaceId) =>
    (await call('POST feishu-credentials/verify', { body: { value: inputOf(draft), ...spaceId ? { spaceId } : {} } })).checks,
  save: (call, record, draft) => call('PUT feishu-credentials/:id', { id: record.id, body: { value: inputOf(draft), revision: record.revision } }),
  create: (call, draft) => call('POST feishu-credentials', { body: { value: inputOf(draft) } }),
  remove: (call, record) => call('DELETE feishu-credentials/:id', { id: record.id }),
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

/** 凭据列表：共享卡片/列表区块，域注入表单与调用。 */
function CredentialList() {
  return <CredentialCardsSection domain={feishuDomain} />
}
