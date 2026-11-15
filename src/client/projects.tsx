/** 项目页签：项目列表、单项目详情与项目设置分区的路由外壳；表单构件在 `project-editors.tsx` 与 `project-wizard.tsx`。 */
import { useState } from 'react'
import { ApiError, usePoll } from './api.ts'
import { Button, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { CredentialsProvider, repoSummary, sourceSummary } from './project-editors.tsx'
import { ProjectCard, ProjectWizard } from './project-wizard.tsx'
import { useSettings } from './settings-kit.tsx'
import { when } from './text.ts'
import { Hint, LabelValue, LoadState, PageHead, Section, StatusHead } from './widgets.tsx'

/** 项目列表：全局 worker 占用与排队数，以及每个项目的运行时摘要。 */
export function ProjectsPage() {
  const { t, call, navigate } = usePanel()
  const settings = usePoll(() => call('GET settings'), [])
  const queue = usePoll(() => call('GET queue'), [], 3000)
  const projects = settings.data?.projects ?? []
  const items = queue.data?.items ?? []
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
              <span>{repoSummary(project.value)}</span>
              <span>{sourceSummary(t, settings.data!, project.value)}</span>
              <span>{t('projectRunningCount', { count: running })}</span>
              <span>{t('projectQueuedCount', { count: queued })}</span>
            </div>
          </div>
        </li>
      })}</ul>)}
  </>
}

/** 项目任务表的每页条数；「加载更多」按它放大窗口，轮询始终读取当前窗口而不是追加历史状态。 */
const TASKS_PAGE = 50

/** 单项目详情：项目配置摘要与该项目队列中的任务状态，并提供重试/取消/清空排队操作。 */
export function ProjectPage({ id }: { id: string }) {
  const { t, call, notify, navigate } = usePanel()
  const [limit, setLimit] = useState(TASKS_PAGE)
  const { data, error } = usePoll(() => call('GET projects/:id/tasks', { id, query: { limit } }), [id, limit], 3000)
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
    <Section title={t('projectTasksTitle')} hint={t('projectTasksHint')} count={data.total ?? data.items.length}
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
      {data.more && <div className="dt-actions">
        <Button variant="outline" size="sm" onClick={() => setLimit(value => Math.min(value + TASKS_PAGE, 1000))}>{t('loadMore')}</Button>
      </div>}
    </Section>
  </>
}

/** 项目设置分区：新建项目向导 + 已保存项目的编辑与删除；消息来源在飞书凭据的「消息接入」页配置。 */
export function ProjectSettings({ focus }: { focus?: string }) {
  const { t } = usePanel()
  const { settings } = useSettings()
  return <CredentialsProvider>
    <ProjectWizard />
    <div className="dt-cards">
      {settings.projects.length === 0 ? <p className="dt-hint">{t('projectNone')}</p>
        : settings.projects.map(project => <ProjectCard key={project.id} project={project} focus={focus === project.id} />)}
    </div>
  </CredentialsProvider>
}
