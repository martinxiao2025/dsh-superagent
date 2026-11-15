/** 模型配置分组：两个角色位、六个工作阶段、子代理与工具型小模型；每项留空继承宿主默认。 */
import { STAGES } from '../core/stages.ts'
import type { Settings } from './api.ts'
import { InfoTip } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { ConfigHistory, Fields, ModelField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Section } from './widgets.tsx'

type Models = Settings['models']
type RoleModel = Models['worker']
function ModelsBlock() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.models
  const draft = useBlockDraft('models', block.value, block.revision)
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const slot = (label: string, hint: string, id: string, current: RoleModel,
    change: (model: RoleModel) => void) => <Section title={label} hint={hint}>
    <ModelField id={id} value={current} onChange={change} /></Section>
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
      {slot(t('modelUtility'), t('modelUtilityHint'), 'dt-model-utility', value.utility, model => edit({ utility: model }))}
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

/** 模型分组页面：一个 `models` 块的表单与其配置历史。 */
export function ModelsSettings() {
  return <div className="dt-form">
    <ModelsBlock />
    <ConfigHistory blocks={['models']} versions />
  </div>
}
