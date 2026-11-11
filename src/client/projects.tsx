/** 项目页签与项目设置：项目列表与运行时概览、单项目的任务与队列详情，以及按项目配置的轮询与重试策略。 */
import { useEffect, useState } from 'react'
import type { GitCredentialView } from '../git-credentials/kind.ts'
import { ApiError, usePoll, type SettingsView } from './api.ts'
import { Button, Input, SegmentedControl, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { Field, Fields, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { errorText, when } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadState, PageHead, Section, StatusHead } from './widgets.tsx'

type ProjectView = SettingsView['projects'][number]

/** 项目列表：全局 worker 占用与排队数，以及每个项目的运行时摘要。 */
export function ProjectsPage() {
  const { t, call, navigate } = usePanel()
  const settings = usePoll(() => call('GET settings'), [])
  const queue = usePoll(() => call('GET queue'), [], 3000)
  const projects = settings.data?.projects ?? []
  const items = queue.data?.items ?? []
  const repoName = (id: string) => settings.data?.codeRepos.find(repo => repo.id === id)?.name ?? id
  const sourceName = (id: string) => settings.data?.taskSources.find(source => source.id === id)?.name ?? id
  const count = (project: string, states: readonly string[]) =>
    items.filter(item => item.project === project && states.includes(item.state)).length
  return <>
    <StatusHead hint={t('projectsIntro')} settings="projects" />
    <div className="dt-row-meta dt-status-line">
      {queue.data && <>
        <LabelValue label={t('executingLabel')} value={`${queue.data.used} / ${queue.data.maxWorkers}`} />
        <LabelValue label={t('queuedLabel')} value={items.filter(item => item.state === 'queued').length} />
      </>}
    </div>
    <LoadState error={settings.error ?? queue.error} loading={!settings.data} />
    {settings.data && (projects.length === 0 ? <Hint>{t('projectNone')}</Hint>
      : <ul className="dt-list">{projects.map(project => {
        const running = count(project.id, ['starting', 'running'])
        const queued = count(project.id, ['queued'])
        return <li className="dt-row" key={project.id}>
          <div className="dt-row-main">
            <div className="dt-row-title">
              <button type="button" className="dt-open"
                onClick={() => navigate({ page: 'projects', id: project.id })}>{project.name}</button>
              {!project.value.enabled && <Tag>{t('sourceOff')}</Tag>}
            </div>
            <div className="dt-row-meta">
              <span>{repoName(project.value.codeRepo)}</span>
              <span>{sourceName(project.value.taskSource)}</span>
              <span>{t('projectRunningCount', { count: running })}</span>
              <span>{t('projectQueuedCount', { count: queued })}</span>
            </div>
          </div>
        </li>
      })}</ul>)}
  </>
}

/** 单项目详情：项目配置摘要与该项目队列中的任务状态，并提供重试/取消/清空排队操作。 */
export function ProjectPage({ id }: { id: string }) {
  const { t, call, notify, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET projects/:id/tasks', { id }), [id], 3000)
  const retry = useAction((entryId: string) => call('POST queue/:id/retry', { id: entryId }))
  const cancel = useAction((entryId: string) => call('POST queue/:id/cancel', { id: entryId }))
  const clear = useAction(() => call('POST queue/clear', { query: { project: id } }))
  if (!data) return <><PageHead title={t('term.project')} />
    {error instanceof ApiError && error.missing ? <Hint>{t('projectNotFound')}</Hint> : <LoadState error={error} loading />}</>
  return <>
    <PageHead title={data.project.name} />
    <div className="dt-row-meta dt-status-line">
      <LabelValue label={t('projectCodeRepoLabel')} value={data.project.codeRepo.name} />
      <LabelValue label={t('projectTaskSourceLabel')} value={data.project.taskSource.name} />
      <LabelValue label={t('executingLabel')} value={`${data.used} / ${data.maxWorkers}`} />
      <LabelValue label={t('projectRunningLabel')} value={data.running} />
      <LabelValue label={t('queuedLabel')} value={data.queued} />
      <LabelValue label={t('projectNextPollLabel')} value={data.nextPollAt ? when(data.nextPollAt, t('lang')) : '—'} />
    </div>
    {data.lastError && <Hint>{t('projectLastError')}: {data.lastError}</Hint>}
    {data.deferred && <Hint>{t('projectDeferred')}: {data.deferred.reason}</Hint>}
    <Section title={t('projectTasksTitle')} hint={t('projectTasksHint')} count={data.items.length}
      action={data.queued > 0 ? <Button variant="outline" size="sm" disabled={clear.busy}
        onClick={() => { void clear.run().then(done => done && notify(t('queueCleared', { count: data.queued }))) }}>
        {t('queueClear')}</Button> : undefined}>
      {data.items.length === 0 ? <Hint>{t('projectNoTasks')}</Hint> : <table className="dt-table">
        <thead><tr>
          <th>{t('projectTaskColumn')}</th><th>{t('projectTitleColumn')}</th><th>{t('projectStateColumn')}</th>
          <th>{t('projectAttemptColumn')}</th><th>{t('projectNextColumn')}</th><th>{t('term.ticket')}</th>
          <th>{t('projectActionsColumn')}</th>
        </tr></thead>
        <tbody>{data.items.map(item => <tr key={item.id}>
          <td className="dt-mono">{item.task}{item.item > 0 ? `#${item.item + 1}` : ''}</td>
          <td>{item.title || item.task}</td>
          <td>{t(`queueState.${item.state}`)}{item.reason && <span className="dt-hint"> · {item.reason}</span>}</td>
          <td>{item.attempt}</td>
          <td>{item.state === 'queued' ? when(new Date(item.dueAt).toISOString(), t('lang')) : ''}</td>
          <td>{item.ticketId && <button type="button" className="dt-textlink dt-mono"
            onClick={() => navigate({ page: 'execution', id: item.ticketId! })}>{item.ticketId}</button>}</td>
          <td>{item.state === 'queued'
            ? <Button variant="ghost" size="sm" disabled={cancel.busy}
              onClick={() => { void cancel.run(item.id).then(done => done && notify(t('queueCancelled'))) }}>{t('queueCancel')}</Button>
            : item.state === 'starting' || item.state === 'running'
              ? <Button variant="ghost" size="sm" disabled={cancel.busy}
                onClick={() => { void cancel.run(item.id).then(done => done && notify(t('queueCancelled'))) }}>{t('queueStop')}</Button>
              : <Button variant="ghost" size="sm" disabled={retry.busy}
                onClick={() => { void retry.run(item.id).then(done => done && notify(t('queueRetried'))) }}>{t('queueRetry')}</Button>}</td>
        </tr>)}</tbody>
      </table>}
    </Section>
  </>
}

/** 项目设置分区：新建项目向导 + 已保存项目的编辑与删除。 */
export function ProjectSettings() {
  const { t } = usePanel()
  const { settings } = useSettings()
  return <>
    <ProjectWizard />
    <div className="dt-cards">
      {settings.projects.length === 0 ? <p className="dt-hint">{t('projectNone')}</p>
        : settings.projects.map(project => <ProjectCard key={project.id} project={project} />)}
    </div>
  </>
}

/** 向导步骤：与设置分组的创建流程一致，先基本信息，再仓库与任务来源，最后执行与调度。 */
const PROJECT_STEPS = ['basics', 'codeRepo', 'taskSource', 'execution'] as const
type ProjectStep = typeof PROJECT_STEPS[number]
/** 新建项目的默认执行参数；与 ProjectSchema 的默认值保持一致。 */
const PROJECT_DEFAULTS = {
  intervalMinutes: '30', maxRetries: '2', retryBackoffSeconds: '60',
  pendingStatuses: '待处理, todo, pending, open', doneStatus: '已完成', failedStatus: '失败',
}

/** 新建项目向导：四步填写完整参数，代码仓库与任务来源复用已保存的记录。 */
function ProjectWizard() {
  const { t, call, notify, navigate } = usePanel()
  const { settings, reload } = useSettings()
  const [step, setStep] = useState<ProjectStep>('basics')
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [codeRepo, setCodeRepo] = useState('')
  const [taskSource, setTaskSource] = useState('')
  const [credential, setCredential] = useState('')
  const [credentials, setCredentials] = useState<GitCredentialView[]>([])
  const [credentialError, setCredentialError] = useState<string>()
  const [directory, setDirectory] = useState('')
  const [branch, setBranch] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState(PROJECT_DEFAULTS.intervalMinutes)
  const [runOnStart, setRunOnStart] = useState(true)
  const [maxRetries, setMaxRetries] = useState(PROJECT_DEFAULTS.maxRetries)
  const [retryBackoffSeconds, setRetryBackoffSeconds] = useState(PROJECT_DEFAULTS.retryBackoffSeconds)
  const [pendingStatuses, setPendingStatuses] = useState(PROJECT_DEFAULTS.pendingStatuses)
  const [doneStatus, setDoneStatus] = useState(PROJECT_DEFAULTS.doneStatus)
  const [failedStatus, setFailedStatus] = useState(PROJECT_DEFAULTS.failedStatus)
  // 凭据列表不属于设置快照，进入向导时单独读取一次；失败时只在字段下提示。
  useEffect(() => { call('GET git-credentials').then(result => setCredentials(result.credentials),
    failure => setCredentialError(errorText(failure))) }, [call])
  const repos = settings.codeRepos.filter(repo => repo.enabled)
  const sources = settings.taskSources.filter(source => source.enabled)
  const repo = codeRepo || repos[0]?.id || ''
  const source = taskSource || sources[0]?.id || ''
  const interval = Number(intervalMinutes), retries = Number(maxRetries), backoff = Number(retryBackoffSeconds)
  const numbersValid = [interval, retries, backoff].every(value => Number.isInteger(value) && value >= 0)
  const policyValid = [pendingStatuses, doneStatus, failedStatus].every(value => value.trim() !== '')
  const ready = name.trim() !== '' && repo !== '' && source !== '' && numbersValid && policyValid
  const stepReady: Record<ProjectStep, boolean> = { basics: name.trim() !== '', codeRepo: repo !== '', taskSource: source !== '',
    execution: numbersValid && policyValid }
  const repoName = repos.find(item => item.id === repo)?.name ?? repo
  const sourceName = sources.find(item => item.id === source)?.name ?? source
  const position = PROJECT_STEPS.indexOf(step)
  const create = useAction(async () => {
    const { id } = await call('POST projects', { body: {
      name: name.trim(), enabled, codeRepo: repo, taskSource: source, gitCredential: credential,
      execution: { directory: directory.trim(), branch: branch.trim() },
      schedule: { intervalMinutes: interval, runOnStart },
      retry: { maxRetries: retries, retryBackoffSeconds: backoff },
      taskPolicy: { pendingStatuses: pendingStatuses.split(/[,，]/).map(status => status.trim()).filter(Boolean),
        doneStatus: doneStatus.trim(), failedStatus: failedStatus.trim() },
    } })
    notify(t('projectAdded', { id }))
    setName(''); setCodeRepo(''); setTaskSource(''); setCredential(''); setDirectory(''); setBranch('')
    setIntervalMinutes(PROJECT_DEFAULTS.intervalMinutes); setMaxRetries(PROJECT_DEFAULTS.maxRetries)
    setRetryBackoffSeconds(PROJECT_DEFAULTS.retryBackoffSeconds); setPendingStatuses(PROJECT_DEFAULTS.pendingStatuses)
    setDoneStatus(PROJECT_DEFAULTS.doneStatus); setFailedStatus(PROJECT_DEFAULTS.failedStatus)
    setStep('basics')
  }, { reload })
  return <div className="dt-source-add" role="group" aria-label={t('projectWizardTitle')}>
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-card-title">{t('projectWizardTitle')}</span></div>
      <p className="dt-hint">{t('projectWizardHint')}</p>
    </div>
    <SegmentedControl label={t('projectWizardSteps')} value={step}
      options={PROJECT_STEPS.map((value, index) => ({ value, label: t(`projectStep.${value}`, { number: index + 1 }) }))}
      onChange={setStep} />
    <div className="dt-form dt-block">
      {step === 'basics' && <>
        <Field label={t('sourceName')} hint={t('sourceNameHint')}>
          <Input required value={name} placeholder={t('projectNamePlaceholder')} onChange={event => setName(event.target.value)} />
        </Field>
        <Field label={t('projectEnabled')} hint={t('projectEnabledHint')}>
          <div><Switch checked={enabled} onChange={setEnabled} label={t('projectEnabled')} /></div>
        </Field>
      </>}
      {step === 'codeRepo' && (repos.length === 0
        ? <>
          <p className="dt-hint">{t('projectNeedsCodeRepo')}</p>
          <div className="dt-row-buttons">
            <Button variant="outline" onClick={() => navigate(settingsRoute('codeRepos'))}>{t('projectGoCodeRepos')}</Button>
          </div>
        </>
        : <>
          <Field label={t('projectCodeRepoLabel')} hint={t('projectCodeRepoPickHint')}>
            <select className="dt-select" value={repo} onChange={event => setCodeRepo(event.target.value)}>
              {repos.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
            </select>
          </Field>
          <Field label={t('projectGitCredentialLabel')} hint={t('projectGitCredentialHint')} note={credentialError}>
            <select className="dt-select" value={credential} onChange={event => setCredential(event.target.value)}>
              <option value="">{t('projectGitCredentialNone')}</option>
              {credentials.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
            </select>
          </Field>
        </>)}
      {step === 'taskSource' && (sources.length === 0
        ? <>
          <p className="dt-hint">{t('projectNeedsTaskSource')}</p>
          <div className="dt-row-buttons">
            <Button variant="outline" onClick={() => navigate(settingsRoute('taskSources'))}>{t('projectGoTaskSources')}</Button>
          </div>
        </>
        : <Field label={t('projectTaskSourceLabel')} hint={t('projectTaskSourcePickHint')}>
          <select className="dt-select" value={source} onChange={event => setTaskSource(event.target.value)}>
            {sources.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
          </select>
        </Field>)}
      {step === 'execution' && <>
        <Field label={t('projectDirectory')} hint={t('projectDirectoryHint')}>
          <Input className="dt-mono" value={directory} placeholder={t('executionDirectoryEmpty')}
            onChange={event => setDirectory(event.target.value)} />
        </Field>
        <Field label={t('projectBranch')} hint={t('projectBranchHint')}>
          <Input value={branch} placeholder={t('projectBranchEmpty')} onChange={event => setBranch(event.target.value)} />
        </Field>
        <Field label={t('projectInterval')} hint={t('projectIntervalHint')}>
          <Input type="number" required value={intervalMinutes} onChange={event => setIntervalMinutes(event.target.value)} />
        </Field>
        <Field label={t('projectRunOnStart')} hint={t('projectRunOnStartHint')}>
          <div><Switch checked={runOnStart} onChange={setRunOnStart} label={t('projectRunOnStart')} /></div>
        </Field>
        <Field label={t('projectMaxRetries')} hint={t('projectMaxRetriesHint')}>
          <Input type="number" required value={maxRetries} onChange={event => setMaxRetries(event.target.value)} />
        </Field>
        <Field label={t('projectBackoff')} hint={t('projectBackoffHint')}>
          <Input type="number" required value={retryBackoffSeconds} onChange={event => setRetryBackoffSeconds(event.target.value)} />
        </Field>
        <Field label={t('projectPendingStatuses')} hint={t('projectPendingStatusesHint')}>
          <Input required value={pendingStatuses} onChange={event => setPendingStatuses(event.target.value)} />
        </Field>
        <Field label={t('projectDoneStatus')} hint={t('projectDoneStatusHint')}>
          <Input required value={doneStatus} onChange={event => setDoneStatus(event.target.value)} />
        </Field>
        <Field label={t('projectFailedStatus')} hint={t('projectFailedStatusHint')}>
          <Input required value={failedStatus} onChange={event => setFailedStatus(event.target.value)} />
        </Field>
        <div className="dt-row-meta dt-status-line">
          <LabelValue label={t('projectWizardSummaryName')} value={name.trim() || t('unsetValue')} />
          <LabelValue label={t('projectCodeRepoLabel')} value={repoName || t('unsetValue')} />
          <LabelValue label={t('projectTaskSourceLabel')} value={sourceName || t('unsetValue')} />
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

function ProjectCard({ project }: { project: ProjectView }) {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const [open, setOpen] = useState(false)
  const repo = settings.codeRepos.find(item => item.id === project.value.codeRepo)?.name ?? project.value.codeRepo
  const source = settings.taskSources.find(item => item.id === project.value.taskSource)?.name ?? project.value.taskSource
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
    <p className="dt-hint">{t('projectCardSummary', { repo, source })}</p>
    {open && <ProjectForm project={project} />}
  </div>
}

function ProjectForm({ project }: { project: ProjectView }) {
  const { t } = usePanel()
  const saved = {
    name: project.value.name,
    enabled: project.value.enabled,
    execution: { directory: project.value.execution.directory, branch: project.value.execution.branch },
    schedule: { intervalMinutes: String(project.value.schedule.intervalMinutes), runOnStart: project.value.schedule.runOnStart },
    retry: { maxRetries: String(project.value.retry.maxRetries), retryBackoffSeconds: String(project.value.retry.retryBackoffSeconds) },
    taskPolicy: {
      pendingStatuses: project.value.taskPolicy.pendingStatuses.join(', '),
      doneStatus: project.value.taskPolicy.doneStatus,
      failedStatus: project.value.taskPolicy.failedStatus,
    },
  }
  const draft = useBlockDraft(`project:${project.id}`, saved, project.revision, value => ({
    ...project.value,
    name: value.name,
    enabled: value.enabled,
    execution: value.execution,
    schedule: { intervalMinutes: numberOf(value.schedule.intervalMinutes) ?? 0, runOnStart: value.schedule.runOnStart },
    retry: { maxRetries: numberOf(value.retry.maxRetries) ?? 0, retryBackoffSeconds: numberOf(value.retry.retryBackoffSeconds) ?? 0 },
    taskPolicy: {
      pendingStatuses: value.taskPolicy.pendingStatuses.split(/[,，]/).map(status => status.trim()).filter(Boolean),
      doneStatus: value.taskPolicy.doneStatus,
      failedStatus: value.taskPolicy.failedStatus,
    },
  }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-form dt-block">
        <Field label={t('sourceName')} hint={t('sourceNameHint')}>
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
