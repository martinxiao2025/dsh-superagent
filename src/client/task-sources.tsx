/** 任务来源设置：类型目录来自驱动注册表，新增前逐字段验证，验证过程不写设置。 */
import { useState, type ReactElement } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import type { SourceCheck } from '../setup.ts'
import { Button, Input, Tag } from './controls.tsx'
import { ConfirmButton } from './widgets.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field, SourceField, useSettings } from './settings-kit.tsx'
import { errorText, localized, sourceCheckText } from './text.ts'

/** 一行字段加一个独立的验证按钮，结果就地显示在字段下方。 */
function VerifyRow({ label, busy, check, onVerify, children }: { label: string; busy: boolean; check?: SourceCheck
  onVerify: () => void; children: ReactElement<{ id?: string }> }) {
  const { t } = usePanel()
  return <div className="dt-verify-item">
    <div className="dt-verify-row">{children}
      <Button variant="outline" size="sm" disabled={busy} aria-busy={busy} aria-label={`${t('verify')} · ${label}`}
        onClick={onVerify}>{busy ? t('verifyBusy') : t('verify')}</Button>
    </div>
    {check && <p className={check.ok ? 'dt-hint dt-check' : 'dt-error dt-check'} role={check.ok ? 'status' : 'alert'}>
      {sourceCheckText(t, check)}
    </p>}
  </div>
}

/** 新增任务来源：项目名称 + 驱动类型 + 驱动字段；全部验证只针对注册表声明的非高级字段。 */
function AddTaskSource() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const kinds = settings.taskSourceKinds
  const [kind, setKind] = useState('')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const create = useAction(async () => {
    const body: { kind: string; id?: string; name: string; config?: unknown } = { kind: selected, name: name.trim() }
    if (id.trim()) body.id = id.trim()
    if (Object.keys(config).length > 0) body.config = config
    const { id: created } = await call('POST task-sources', { body })
    notify(t('taskSourceAdded', { id: created }))
    setName(''); setId(''); setConfig({}); setChecks({})
  }, { reload })
  if (kinds.length === 0) return null
  // 类型目录到达后默认选中第一项；`kind` 只记录用户的显式选择。
  const selected = kind || kinds[0]?.kind || ''
  const spec = kinds.find(item => item.kind === selected)
  const records = settings.sources.map(source => ({ id: source.id, kind: source.kind, title: source.title }))
  const edit = (field: FieldSpec, next: unknown) => setConfig(current => ({ ...current, [field.key]: next }))
  const runVerify = async (field: string) => {
    setChecking(current => ({ ...current, [field]: true }))
    try {
      const body = { kind: selected, name: name.trim(), ...id.trim() ? { id: id.trim() } : {}, config, field }
      const result = await call('POST task-sources/verify', { body })
      setChecks(current => {
        const next = { ...current }
        for (const check of result.checks) next[check.field] = check
        return next
      })
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(current => ({ ...current, [field]: false })) }
  }
  return <div className="dt-source-add" role="group" aria-label={t('taskSourceAddTitle')}>
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-card-title">{t('taskSourceAddTitle')}</span></div>
      <p className="dt-hint">{t('taskSourceAddHint')}</p>
    </div>
    <div className="dt-add-grid">
      <VerifyRow label={t('sourceName')} busy={checking.name === true} check={checks.name}
        onVerify={() => { void runVerify('name') }}>
        <Field label={t('sourceName')} hint={t('sourceNameHint')}>
          <Input required value={name} placeholder={t('sourceNamePlaceholder')} aria-invalid={checks.name?.ok === false}
            onChange={event => setName(event.target.value)} />
        </Field>
      </VerifyRow>
      <VerifyRow label={t('sourceAddKind')} busy={checking.kind === true} check={checks.kind}
        onVerify={() => { void runVerify('kind') }}>
        <Field label={t('sourceAddKind')}>
          <select className="dt-select" value={selected} onChange={event => { setKind(event.target.value); setConfig({}); setChecks({}) }}>
            {kinds.map(item => <option key={item.kind} value={item.kind}>{localized(t, item.title)}</option>)}
          </select>
        </Field>
      </VerifyRow>
      <VerifyRow label={t('sourceAddId')} busy={checking.id === true} check={checks.id}
        onVerify={() => { void runVerify('id') }}>
        <Field label={t('sourceAddId')} hint={t('sourceAddIdHint')}>
          <Input value={id} placeholder={selected ? `${selected}-2` : ''} onChange={event => setId(event.target.value)} />
        </Field>
      </VerifyRow>
    </div>
    {(spec?.fields ?? []).map(field => <VerifyRow key={field.key} label={localized(t, field.label)}
      busy={checking[field.key] === true} check={checks[field.key]} onVerify={() => { void runVerify(field.key) }}>
      <SourceField field={field} value={config[field.key]} saved={undefined} fact={undefined} labels={{}}
        records={records} onChange={next => edit(field, next)} />
    </VerifyRow>)}
    <div className="dt-row-buttons">
      <Button variant="outline" disabled={checking.all === true} aria-busy={checking.all === true}
        onClick={() => { void runVerify('all') }}>{checking.all ? t('verifyBusy') : t('verifyAll')}</Button>
      <Button variant="primary" disabled={create.busy || !selected || !name.trim()}
        onClick={() => { void create.run() }}>{t('taskSourceAdd')}</Button>
    </div>
  </div>
}

/** 任务来源设置页：新增表单 + 已保存记录列表。 */
export function TaskSourceSettings() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  return <>
    <AddTaskSource />
    <div className="dt-cards">
      {settings.taskSources.length === 0
        ? <p className="dt-hint">{t('taskSourceNone')}</p>
        : settings.taskSources.map(source => <div className="dt-card" key={source.id}>
          <div className="dt-row-main">
            <div className="dt-row-title">
              <span className="dt-card-title">{source.name}</span>
              <Tag>{source.id}</Tag>
            </div>
            <div className="dt-row-buttons">
              <ConfirmButton label={t('taskSourceDelete')} title={t('taskSourceDeleteTitle')}
                message={t('taskSourceDeleteConfirm', { name: source.name })} icon="trash" variant="outline"
                onConfirm={async () => {
                  await call('DELETE task-sources/:id', { id: source.id })
                  notify(t('taskSourceDeleted', { name: source.name }))
                  await reload()
                }} />
            </div>
          </div>
          <p className="dt-hint">{source.title ? localized(t, source.title) : source.kind}{' · '}{source.kind}</p>
        </div>)}
    </div>
  </>
}
