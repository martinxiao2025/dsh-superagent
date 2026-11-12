/** 来源状态视图（健康状态、被过滤的触发器、被丢弃的回复）与来源设置卡片。 */
import { useEffect, useState, type ReactElement } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type SourceStatusRow, type SourceView } from './api.ts'
import type { SourceCheck } from '../setup.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Input, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { sourceMark } from './marks.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { ConfigHistory, Field, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { actorName, errorText, healthText, localized, readableMarkers, reasonLabel, sourceCheckText, valueLabel, when } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, LabelValue, LoadState, Section, SetupMessage, StatusHead, When } from './widgets.tsx'

/** 新增表单里每个类型优先展示的关键字段；消息来源目前只有飞书。 */
const ADD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  feishu: ['instanceUrl', 'cli'],
}
/** 一行字段加一个独立的验证按钮，结果就地显示在字段下方。 */
export function VerifyRow({ label, busy, check, onVerify, children }: { label: string; busy: boolean; check?: SourceCheck
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
/** 「新增来源」区块：项目名称 + 类型 + 关键配置，逐字段真实预检后一次性创建。 */
function AddSource() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const kinds = settings.kinds
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
    const { id: created } = await call('POST sources', { body })
    notify(t('sourceAdded', { id: created }))
    setName(''); setId(''); setConfig({}); setChecks({})
  }, { reload })
  if (kinds.length === 0) return null
  // 类型目录到达后默认选中第一项；`kind` 只记录用户的显式选择。只有一种类型时不显示选择器。
  const single = kinds.length === 1
  const selected = single ? kinds[0]!.kind : kind || kinds[0]?.kind || ''
  const spec = kinds.find(item => item.kind === selected)
  const keys = ADD_FIELDS[selected]
  const visible = (spec?.fields ?? []).filter(field => keys ? keys.includes(field.key) : !field.advanced)
  const records = settings.sources.map(source => ({ id: source.id, kind: source.kind, title: source.title }))
  const edit = (field: FieldSpec, next: unknown) => setConfig(current => ({ ...current, [field.key]: next }))
  const chooseKind = (next: string) => {
    setKind(next); setConfig({}); setChecks({})
  }
  const runVerify = async (field: string) => {
    setChecking(current => ({ ...current, [field]: true }))
    try {
      const body = { kind: selected, name: name.trim(), ...id.trim() ? { id: id.trim() } : {}, config, field }
      const result = await call('POST sources/verify', { body })
      setChecks(current => {
        const next = { ...current }
        for (const check of result.checks) next[check.field] = check
        return next
      })
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(current => ({ ...current, [field]: false })) }
  }
  return <div className="dt-source-add" role="group" aria-label={t('sourceAddTitle')}>
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-card-title">{t('sourceAddTitle')}</span><InfoTip text={t('sourceAddHint')} /></div>
    </div>
    <div className="dt-add-grid">
      <VerifyRow label={t('sourceRecordName')} busy={checking.name === true} check={checks.name}
        onVerify={() => { void runVerify('name') }}>
        <Field label={t('sourceRecordName')} hint={t('sourceRecordNameHint')}>
          <Input required value={name} placeholder={t('sourceRecordNamePlaceholder')} aria-invalid={checks.name?.ok === false}
            onChange={event => setName(event.target.value)} />
        </Field>
      </VerifyRow>
      {!single && <VerifyRow label={t('sourceAddKind')} busy={checking.kind === true} check={checks.kind}
        onVerify={() => { void runVerify('kind') }}>
        <Field label={t('sourceAddKind')}>
          <select className="dt-select" value={selected} onChange={event => chooseKind(event.target.value)}>
            {kinds.map(item => <option key={item.kind} value={item.kind}>{localized(t, item.title)}</option>)}
          </select>
        </Field>
      </VerifyRow>}
      <VerifyRow label={t('sourceAddId')} busy={checking.id === true} check={checks.id}
        onVerify={() => { void runVerify('id') }}>
        <Field label={t('sourceAddId')} hint={t('sourceAddIdHint')}>
          <Input value={id} placeholder={selected ? `${selected}-2` : ''} onChange={event => setId(event.target.value)} />
        </Field>
      </VerifyRow>
    </div>
    <div className="dt-add-fields">
      {visible.map(field => <VerifyRow key={field.key} label={localized(t, field.label)} busy={checking[field.key] === true}
        check={checks[field.key]} onVerify={() => { void runVerify(field.key) }}>
        <SourceField field={field} value={config[field.key]} saved={undefined} fact={undefined} labels={{}}
          records={records} onChange={next => edit(field, next)} />
      </VerifyRow>)}
    </div>
    <div className="dt-row-buttons">
      <Button variant="outline" disabled={checking.all === true} aria-busy={checking.all === true}
        onClick={() => { void runVerify('all') }}>{checking.all ? t('verifyBusy') : t('verifyAll')}</Button>
      <Button variant="primary" disabled={create.busy || !selected || !name.trim()}
        onClick={() => { void create.run() }}>{t('sourceAdd')}</Button>
    </div>
  </div>
}

function SourceCard({ source, records }: { source: SourceView; records: readonly SourceView[] }) {
  const { t, call, notify } = usePanel()
  const { running } = usePanelData()
  const { reload } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const value = draft.value
  const { problem, value: saved } = source
  const changed = (key: string) => String(value.config[key] ?? '') !== String(saved.config[key] ?? '')
  // 保存修改后的初始化敏感字段会重启 dsh-superagent，中断正在运行的派工。
  const restarts = draft.dirty && source.restarts.some(changed)
  const description = localized(t, source.description)
  // 对未保存的字段编辑隐藏派生事实，直到新值被保存。
  const field = (spec: FieldSpec) => <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={saved.config[spec.key]}
    labels={source.labels} records={records}
    refreshLabels={refreshLabels} fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
    onChange={next => draft.edit({ ...value, config: { ...value.config, [spec.key]: next } })} />
  const advanced = source.fields.filter(spec => spec.advanced)
  // 停用一条仍有未结束工单的记录会结束这些工单；保存前把这个后果说清楚。
  const disabling = saved.enabled && !value.enabled
  const deleteMessage = source.openTickets > 0
    ? t('sourceDeleteBlocked', { count: source.openTickets })
    : t('sourceDeleteConfirm', { name: localized(t, source.title) })
  const status = disabling && source.openTickets > 0 ? t('sourceDisableStops', { count: source.openTickets })
    : restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined
  return <form id={`dt-source-${source.id}`} className="dt-card" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-card-head">
        <div className="dt-row-main">
          <div className="dt-row-title">
            <span className="dt-card-title">{localized(t, source.title)}</span>{description && <InfoTip text={description} />}
            {!source.installed && <Tag tone="warning">{t('sourceNotInstalled')}</Tag>}
          </div>
        </div>
        <div className="dt-row-buttons">
          {source.installed && <Switch checked={value.enabled} onChange={enabled => draft.edit({ ...value, enabled })}
            label={t('sourceEnable', { name: localized(t, source.title) })} />}
          <ConfirmButton label={t('sourceDelete')} title={t('sourceDeleteTitle')} message={deleteMessage} icon="trash"
            variant="outline" onConfirm={async () => {
              await call('DELETE sources/:id', { id: source.id })
              notify(t('sourceDeleted', { name: localized(t, source.title) }))
              await reload()
            }} />
        </div>
      </div>
      {problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={problem} lead /></p><CheckSetupButton />
      </div>}
      {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
      <Field label={t('sourceRecordName')} hint={t('sourceRecordNameHint')}>
        <Input required value={value.name} placeholder={t('sourceRecordNamePlaceholder')}
          onChange={event => draft.edit({ ...value, name: event.target.value })} />
      </Field>
      {source.installed && source.fields.filter(spec => !spec.advanced).map(field)}
      {source.installed && advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advancedOpen}
        onToggle={() => setAdvancedOpen(!advancedOpen)}>
        <div className="dt-disclosure-body">{advanced.map(field)}</div>
      </DisclosureRow>}
    </Fields>
    <SaveBar {...draft} status={status} onDiscard={draft.discard} />
  </form>
}

export function SourceSettings({ focus }: { focus?: string }) {
  const { sources } = useSettings().settings
  useEffect(() => { if (focus) document.getElementById(`dt-source-${focus}`)?.scrollIntoView?.({ block: 'start' }) }, [focus])
  // 与项目向导同页时用独立类名区分两处「新增」表单。
  return <div className="dt-form dt-source-settings">
    <AddSource />
    {sources.map(source => <SourceCard key={source.id} source={source} records={sources} />)}
    <ConfigHistory blocks={['source:']} />
  </div>
}

function DroppedReplies({ items }: { items: DroppedReply[] }) {
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  // 链接到消息对应的工单；对于回执记录 `ticketId` 之前排队的消息，则回退到其线程。
  const target = (item: DroppedReply): { route: Route; name: string } | undefined => item.ticket
    ? { route: { page: 'execution', id: item.ticket.id }, name: item.ticket.title }
    : item.thread ? { route: { page: 'trigger', id: item.thread }, name: t('term.thread') } : undefined
  return <DisclosureRow icon={<Icon name="dismiss" />} title={<>{t('sourceDroppedTitle')} <span
    className="dt-count">{items.length}</span></>} open={open}
    onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('sourceDroppedHint')}</Hint>
      <ul className="dt-list">{items.map(item => {
        const link = target(item)
        return <li key={item.id} className="dt-row"><Dot state="idle" /><div className="dt-row-main">
          <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
          <div className="dt-row-meta">
            <Tag tone="neutral">{reasonLabel(t, item.dropped.reason)}</Tag><When at={item.dropped.at} />
            {link && <button type="button" className="dt-textlink" onClick={() => navigate(link.route)}>{link.name}</button>}
          </div>
        </div></li>
      })}</ul>
    </div>
  </DisclosureRow>
}
function SourceRow({ source }: { source: SourceStatusRow }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const [filteredOpen, setFilteredOpen] = useState(false)
  const { problem, dropped } = source
  const { dot, label: state } = sourceMark(t, source.state)
  const { received, filtered, lastAt } = source.stats
  // 当初始化问题已说明来源为何停止时，省略健康的部分并抑制各部分备注。
  const notes = source.enabled && !problem && !setup?.problem ? source.health.filter(item => item.state === 'error'
    || item.state === 'paused') : []
  return <li className="dt-row">
    <Dot state={dot} label={state} />
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-row-name">{localized(t, source.title)}</span><span className="dt-status-text"
        data-state={dot}>{state}</span></div>
      <div className="dt-row-meta">
        {received > 0 && <LabelValue label={t('sourceReceivedLabel')}
          value={received} />}{filtered > 0 && <LabelValue label={t('sourceFilteredLabel')} value={filtered} />}
        {lastAt && <LabelValue label={t('sourceLatestLabel')} value={when(lastAt, t('lang'))} />}
      </div>
      {problem && <p className="dt-error">
        <SetupMessage problem={problem} lead /> <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute('feishuCredentials', { tab: 'ingress' }))}>
          {t('sourceOpenSettings')}
        </button>
      </p>}
      {notes.map(item => <p key={item.name} className={item.state === 'error' ? 'dt-error dt-clamp' : 'dt-hint dt-clamp'}>
        {valueLabel(t, 'health', item.name)}{t('labelSeparator')}<span className={item.code ? undefined : 'dt-mono'}>{healthText(t,
          item)}</span>
      </p>)}
      {source.filtered.length > 0 && <DisclosureRow icon={<Icon name="filter" />} title={t('sourceFilteredTitle')} open={filteredOpen}
        onToggle={() => setFilteredOpen(!filteredOpen)}>
        <div className="dt-disclosure-body">
          <ul className="dt-list">{source.filtered.map(item => <li key={item.id} className="dt-row"><Dot state="idle" /><div
            className="dt-row-main">
            <div className="dt-row-title">{actorName(t, item.actor)}{t('labelSeparator')}{readableMarkers(t, item.preview)
              || t('empty')}</div>
            <div className="dt-row-meta"><Tag tone="neutral">{reasonLabel(t, item.reason)}</Tag><When at={item.at} /></div>
          </div></li>)}</ul>
        </div>
      </DisclosureRow>}
      {dropped.length > 0 && <DroppedReplies items={dropped} />}
    </div>
  </li>
}

/** 消息来源健康列表；不含页头，供来源总览与任务来源设置页共用。 */
export function SourceHealth() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error } = usePoll(() => call('GET sources'), [])
  // 全局部署初始化问题会停掉所有来源并显示在顶部；来源特有的初始化问题显示在该来源行上。
  const elsewhere = setup?.problem?.place === 'deployment' ? setup.problem : undefined
  return <>
    {elsewhere && <p className="dt-error">
      <SetupMessage problem={elsewhere} lead /> <button type="button" className="dt-textlink"
        onClick={() => navigate(setupPage(elsewhere.place))}>{t('setupFixLink')}</button>
    </p>}
    <LoadState error={error} loading={!data} />
    {data && <ul className="dt-list">{data.map(source => <SourceRow key={source.id} source={source} />)}</ul>}
  </>
}

export function SourceStatus() {
  const { t } = usePanel()
  return <div className="dt-form">
    <StatusHead hint={t('sourceStatusIntro')} settings="feishuCredentials" settingsQuery={{ tab: 'ingress' }} />
    <SourceHealth />
  </div>
}
