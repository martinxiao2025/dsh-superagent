/** 模型配置分组：两个角色位、六个工作阶段与子代理；每项留空继承宿主默认。 */
import type { ApiResponse } from '../app/api.ts'
import { STAGES } from '../core/stages.ts'
import type { Settings } from './api.ts'
import { usePoll } from './api.ts'
import { InfoTip } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { ConfigHistory, Fields, ModelField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Section } from './widgets.tsx'

type RoleModel = Settings['models']['worker']

/** 回顾简表：按提示词修订分桶的工单结果与用量，为「改一处、再度量」的自我升级循环提供对照。 */
function RetroSection() {
  const { t, call } = usePanel()
  const { data } = usePoll(() => call('GET retro', { query: { by: 'revision' } }), [])
  const bucket = (item: ApiResponse<'GET retro'>['buckets'][number]) => [String(item.key), String(item.tickets), String(item.requests),
    String(item.input), String(item.output), `${item.completed}/${item.merged}/${item.closed}/${item.dropped}/${item.stopped}/${item.failed}`]
  return <Section title={t('retroTitle')} hint={t('retroIntro')}>
    <table className="dt-table">
      <thead><tr>{(['retroRevision', 'retroTickets', 'retroRequests', 'retroInput', 'retroOutput', 'retroOutcomes'] as const)
        .map(name => <th key={name}>{t(name)}</th>)}</tr></thead>
      <tbody>{data?.buckets.map(item => <tr key={item.key}>{bucket(item).map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
    </table>
    {!data?.buckets.length && <small>{t('retroEmpty')}</small>}
  </Section>
}

/** 一个 `models` 块的表单；模型目录整页只拉一次，经 props 下发给全部槽位（此前每个槽位独立请求，共 10 次）。 */
function ModelsBlock() {
  const { t, call } = usePanel()
  const block = useSettings().settings.blocks.models
  const draft = useBlockDraft('models', block.value, block.revision)
  const { data: catalog, error } = usePoll(() => call('GET models'), [])
  const catalogError = error ? String(error) : undefined
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const slot = (label: string, hint: string, id: string, current: RoleModel,
    change: (model: RoleModel) => void) => <Section title={label} hint={hint}>
    <ModelField id={id} value={current} onChange={change} catalog={catalog} error={catalogError} /></Section>
  return <form className="dt-form dt-block" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <h2 className="dt-block-title">{t('modelsSettings')}<InfoTip text={t('modelsIntro')} /></h2>
      {slot(t('modelOrchestrator'), t('modelOrchestratorHint'), 'dt-model-orchestrator', value.orchestrator,
        model => edit({ orchestrator: model }))}
      {slot(t('modelWorker'), t('modelWorkerHint'), 'dt-model-worker', value.worker, model => edit({ worker: model }))}
      <h2 className="dt-block-title">{t('modelStages')}<InfoTip text={t('modelStagesHint')} /></h2>
      {STAGES.map(stage => slot(t(`stageName.${stage}`), t(`stageBrief.${stage}`), `dt-model-stage-${stage}`, value.stages[stage],
        model => edit({ stages: { ...value.stages, [stage]: model } })))}
      {slot(t('modelSubagent'), t('modelSubagentHint'), 'dt-model-subagent', value.subagent, model => edit({ subagent: model }))}
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

/** 模型分组页面：一个 `models` 块的表单、其配置历史，以及按修订对比的回顾简表。 */
export function ModelsSettings() {
  return <div className="dt-form">
    <ModelsBlock />
    <ConfigHistory blocks={['models']} versions />
    <RetroSection />
  </div>
}
