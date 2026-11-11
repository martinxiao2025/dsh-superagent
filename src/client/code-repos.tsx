/** 代码仓库设置：GitHub / GitLab 记录只用于克隆与同步，字段目录来自类型描述。 */
import { useState } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import type { SourceCheck } from '../setup.ts'
import type { SettingsView } from './api.ts'
import { Button, Input, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { VerifyRow } from './source.tsx'
import { errorText, localized } from './text.ts'
import { ConfirmButton, Hint } from './widgets.tsx'

type CodeRepoView = SettingsView['codeRepos'][number]

/** 收集预检结果：同一字段的旧结果被新结果覆盖。 */
function mergeChecks(current: Record<string, SourceCheck>, checks: readonly SourceCheck[]) {
  const next = { ...current }
  for (const check of checks) next[check.field] = check
  return next
}

/** 新增代码仓库：类型目录 + 名称 + 类型字段，支持逐字段与全部真实预检。 */
function AddCodeRepo() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const kinds = settings.codeRepoKinds
  const [kind, setKind] = useState('')
  const [name, setName] = useState('')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const selected = kind || kinds[0]?.kind || ''
  const spec = kinds.find(item => item.kind === selected)
  const create = useAction(async () => {
    const body: { kind: 'github' | 'gitlab'; name: string; config?: unknown } = { kind: selected as 'github' | 'gitlab',
      name: name.trim() }
    if (Object.keys(config).length > 0) body.config = config
    const { id } = await call('POST code-repos', { body })
    notify(t('codeRepoAdded', { id }))
    setName('')
    setConfig({})
    setChecks({})
  }, { reload })
  const runVerify = async (field: string) => {
    setChecking(current => ({ ...current, [field]: true }))
    try {
      const result = await call('POST code-repos/verify', {
        body: { kind: selected as 'github' | 'gitlab', name: name.trim(), config, field },
      })
      setChecks(current => mergeChecks(current, result.checks))
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(current => ({ ...current, [field]: false })) }
  }
  if (kinds.length === 0) return null
  return <div className="dt-source-add" role="group" aria-label={t('codeRepoAddTitle')}>
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-card-title">{t('codeRepoAddTitle')}</span></div>
      <p className="dt-hint">{t('codeRepoAddHint')}</p>
    </div>
    <div className="dt-add-grid">
      <VerifyRow label={t('sourceName')} busy={checking.name === true} check={checks.name}
        onVerify={() => { void runVerify('name') }}>
        <Field label={t('sourceName')} hint={t('sourceNameHint')}>
          <Input required value={name} placeholder={t('sourceNamePlaceholder')} onChange={event => setName(event.target.value)} />
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
    </div>
    <div className="dt-add-fields">
      {(spec?.fields ?? []).map(field => <VerifyRow key={field.key} label={localized(t, field.label)}
        busy={checking[field.key] === true} check={checks[field.key]} onVerify={() => { void runVerify(field.key) }}>
        <SourceField field={field} value={config[field.key]} saved={undefined} fact={undefined} labels={{}} records={[]}
          onChange={next => setConfig(current => ({ ...current, [field.key]: next }))} />
      </VerifyRow>)}
    </div>
    <div className="dt-row-buttons">
      <Button variant="outline" disabled={checking.all === true || !selected}
        aria-busy={checking.all === true} onClick={() => { void runVerify('all') }}>
        {checking.all ? t('verifyBusy') : t('verifyAll')}
      </Button>
      <Button variant="primary" disabled={create.busy || !selected || !name.trim()}
        onClick={() => { void create.run() }}>{t('codeRepoAdd')}</Button>
    </div>
  </div>
}

/** 代码仓库设置页：新增表单 + 已保存记录列表。 */
export function CodeRepoSettings() {
  const { t } = usePanel()
  const { settings } = useSettings()
  return <>
    <AddCodeRepo />
    <div className="dt-cards">
      {settings.codeRepos.length === 0 ? <Hint>{t('codeRepoNone')}</Hint>
        : settings.codeRepos.map(repo => <CodeRepoCard key={repo.id} repo={repo} />)}
    </div>
  </>
}

function CodeRepoCard({ repo }: { repo: CodeRepoView }) {
  const { t, call, notify } = usePanel()
  const { reload } = useSettings()
  const [open, setOpen] = useState(false)
  return <div className="dt-card">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <span className="dt-card-title">{repo.name}</span><Tag>{repo.id}</Tag>
        {!repo.enabled && <Tag>{t('sourceOff')}</Tag>}
      </div>
      <div className="dt-row-buttons">
        <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>{t('edit')}</Button>
        <ConfirmButton label={t('codeRepoDelete')} title={t('codeRepoDeleteTitle')}
          message={t('codeRepoDeleteConfirm', { name: repo.name })} icon="trash" variant="outline"
          onConfirm={async () => {
            await call('DELETE code-repos/:id', { id: repo.id })
            notify(t('codeRepoDeleted', { name: repo.name }))
            await reload()
          }} />
      </div>
    </div>
    <p className="dt-hint">{repo.title ? localized(t, repo.title) : repo.kind}{' · '}{repo.kind}</p>
    {open && <CodeRepoForm repo={repo} />}
  </div>
}

function CodeRepoForm({ repo }: { repo: CodeRepoView }) {
  const { t, call, notify } = usePanel()
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const saved = { name: repo.value.name, enabled: repo.value.enabled, config: repo.value.config }
  const draft = useBlockDraft(`codeRepo:${repo.id}`, saved, repo.revision, value => ({ ...value }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const editField = (field: FieldSpec, next: unknown) => edit({ config: { ...value.config, [field.key]: next } })
  const runVerify = async (field: string) => {
    setChecking(current => ({ ...current, [field]: true }))
    try {
      // 用草稿值预检，保存前就能确认认证方式与远端是否真的可用。
      const result = await call('POST code-repos/verify', {
        body: { kind: repo.kind as 'github' | 'gitlab', id: repo.id, name: value.name, config: value.config, field },
      })
      setChecks(current => mergeChecks(current, result.checks))
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(current => ({ ...current, [field]: false })) }
  }
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <VerifyRow label={t('sourceName')} busy={checking.name === true} check={checks.name}
        onVerify={() => { void runVerify('name') }}>
        <Field label={t('sourceName')} hint={t('sourceNameHint')}>
          <Input required value={value.name} onChange={event => edit({ name: event.target.value })} />
        </Field>
      </VerifyRow>
      <Field label={t('projectEnabled')} hint={t('projectEnabledHint')}>
        <div><Switch checked={value.enabled} onChange={enabled => edit({ enabled })} label={t('projectEnabled')} /></div>
      </Field>
      {repo.fields.map(field => <VerifyRow key={field.key} label={localized(t, field.label)}
        busy={checking[field.key] === true} check={checks[field.key]} onVerify={() => { void runVerify(field.key) }}>
        <SourceField field={field} value={value.config[field.key]} saved={repo.value.config[field.key]}
          fact={undefined} labels={{}} records={[]} onChange={next => editField(field, next)} />
      </VerifyRow>)}
    </Fields>
    <div className="dt-row-buttons">
      <Button variant="outline" disabled={checking.all === true} aria-busy={checking.all === true}
        onClick={() => { void runVerify('all') }}>{checking.all ? t('verifyBusy') : t('verifyAll')}</Button>
    </div>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}
