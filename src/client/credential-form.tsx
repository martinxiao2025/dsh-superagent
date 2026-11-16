/** 凭据表单基座：Git 与飞书凭据共享的草稿转换、空字段提交规则、预检展示、验证弹窗，以及卡片/列表的共享组件。 */
import { useEffect, useState, type ReactNode } from 'react'
import type { SourceCheck } from '../setup.ts'
import type { Call } from './api.ts'
import { mergeChecks } from './checks.tsx'
import { Button, Input, Modal, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { errorText, sourceCheckText, type T } from './text.ts'
import { ConfirmButton, Hint } from './widgets.tsx'

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

/** 卡片/列表共享组件认得的已保存凭据最小形状。 */
export interface SavedCredentialView { id: string; name: string; revision: number; fingerprint?: string; configured?: boolean }
/** 列表区块的文案（新增块的标题/提示与空态）。 */
export interface CredentialListWords { addTitle: string; addHint: string; none: string }
/** 一张卡片的文案（标题域标签与摘要行文本；指纹后缀由共享组件拼接）。 */
export interface CredentialCardWords { kindTag: string; summary: string }

/**
 * 一个凭据域注入给卡片/列表共享组件的差异点：草稿与提交转换、域字段表单、文案，
 * 以及绑定各自 HTTP 路由的增删改查与验证调用。共享的是卡片外壳、新增块与状态机，
 * 不是身份——Git 与飞书的存储、探测与错误码保持独立。
 */
export interface CredentialDomain<V extends SavedCredentialView, D extends CredentialDraft> {
  listWords(t: T): CredentialListWords
  cardWords(t: T, record: V): CredentialCardWords
  verifyWords(t: T): CredentialVerifyWords
  /** 预检展示顺序。 */
  verifyFields: readonly string[]
  emptyDraft: D
  draftOf(record: V): D
  inputOf(draft: D): Record<string, unknown>
  /** 域字段表单（不含保存/取消行）。 */
  fields(draft: D, edit: (next: Partial<D>) => void, disabled: boolean): ReactNode
  /** 三个就绪谓词：编辑已保存凭据可保存（名称即可）、草稿可验证、草稿可创建（Git 另要求材料在场）。 */
  canSave(draft: D): boolean
  canVerify(draft: D): boolean
  canCreate(draft: D): boolean
  list(call: Call): Promise<V[]>
  /** 补充查询（Git 仓库地址或知识库 spaceId）非空时附带；返回该次验证的预检条目。 */
  verifySaved(call: Call, record: V, query: string): Promise<readonly SourceCheck[]>
  verifyDraft(call: Call, draft: D, query: string): Promise<readonly SourceCheck[]>
  save(call: Call, record: V, draft: D): Promise<{ revision: number }>
  create(call: Call, draft: D): Promise<{ id: string }>
  remove(call: Call, record: V): Promise<unknown>
}

/** 做一次验证并更新预检状态；每次验证都从空结果开始，调用（含凭据与补充查询）由闭包携带。 */
async function runVerify(notify: (text: string) => void, verify: () => Promise<readonly SourceCheck[]>,
  set: { checks: (value: Record<string, SourceCheck>) => void; error: (text: string) => void; busy: (busy: boolean) => void }) {
  set.busy(true); set.checks({}); set.error('')
  try { set.checks(mergeChecks({}, await verify())) }
  catch (failure) { const text = errorText(failure); set.error(text); notify(text) }
  finally { set.busy(false) }
}

/** 单条已保存凭据的共享卡片：编辑/验证/删除按钮、摘要行、展开表单与验证弹窗；域注入字段与调用。 */
export function SavedCredentialCard<V extends SavedCredentialView, D extends CredentialDraft>(
  { record, changed, domain }: { record: V; changed: () => Promise<void>; domain: CredentialDomain<V, D> }) {
  const { t, call, notify } = usePanel()
  const [draft, setDraft] = useState<D>(() => domain.draftOf(record))
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [open, setOpen] = useState(false)
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [verifyError, setVerifyError] = useState('')
  const save = async () => {
    setBusy(true)
    try {
      const { revision } = await domain.save(call, record, draft)
      notify(t('credentialSaved', { name: record.name, revision: String(revision) }))
      setOpen(false)
      await changed()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  const words = domain.cardWords(t, record)
  return <div className="dt-card">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <span className="dt-card-title">{record.name}</span><Tag>{record.id}</Tag>
        {words.kindTag && <Tag>{words.kindTag}</Tag>}
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
            await domain.remove(call, record)
            notify(t('credentialDeleted', { name: record.name }))
            await changed()
          }} />
      </div>
    </div>
    <p className="dt-hint">{words.summary}{' · '}{t('credentialFingerprint', { fingerprint: record.fingerprint || '—' })}</p>
    <CredentialChecks fields={domain.verifyFields} checks={checks} />
    {open && <form className="dt-form" onSubmit={event => { event.preventDefault(); void save() }}>
      {domain.fields(draft, next => setDraft(current => ({ ...current, ...next })), busy)}
      <div className="dt-row-buttons">
        <Button variant="primary" type="submit" disabled={busy || !domain.canSave(draft)}>{t('save')}</Button>
        <Button variant="outline" onClick={() => setOpen(false)}>{t('cancel')}</Button>
      </div>
    </form>}
    <CredentialVerifyModal open={verifyOpen} error={verifyError} words={domain.verifyWords(t)} onClose={() => setVerifyOpen(false)}
      onVerify={query => { void runVerify(notify, () => domain.verifySaved(call, record, query),
        { checks: setChecks, error: setVerifyError, busy: setChecking }) }}
      fields={domain.verifyFields} checks={checks} busy={checking} />
  </div>
}

/** 凭据设置区块的共享列表：「新增」触发、新增块与已保存卡片；域注入字段、文案与调用。 */
export function CredentialCardsSection<V extends SavedCredentialView, D extends CredentialDraft>({ domain }: { domain: CredentialDomain<V, D> }) {
  const { t, call, notify } = usePanel()
  const [items, setItems] = useState<V[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<D>(domain.emptyDraft)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [verifyError, setVerifyError] = useState('')
  // 列表加载失败给出错误态与重试入口，而不是让「正在读取…」永久停留。
  const [loadError, setLoadError] = useState('')
  const load = async () => {
    setLoadError('')
    try { setItems(await domain.list(call)) } catch (failure) { setLoadError(errorText(failure)) }
  }
  useEffect(() => { void load() }, [])
  /** 收起新增区块并清空草稿与预检结果。 */
  const closeAdd = () => { setAdding(false); setVerifyOpen(false); setDraft(domain.emptyDraft); setChecks({}); setVerifyError('') }
  const create = async () => {
    setBusy(true)
    try {
      const { id } = await domain.create(call, draft)
      notify(t('credentialAdded', { id }))
      closeAdd()
      await load()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  const words = domain.listWords(t)
  return <>
    <div className="dt-row-buttons dt-add-trigger">
      <Button variant="primary" disabled={adding} onClick={() => setAdding(true)}>{t('credentialNew')}</Button>
    </div>
    {adding && <div className="dt-source-add" role="group" aria-label={words.addTitle}>
      <div className="dt-row-main">
        <div className="dt-row-title"><span className="dt-card-title">{words.addTitle}</span></div>
        <p className="dt-hint">{words.addHint}</p>
      </div>
      {domain.fields(draft, next => setDraft(current => ({ ...current, ...next })), busy)}
      <div className="dt-row-buttons">
        <Button variant="outline" disabled={!domain.canVerify(draft)}
          onClick={() => { setChecks({}); setVerifyError(''); setVerifyOpen(true) }}>{t('verify')}</Button>
        <Button variant="primary" disabled={busy || !domain.canCreate(draft)} onClick={() => { void create() }}>{t('credentialNew')}</Button>
        <Button variant="outline" onClick={closeAdd}>{t('cancel')}</Button>
      </div>
      <CredentialChecks fields={domain.verifyFields} checks={checks} />
      <CredentialVerifyModal open={verifyOpen} error={verifyError} words={domain.verifyWords(t)} onClose={() => setVerifyOpen(false)}
        onVerify={query => { void runVerify(notify, () => domain.verifyDraft(call, draft, query),
          { checks: setChecks, error: setVerifyError, busy: setChecking }) }}
        fields={domain.verifyFields} checks={checks} busy={checking} />
    </div>}
    <div className="dt-cards">
      {items === null ? loadError
        ? <p className="dt-error" role="alert">{loadError} <Button variant="outline" size="sm" onClick={() => { void load() }}>{t('retry')}</Button></p>
        : <Hint>{t('loading')}</Hint>
        : items.length === 0 ? <Hint>{words.none}</Hint>
          : items.map(record => <SavedCredentialCard key={`${record.id}:${record.revision}`} record={record} changed={load} domain={domain} />)}
    </div>
  </>
}
