/** 代码仓库设置：GitHub / GitLab 记录只用于克隆与同步，字段目录来自类型描述。 */
import { useState } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import type { SettingsView } from './api.ts'
import { Button, Input, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { ConfirmButton, Hint } from './widgets.tsx'

type CodeRepoView = SettingsView['codeRepos'][number]

/** 新增代码仓库：类型目录 + 名称 + 类型字段；不在这里做网络验证。 */
function AddCodeRepo() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const kinds = settings.codeRepoKinds
  const [kind, setKind] = useState('')
  const [name, setName] = useState('')
  const [config, setConfig] = useState<Record<string, unknown>>({})
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
  }, { reload })
  if (kinds.length === 0) return null
  return <div className="dt-source-add" role="group" aria-label={t('codeRepoAddTitle')}>
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-card-title">{t('codeRepoAddTitle')}</span></div>
      <p className="dt-hint">{t('codeRepoAddHint')}</p>
    </div>
    <div className="dt-add-grid">
      <Field label={t('sourceName')} hint={t('sourceNameHint')}>
        <Input required value={name} placeholder={t('sourceNamePlaceholder')} onChange={event => setName(event.target.value)} />
      </Field>
      <Field label={t('sourceAddKind')}>
        <select className="dt-select" value={selected} onChange={event => { setKind(event.target.value); setConfig({}) }}>
          {kinds.map(item => <option key={item.kind} value={item.kind}>{localized(t, item.title)}</option>)}
        </select>
      </Field>
    </div>
    {(spec?.fields ?? []).map(field => <SourceField key={field.key} field={field} value={config[field.key]} saved={undefined}
      fact={undefined} labels={{}} records={[]}
      onChange={next => setConfig(current => ({ ...current, [field.key]: next }))} />)}
    <div className="dt-row-buttons">
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
  const { t } = usePanel()
  const saved = { name: repo.value.name, enabled: repo.value.enabled, config: repo.value.config }
  const draft = useBlockDraft(`codeRepo:${repo.id}`, saved, repo.revision, value => ({ ...value }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const editField = (field: FieldSpec, next: unknown) => edit({ config: { ...value.config, [field.key]: next } })
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <Field label={t('sourceName')} hint={t('sourceNameHint')}>
        <Input required value={value.name} onChange={event => edit({ name: event.target.value })} />
      </Field>
      <Field label={t('projectEnabled')} hint={t('projectEnabledHint')}>
        <div><Switch checked={value.enabled} onChange={enabled => edit({ enabled })} label={t('projectEnabled')} /></div>
      </Field>
      {repo.fields.map(field => <SourceField key={field.key} field={field} value={value.config[field.key]} saved={repo.value.config[field.key]}
        fact={undefined} labels={{}} records={[]} onChange={next => editField(field, next)} />)}
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}
