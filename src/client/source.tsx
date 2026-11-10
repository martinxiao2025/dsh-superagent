/** 来源状态视图（健康状态、被过滤的触发器、被丢弃的回复）与来源设置卡片。 */
import { useEffect, useState } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type SourceStatusRow, type SourceView } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Input, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { sourceMark } from './marks.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { ConfigHistory, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { actorName, healthText, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, LabelValue, LoadState, SetupMessage, StatusHead, When } from './widgets.tsx'

/** 「新增来源」区块：选择已安装类型并以默认配置创建记录，再在下方卡片补全配置。 */
function AddSource() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const kinds = settings.kinds
  const [kind, setKind] = useState('')
  const [id, setId] = useState('')
  const create = useAction(async () => {
    const request = id.trim() ? { kind, id: id.trim() } : { kind }
    const { id: created } = await call('POST sources', { body: request })
    notify(t('sourceAdded', { id: created }))
    setId('')
  }, { reload })
  if (kinds.length === 0) return null
  // 类型目录到达后默认选中第一项；`kind` 只记录用户的显式选择。
  const selected = kind || kinds[0]?.kind || ''
  return <div className="dt-source-add" role="group" aria-label={t('sourceAddTitle')}>
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-card-title">{t('sourceAddTitle')}</span><InfoTip text={t('sourceAddHint')} /></div>
    </div>
    <div className="dt-row-buttons">
      <div className="dt-field"><span className="dt-field-head"><label htmlFor="dt-source-add-kind">{t('sourceAddKind')}</label></span>
        <select id="dt-source-add-kind" className="dt-select" value={selected} onChange={event => setKind(event.target.value)}>
          {kinds.map(item => <option key={item.kind} value={item.kind}>{localized(t, item.title)}</option>)}
        </select>
      </div>
      <div className="dt-field"><span className="dt-field-head"><label htmlFor="dt-source-add-id">{t('sourceAddId')}</label></span>
        <Input id="dt-source-add-id" value={id} placeholder={selected ? `${selected}-2` : ''} onChange={event => setId(event.target.value)} />
      </div>
      <Button variant="primary" disabled={create.busy || !selected}
        onClick={() => { void create.run() }}>{t('sourceAdd')}</Button>
    </div>
    <Hint>{t('sourceAddIdHint')}</Hint>
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
  return <div className="dt-form">
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
          onClick={() => navigate(settingsRoute('source', { source: source.id }))}>
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

export function SourceStatus() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error } = usePoll(() => call('GET sources'), [])
  // 全局部署初始化问题会停掉所有来源并显示在顶部；来源特有的初始化问题显示在该来源行上。
  const elsewhere = setup?.problem?.place === 'deployment' ? setup.problem : undefined
  return <div className="dt-form">
    <StatusHead hint={t('sourceStatusIntro')} settings="source" />
    {elsewhere && <p className="dt-error">
      <SetupMessage problem={elsewhere} lead /> <button type="button" className="dt-textlink"
        onClick={() => navigate(setupPage(elsewhere.place))}>{t('setupFixLink')}</button>
    </p>}
    <LoadState error={error} loading={!data} />
    {data && <ul className="dt-list">{data.map(source => <SourceRow key={source.id} source={source} />)}</ul>}
  </div>
}
