/** 新建项目向导与已保存项目的卡片、编辑表单（从 projects.tsx 拆出）。 */
import { useState } from 'react'
import { usePoll } from './api.ts'
import { Button, Input, SegmentedControl, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field, Fields, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized, type T } from './text.ts'
import { ConfirmButton, Hint, LabelValue } from './widgets.tsx'
import { useFieldChecks } from './checks.tsx'
import { CredentialsProvider, DownloadTemplateButton, RepoEditor, SourceEditor, sourcePrimaryField, useCredentials,
  repoSummary, sourceSummary, type CodeRepoKindView, type ProjectView, type RepoKind, type RepoValue, type SourceValue,
  type TaskSourceKindView } from './project-editors.tsx'

/** 向导步骤：基本信息，代码仓库，任务来源，执行与调度。 */
const PROJECT_STEPS = ['basics', 'codeRepo', 'taskSource', 'execution'] as const
type ProjectStep = typeof PROJECT_STEPS[number]
/** 新建项目的默认执行参数；与 ProjectSchema 的默认值保持一致。 */
const PROJECT_DEFAULTS = {
  intervalMinutes: '30', maxRetries: '2', retryBackoffSeconds: '60', gitTimeoutSeconds: '0',
  pendingStatuses: '待处理, todo, pending, open', doneStatus: '已完成', failedStatus: '失败',
}
/** 新建项目的仓库/来源默认值：仓库取目录第一项，任务来源优先 Excel；配置为空，保存时由服务端补默认值。 */
const emptyRepo = (kinds: readonly CodeRepoKindView[]): RepoValue => ({ kind: (kinds[0]?.kind ?? 'github') as RepoKind, config: {} })
const emptySource = (kinds: readonly TaskSourceKindView[]): SourceValue =>
  ({ kind: (kinds.find(item => item.kind === 'excel') ?? kinds[0])?.kind ?? 'excel', config: {} })

/** 向导草稿：四步的全部表单值收敛为单一对象，重置即整体替换为 emptyWizard。 */
interface WizardDraft {
  name: string
  enabled: boolean
  repo: RepoValue
  gitCredential: string
  source: SourceValue
  feishuCredential: string
  directory: string
  branch: string
  prepare: string
  intervalMinutes: string
  gitTimeoutSeconds: string
  runOnStart: boolean
  maxRetries: string
  retryBackoffSeconds: string
  pendingStatuses: string
  doneStatus: string
  failedStatus: string
}
/** 空白向导：仓库取目录第一项，任务来源优先 Excel；配置为空，保存时由服务端补默认值。 */
const emptyWizard = (repoKinds: readonly CodeRepoKindView[], sourceKinds: readonly TaskSourceKindView[]): WizardDraft => ({
  name: '', enabled: true, repo: emptyRepo(repoKinds), gitCredential: '', source: emptySource(sourceKinds),
  feishuCredential: '', directory: '', branch: '', prepare: '', intervalMinutes: PROJECT_DEFAULTS.intervalMinutes,
  gitTimeoutSeconds: PROJECT_DEFAULTS.gitTimeoutSeconds, runOnStart: true,
  maxRetries: PROJECT_DEFAULTS.maxRetries, retryBackoffSeconds: PROJECT_DEFAULTS.retryBackoffSeconds,
  pendingStatuses: PROJECT_DEFAULTS.pendingStatuses, doneStatus: PROJECT_DEFAULTS.doneStatus, failedStatus: PROJECT_DEFAULTS.failedStatus,
})

/** 新建项目向导：四步填写完整参数，仓库与任务来源随项目一起创建。 */
export function ProjectWizard() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const { git, feishu, error: credentialError } = useCredentials()
  const [step, setStep] = useState<ProjectStep>('basics')
  const [draft, setDraft] = useState<WizardDraft>(() => emptyWizard(settings.codeRepoKinds, settings.taskSourceKinds))
  const [branches, setBranches] = useState<string[]>([])
  const [defaultBranch, setDefaultBranch] = useState('')
  const { name, enabled, repo, gitCredential, source, feishuCredential, directory, branch, prepare, intervalMinutes, gitTimeoutSeconds, runOnStart,
    maxRetries, retryBackoffSeconds, pendingStatuses, doneStatus, failedStatus } = draft
  const edit = (next: Partial<WizardDraft>) => setDraft(current => ({ ...current, ...next }))
  const repoChecks = useFieldChecks('POST code-repos/verify', () => ({ kind: repo.kind, config: repo.config, gitCredential }))
  const sourceChecks = useFieldChecks('POST task-sources/verify', () =>
    ({ kind: source.kind, config: source.config, repo, gitCredential, feishuCredential }))
  const interval = Number(intervalMinutes), retries = Number(maxRetries), backoff = Number(retryBackoffSeconds)
  const gitTimeout = Number(gitTimeoutSeconds)
  const numbersValid = [interval, retries, backoff, gitTimeout].every(value => Number.isInteger(value) && value >= 0)
  const policyValid = [pendingStatuses, doneStatus, failedStatus].every(value => value.trim() !== '')
  /** 仓库步就绪：全地址已填、连通性验证通过且已选分支；配置或凭据变更后必须重新验证。 */
  const repoConnected = repoChecks.checks.remote?.ok === true
  const sourceVerified = sourceChecks.checks[sourcePrimaryField(source.kind)]?.ok === true
  const ready = name.trim() !== '' && source.kind !== '' && numbersValid && policyValid
  const stepReady: Record<ProjectStep, boolean> = { basics: name.trim() !== '',
    codeRepo: String(repo.config.remote ?? '').trim() !== '' && repoConnected && branch.trim() !== '',
    taskSource: source.kind !== '' && sourceVerified, execution: numbersValid && policyValid }
  const position = PROJECT_STEPS.indexOf(step)
  const sourceName = settings.taskSourceKinds.find(item => item.kind === source.kind)
  /** 拉取远端分支：向导在仓库连通后据此渲染分支选择；已选分支仍在列表里时保持不变。 */
  const fetchBranches = useAction(async () => {
    const result = await call('POST code-repos/branches', { body: { kind: repo.kind, config: repo.config, gitCredential } })
    setBranches(result.branches)
    setDefaultBranch(result.defaultBranch)
    setDraft(current => ({ ...current, branch: current.branch && result.branches.includes(current.branch)
      ? current.branch : result.defaultBranch || current.branch }))
  })
  /** 仓库或凭据变更：清空验证结果与分支，逼着用户对新配置重新验证，避免把旧结论带进下一步。
   *  仓库类型与认证方式随凭据的联动在 RepoEditor 内完成。 */
  const updateRepo = (repo: RepoValue) => { edit({ repo, branch: '' }); repoChecks.reset(); setBranches([]); setDefaultBranch('') }
  const updateGitCredential = (gitCredential: string) => {
    edit({ gitCredential, branch: '' }); repoChecks.reset(); setBranches([]); setDefaultBranch('')
  }
  /** 任务来源变更：同样清空该步的验证结果。 */
  const updateSource = (source: SourceValue) => { edit({ source }); sourceChecks.reset() }
  /** 仓库字段预检：候选配置与 Git 凭据一起提交，不写入设置；地址字段验证通过后自动拉取分支。 */
  const verifyRepo = (field: string) => repoChecks.verify(field, checks => {
    if (checks.some(check => check.field === 'remote' && check.ok)) void fetchBranches.run()
  })
  /** 任务来源字段预检：连同项目的仓库候选与飞书凭据一起提交，驱动据此读取真实任务。 */
  const verifySource = (field: string) => sourceChecks.verify(field)
  const create = useAction(async () => {
    const { id } = await call('POST projects', { body: {
      name: name.trim(), enabled, codeRepo: repo, taskSource: source,
      gitCredential, feishuCredential,
      execution: { directory: directory.trim(), branch: branch.trim(), prepare, gitTimeoutSeconds: gitTimeout },
      schedule: { intervalMinutes: interval, runOnStart },
      retry: { maxRetries: retries, retryBackoffSeconds: backoff },
      taskPolicy: { pendingStatuses: pendingStatuses.split(/[,，]/).map(status => status.trim()).filter(Boolean),
        doneStatus: doneStatus.trim(), failedStatus: failedStatus.trim() },
    } })
    notify(t('projectAdded', { id }))
    setDraft(emptyWizard(settings.codeRepoKinds, settings.taskSourceKinds))
    repoChecks.reset(); sourceChecks.reset(); setBranches([]); setDefaultBranch('')
    setStep('basics')
  }, { reload })
  return <div className="dt-source-add" role="group" aria-label={t('projectWizardTitle')}>
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-card-title">{t('projectWizardTitle')}</span></div>
      <p className="dt-hint">{t('projectWizardHint')}</p>
    </div>
    <SegmentedControl className="dt-wizard-steps" label={t('projectWizardSteps')} value={step}
      options={PROJECT_STEPS.map((value, index) => ({ value, label: t(`projectStep.${value}`, { number: index + 1 }) }))}
      onChange={setStep} />
    <div className="dt-form dt-block">
      {step === 'basics' && <>
        <Field label={t('projectName')} hint={t('projectNameHint')}>
          <Input required value={name} placeholder={t('projectNamePlaceholder')}
            onChange={event => edit({ name: event.target.value })} />
        </Field>
        <Field label={t('projectEnabled')} hint={t('projectEnabledHint')}>
          <div><Switch checked={enabled} onChange={enabled => edit({ enabled })} label={t('projectEnabled')} /></div>
        </Field>
      </>}
      {step === 'codeRepo' && <>
        <div className="dt-add-grid">
          <RepoEditor kinds={settings.codeRepoKinds} value={repo} credential={gitCredential} credentials={git}
            checks={repoChecks.checks} checking={repoChecks.checking} credentialError={credentialError} onChange={updateRepo}
            onCredential={updateGitCredential} onVerify={field => { void verifyRepo(field) }} />
        </div>
        <Field label={t('projectBranch')} hint={t('projectBranchHint')}>
          <div className="dt-verify-row">
            {branches.length
              ? <select className="dt-select" aria-label={t('projectBranch')} value={branch}
                onChange={event => edit({ branch: event.target.value })}>
                {branches.map(item => <option key={item} value={item}>{item === defaultBranch
                  ? `${item} (${t('projectBranchDefault')})` : item}</option>)}
              </select>
              : <Input aria-label={t('projectBranch')} value={branch} placeholder={t('projectBranchEmpty')}
                onChange={event => edit({ branch: event.target.value })} />}
            <Button variant="outline" size="sm" disabled={fetchBranches.busy} aria-busy={fetchBranches.busy}
              onClick={() => { void fetchBranches.run() }}>{fetchBranches.busy ? t('verifyBusy') : t('projectBranchFetch')}</Button>
          </div>
        </Field>
      </>}
      {step === 'taskSource' && <>
        <div className="dt-add-grid">
          <SourceEditor kinds={settings.taskSourceKinds} value={source} credential={feishuCredential}
            feishuCredentials={feishu} checks={sourceChecks.checks} checking={sourceChecks.checking}
            credentialError={credentialError}
            onChange={updateSource} onCredential={feishuCredential => edit({ feishuCredential })}
            onVerify={field => { void verifySource(field) }} />
        </div>
        {source.kind === 'excel' && <div className="dt-row-buttons"><DownloadTemplateButton /></div>}
      </>}
      {step === 'execution' && <>
        <Field label={t('projectDirectory')} hint={t('projectDirectoryHint')}>
          <Input className="dt-mono" value={directory} placeholder={t('executionDirectoryEmpty')}
            onChange={event => edit({ directory: event.target.value })} />
        </Field>
        <Field label={t('projectPrepare')} hint={t('projectPrepareHint')}>
          <Input className="dt-mono" value={prepare} placeholder={t('projectPrepareEmpty')}
            onChange={event => edit({ prepare: event.target.value })} />
        </Field>
        <Field label={t('projectGitTimeout')} hint={t('projectGitTimeoutHint')}>
          <Input type="number" required value={gitTimeoutSeconds}
            onChange={event => edit({ gitTimeoutSeconds: event.target.value })} />
        </Field>
        <Field label={t('projectInterval')} hint={t('projectIntervalHint')}>
          <Input type="number" required value={intervalMinutes}
            onChange={event => edit({ intervalMinutes: event.target.value })} />
        </Field>
        <Field label={t('projectRunOnStart')} hint={t('projectRunOnStartHint')}>
          <div><Switch checked={runOnStart} onChange={runOnStart => edit({ runOnStart })} label={t('projectRunOnStart')} /></div>
        </Field>
        <Field label={t('projectMaxRetries')} hint={t('projectMaxRetriesHint')}>
          <Input type="number" required value={maxRetries} onChange={event => edit({ maxRetries: event.target.value })} />
        </Field>
        <Field label={t('projectBackoff')} hint={t('projectBackoffHint')}>
          <Input type="number" required value={retryBackoffSeconds}
            onChange={event => edit({ retryBackoffSeconds: event.target.value })} />
        </Field>
        <Field label={t('projectPendingStatuses')} hint={t('projectPendingStatusesHint')}>
          <Input required value={pendingStatuses} onChange={event => edit({ pendingStatuses: event.target.value })} />
        </Field>
        <Field label={t('projectDoneStatus')} hint={t('projectDoneStatusHint')}>
          <Input required value={doneStatus} onChange={event => edit({ doneStatus: event.target.value })} />
        </Field>
        <Field label={t('projectFailedStatus')} hint={t('projectFailedStatusHint')}>
          <Input required value={failedStatus} onChange={event => edit({ failedStatus: event.target.value })} />
        </Field>
        <div className="dt-row-meta dt-status-line">
          <LabelValue label={t('projectWizardSummaryName')} value={name.trim() || t('unsetValue')} />
          <LabelValue label={t('projectCodeRepoLabel')} value={`${repo.kind}${typeof repo.config.remote === 'string'
            && repo.config.remote ? ` · ${repo.config.remote}` : ''}`}/>
          <LabelValue label={t('projectBranch')} value={branch.trim() || t('unsetValue')} />
          <LabelValue label={t('projectTaskSourceLabel')} value={sourceName ? localized(t, sourceName.title) : source.kind} />
          <LabelValue label={t('projectWizardSummarySchedule')}
            value={t('projectWizardScheduleValue', { minutes: intervalMinutes, retries: maxRetries, backoff: retryBackoffSeconds })} />
        </div>
      </>}
    </div>
    <div className="dt-row-buttons">
      <Button variant="outline" disabled={position === 0}
        onClick={() => setStep(PROJECT_STEPS[position - 1]!)}>{t('projectBack')}</Button>
      {position < PROJECT_STEPS.length - 1
        ? <Button variant="primary" disabled={!stepReady[step]} onClick={() => setStep(PROJECT_STEPS[position + 1]!)}>{t('projectNext')}</Button>
        : <Button variant="primary" disabled={create.busy || !ready} onClick={() => { void create.run() }}>{t('projectCreate')}</Button>}
    </div>
  </div>
}

/** 已保存项目卡片：摘要与展开后的完整编辑表单。 */
export function ProjectCard({ project, focus }: { project: ProjectView; focus: boolean }) {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const [open, setOpen] = useState(focus)
  return <div className="dt-card">
    <div className="dt-row-main">
      <div className="dt-row-title">
        <span className="dt-card-title">{project.name}</span><Tag>{project.id}</Tag>
        {!project.value.enabled && <Tag>{t('sourceOff')}</Tag>}
      </div>
      <div className="dt-row-buttons">
        <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>{t('edit')}</Button>
        <ConfirmButton label={t('projectDelete')} title={t('projectDeleteTitle')}
          message={t('projectDeleteConfirm', { name: project.name })} icon="trash" variant="outline"
          onConfirm={async () => {
            await call('DELETE projects/:id', { id: project.id })
            notify(t('projectDeleted', { name: project.name }))
            await reload()
          }} />
      </div>
    </div>
    <p className="dt-hint">{t('projectCardSummary', { repo: repoSummary(project.value),
      source: sourceSummary(t, settings, project.value) })}</p>
    {open && <ProjectForm project={project} />}
  </div>
}

/** 项目编辑表单值：执行参数以字符串承载输入，保存时按声明式 spec 写回 API 值。 */
type ProjectFormValue = Omit<ProjectView['value'], 'schedule' | 'retry' | 'taskPolicy'> & {
  schedule: { intervalMinutes: string; runOnStart: boolean }
  retry: { maxRetries: string; retryBackoffSeconds: string }
  taskPolicy: { pendingStatuses: string; doneStatus: string; failedStatus: string }
}
/** 表单字符串 ⇄ 保存值的单字段双向转换。 */
interface FieldConversion<Form, Saved> { read: (saved: Saved) => Form; write: (form: Form) => Saved }
/** 数字输入：表单以字符串承载；保存时解析，非法输入按 0 提交，由服务端校验拒绝。 */
const numberField: FieldConversion<string, number> = { read: String, write: text => numberOf(text) ?? 0 }
/** 状态清单：表单是逗号分隔字符串；保存时拆分、去空白、去空项。 */
const statusListField: FieldConversion<string, string[]> = { read: list => list.join(', '),
  write: text => text.split(/[,，]/).map(status => status.trim()).filter(Boolean) }
/** 原样字段：读写都不转换。 */
const plainField: FieldConversion<string, string> = { read: value => value, write: form => form }
/** 项目编辑表单的声明式规格：saved 与 toValue 由同一份 spec 派生，转换规则只写一遍。 */
const PROJECT_FORM_SPEC = {
  schedule: { intervalMinutes: numberField },
  retry: { maxRetries: numberField, retryBackoffSeconds: numberField },
  taskPolicy: { pendingStatuses: statusListField, doneStatus: plainField, failedStatus: plainField },
}
/** 已保存项目值 → 表单初值：spec 声明的组按 read 逐字段转换，其余原样保留。 */
const projectFormOf = (value: ProjectView['value']): ProjectFormValue => ({
  ...value,
  schedule: { ...value.schedule, intervalMinutes: PROJECT_FORM_SPEC.schedule.intervalMinutes.read(value.schedule.intervalMinutes) },
  retry: { ...value.retry, maxRetries: PROJECT_FORM_SPEC.retry.maxRetries.read(value.retry.maxRetries),
    retryBackoffSeconds: PROJECT_FORM_SPEC.retry.retryBackoffSeconds.read(value.retry.retryBackoffSeconds) },
  taskPolicy: { ...value.taskPolicy,
    pendingStatuses: PROJECT_FORM_SPEC.taskPolicy.pendingStatuses.read(value.taskPolicy.pendingStatuses),
    doneStatus: PROJECT_FORM_SPEC.taskPolicy.doneStatus.read(value.taskPolicy.doneStatus),
    failedStatus: PROJECT_FORM_SPEC.taskPolicy.failedStatus.read(value.taskPolicy.failedStatus) },
})
/** 表单值 → 保存载荷：与 projectFormOf 使用同一份 spec，按 write 方向写回。 */
const projectValueOf = (form: ProjectFormValue): ProjectView['value'] => ({
  ...form,
  schedule: { ...form.schedule, intervalMinutes: PROJECT_FORM_SPEC.schedule.intervalMinutes.write(form.schedule.intervalMinutes) },
  retry: { ...form.retry, maxRetries: PROJECT_FORM_SPEC.retry.maxRetries.write(form.retry.maxRetries),
    retryBackoffSeconds: PROJECT_FORM_SPEC.retry.retryBackoffSeconds.write(form.retry.retryBackoffSeconds) },
  taskPolicy: { ...form.taskPolicy,
    pendingStatuses: PROJECT_FORM_SPEC.taskPolicy.pendingStatuses.write(form.taskPolicy.pendingStatuses),
    doneStatus: PROJECT_FORM_SPEC.taskPolicy.doneStatus.write(form.taskPolicy.doneStatus),
    failedStatus: PROJECT_FORM_SPEC.taskPolicy.failedStatus.write(form.taskPolicy.failedStatus) },
})

/** 项目编辑：仓库、任务来源、执行位置与调度策略在同一表单中保存。 */
function ProjectForm({ project }: { project: ProjectView }) {
  const { t } = usePanel()
  const { settings } = useSettings()
  const { git, feishu, error: credentialError } = useCredentials()
  const draft = useBlockDraft(`project:${project.id}`, projectFormOf(project.value), project.revision, projectValueOf)
  const value = draft.value
  const repoChecks = useFieldChecks('POST code-repos/verify', () =>
    ({ kind: value.codeRepo.kind, config: value.codeRepo.config, gitCredential: value.gitCredential }))
  /** 任务来源预检：用已保存的项目 ID 解析真实仓库，Excel 驱动因此能读到项目的工作副本。 */
  const sourceChecks = useFieldChecks('POST task-sources/verify', () =>
    ({ kind: value.taskSource.kind, config: value.taskSource.config, projectId: project.id, repo: value.codeRepo,
      gitCredential: value.gitCredential, feishuCredential: value.feishuCredential }))
  const edit = (next: Partial<ProjectFormValue>) => draft.edit({ ...value, ...next })
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-form dt-block">
        <Field label={t('projectName')} hint={t('projectNameHint')}>
          <Input required value={value.name} onChange={event => edit({ name: event.target.value })} />
        </Field>
        <Field label={t('projectEnabled')} hint={t('projectEnabledHint')}>
          <div><Switch checked={value.enabled} onChange={enabled => edit({ enabled })} label={t('projectEnabled')} /></div>
        </Field>
        <Field label={t('projectDirectory')} hint={t('projectDirectoryHint')}>
          <Input className="dt-mono" value={value.execution.directory} placeholder={t('executionDirectoryEmpty')}
            onChange={event => edit({ execution: { ...value.execution, directory: event.target.value } })} />
        </Field>
        <Field label={t('projectBranch')} hint={t('projectBranchHint')}>
          <Input value={value.execution.branch} placeholder={t('projectBranchEmpty')}
            onChange={event => edit({ execution: { ...value.execution, branch: event.target.value } })} />
        </Field>
        <Field label={t('projectPrepare')} hint={t('projectPrepareHint')}>
          <Input className="dt-mono" value={value.execution.prepare} placeholder={t('projectPrepareEmpty')}
            onChange={event => edit({ execution: { ...value.execution, prepare: event.target.value } })} />
        </Field>
        <Field label={t('projectGitTimeout')} hint={t('projectGitTimeoutHint')}>
          <Input type="number" required value={String(value.execution.gitTimeoutSeconds)}
            onChange={event => edit({ execution: { ...value.execution, gitTimeoutSeconds: numberOf(event.target.value) ?? 0 } })} />
        </Field>
      </div>
      <div className="dt-form dt-block">
        <div className="dt-subhead"><span className="dt-field-head">{t('projectCodeRepoLabel')}</span></div>
        <div className="dt-add-grid">
          <RepoEditor kinds={settings.codeRepoKinds} value={value.codeRepo} credential={value.gitCredential} credentials={git}
            checks={repoChecks.checks} checking={repoChecks.checking} credentialError={credentialError}
            onChange={codeRepo => edit({ codeRepo })} onCredential={gitCredential => edit({ gitCredential })}
            onVerify={field => { void repoChecks.verify(field) }} />
        </div>
      </div>
      <div className="dt-form dt-block">
        <div className="dt-subhead"><span className="dt-field-head">{t('projectTaskSourceLabel')}</span></div>
        <div className="dt-add-grid">
          <SourceEditor kinds={settings.taskSourceKinds} value={value.taskSource} credential={value.feishuCredential}
            feishuCredentials={feishu} checks={sourceChecks.checks} checking={sourceChecks.checking}
            credentialError={credentialError}
            onChange={taskSource => edit({ taskSource })} onCredential={feishuCredential => edit({ feishuCredential })}
            onVerify={field => { void sourceChecks.verify(field) }} />
        </div>
        {value.taskSource.kind === 'excel' && <div className="dt-row-buttons"><DownloadTemplateButton /></div>}
      </div>
      <div className="dt-form dt-block">
        <Field label={t('projectInterval')} hint={t('projectIntervalHint')}>
          <Input type="number" required value={value.schedule.intervalMinutes}
            onChange={event => edit({ schedule: { ...value.schedule, intervalMinutes: event.target.value } })} />
        </Field>
        <Field label={t('projectRunOnStart')} hint={t('projectRunOnStartHint')}>
          <div><Switch checked={value.schedule.runOnStart} label={t('projectRunOnStart')}
            onChange={runOnStart => edit({ schedule: { ...value.schedule, runOnStart } })} /></div>
        </Field>
        <Field label={t('projectMaxRetries')} hint={t('projectMaxRetriesHint')}>
          <Input type="number" required value={value.retry.maxRetries}
            onChange={event => edit({ retry: { ...value.retry, maxRetries: event.target.value } })} />
        </Field>
        <Field label={t('projectBackoff')} hint={t('projectBackoffHint')}>
          <Input type="number" required value={value.retry.retryBackoffSeconds}
            onChange={event => edit({ retry: { ...value.retry, retryBackoffSeconds: event.target.value } })} />
        </Field>
      </div>
      <div className="dt-form dt-block">
        <Field label={t('projectPendingStatuses')} hint={t('projectPendingStatusesHint')}>
          <Input required value={value.taskPolicy.pendingStatuses}
            onChange={event => edit({ taskPolicy: { ...value.taskPolicy, pendingStatuses: event.target.value } })} />
        </Field>
        <Field label={t('projectDoneStatus')} hint={t('projectDoneStatusHint')}>
          <Input required value={value.taskPolicy.doneStatus}
            onChange={event => edit({ taskPolicy: { ...value.taskPolicy, doneStatus: event.target.value } })} />
        </Field>
        <Field label={t('projectFailedStatus')} hint={t('projectFailedStatusHint')}>
          <Input required value={value.taskPolicy.failedStatus}
            onChange={event => edit({ taskPolicy: { ...value.taskPolicy, failedStatus: event.target.value } })} />
        </Field>
      </div>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}
