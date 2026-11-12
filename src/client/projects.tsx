/** 项目页签与项目设置：项目自带代码仓库与任务来源，直接引用 Git 与飞书凭据。 */
import { useEffect, useState, type ReactElement } from 'react'
import type { FeishuCredentialView } from '../feishu-credentials/kind.ts'
import { repositoryOfRemote } from '../code-repos/kind.ts'
import type { GitCredentialView } from '../git-credentials/kind.ts'
import type { FieldSpec, Localized } from '../sources/kind.ts'
import type { SourceCheck } from '../setup.ts'
import { ApiError, usePoll, type SettingsView } from './api.ts'
import { Button, Input, SegmentedControl, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field, Fields, numberOf, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { errorText, localized, sourceCheckText, when, type T } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadState, PageHead, Section, StatusHead } from './widgets.tsx'

type ProjectView = SettingsView['projects'][number]
type CodeRepoKindView = SettingsView['codeRepoKinds'][number]
type TaskSourceKindView = SettingsView['taskSourceKinds'][number]
type RepoKind = 'github' | 'gitlab'
type RepoValue = { kind: RepoKind; config: Record<string, unknown> }
type SourceValue = { kind: string; config: Record<string, unknown> }

/** 仓库在列表中的短名：优先仓库路径，其次远端地址，最后退回类型名。 */
function repoSummary(value: ProjectView['value']): string {
  const text = value.codeRepo.config.repository ?? value.codeRepo.config.project ?? value.codeRepo.config.remote
  return typeof text === 'string' && text ? text : value.codeRepo.kind
}

/** 任务来源在列表中的短名：类型目录里有本地化标题时优先显示标题。 */
function sourceSummary(t: T, settings: SettingsView, value: ProjectView['value']): string {
  const kind = settings.taskSourceKinds.find(item => item.kind === value.taskSource.kind)
  return kind ? localized(t, kind.title) : value.taskSource.kind
}

/** 任务来源的主字段：连通性验证以它为准（Excel 读真实清单，飞书读真实空间或群）。 */
const SOURCE_PRIMARY: Record<string, string> = { excel: 'file', 'feishu-wiki': 'spaceId', 'feishu-im': 'chatId' }
const sourcePrimaryField = (kind: string): string => SOURCE_PRIMARY[kind] ?? 'file'

/** 从仓库地址识别站点：gitlab 站点返回 gitlab，github 站点返回 github，其余 undefined（由用户选择）。 */
function hostKind(remote: string): RepoKind | undefined {
  const info = repositoryOfRemote(remote.trim())
  if (!info) return undefined
  return info.host.includes('gitlab') ? 'gitlab' : info.host.includes('github') ? 'github' : undefined
}

/** 读取 Git 与飞书凭据；它们不属于设置快照，进入项目表单时单独读取一次。 */
function useCredentials() {
  const { call } = usePanel()
  const [git, setGit] = useState<GitCredentialView[]>([])
  const [feishu, setFeishu] = useState<FeishuCredentialView[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    Promise.all([call('GET git-credentials'), call('GET feishu-credentials')]).then(([gitList, feishuList]) => {
      setGit(gitList.credentials)
      setFeishu(feishuList.credentials)
    }, failure => setError(errorText(failure)))
  }, [call])
  return { git, feishu, error }
}

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

/** 代码仓库编辑：Git 凭据（认证方式随凭据）、仓库全地址与分支；站点与仓库路径由地址推导，不再单独填写。 */
function RepoEditor({ kinds, value, credential, credentials, checks, checking, credentialError, onChange, onCredential,
  onVerify }: {
  kinds: readonly CodeRepoKindView[]
  value: RepoValue
  credential: string
  credentials: readonly GitCredentialView[]
  checks: Record<string, SourceCheck>
  checking: Record<string, boolean>
  credentialError?: string | undefined
  onChange: (next: RepoValue) => void
  onCredential: (next: string) => void
  onVerify: (field: string) => void
}) {
  const { t } = usePanel()
  /** 绑定的凭据决定仓库类型（github/gitlab 凭据）与认证方式；generic 凭据或未绑定时由用户选择。 */
  const bound = credentials.find(item => item.id === credential)
  const kindLocked = bound !== undefined && bound.provider !== 'generic'
  /** 类型推导：绑定了 github/gitlab 凭据时随凭据；否则从仓库地址的站点识别；识别不出时由用户选择。 */
  const inferredKind: RepoKind | undefined = kindLocked
    ? bound!.provider as RepoKind
    : hostKind(String(value.config.remote ?? ''))
  /** 旧记录回填：没有全地址时按 owner/name 推导一个展示地址，用户不改动就不落回配置。 */
  const displayUrl = String(value.config.remote ?? '')
    || (typeof value.config.repository === 'string' && value.config.repository
      ? `https://github.com/${value.config.repository}.git`
      : typeof value.config.project === 'string' && value.config.project
        ? `https://gitlab.com/${value.config.project}.git` : '')
  /** 输入仓库全地址：推导仓库类型（凭据绑定时类型锁定）与认证方式，写进 config.remote；
   *  同时清掉旧的 owner/name 键，避免改地址后残留的 repository/project 覆盖从地址推导的路径。 */
  const setRemote = (next: string) => {
    const info = repositoryOfRemote(next)
    const kind: RepoKind = !info || kindLocked ? value.kind : info.host.includes('gitlab') ? 'gitlab' : 'github'
    const auth = bound?.kind ?? (next.trim().startsWith('git@') || next.trim().startsWith('ssh://') ? 'ssh' : 'https')
    const { repository: _repository, project: _project, ...rest } = value.config
    onChange({ kind, config: { ...rest, remote: next, auth } })
  }
  /** 选择凭据：github/gitlab 凭据直接决定仓库类型并重置配置，generic 凭据保留类型并记录认证方式。 */
  const chooseCredential = (next: string) => {
    onCredential(next)
    const target = credentials.find(item => item.id === next)
    if (!target) return
    const kind = target.provider === 'gitlab' ? 'gitlab' as const : target.provider === 'github' ? 'github' as const : ''
    if (!kind || kind === value.kind) onChange({ kind: value.kind, config: { ...value.config, auth: target.kind } })
    else onChange({ kind, config: { auth: target.kind } })
  }
  return <>
    <VerifyRow label={t('projectGitCredentialLabel')} busy={checking.gitCredential === true} check={checks.gitCredential}
      onVerify={() => onVerify('gitCredential')}>
      <Field label={t('projectGitCredentialLabel')} hint={t('projectGitCredentialHint')} note={credentialError}>
        <select className="dt-select" value={credential} onChange={event => chooseCredential(event.target.value)}>
          <option value="">{t('projectGitCredentialNone')}</option>
          {credentials.map(item => <option key={item.id} value={item.id}>
            {item.name} ({item.id} · {item.kind === 'ssh' ? 'SSH' : 'HTTPS'})</option>)}
        </select>
      </Field>
    </VerifyRow>
    {inferredKind
      ? <div className="dt-row-meta">
          <LabelValue label={t('projectRepoKind')}
            value={localized(t, kinds.find(item => item.kind === inferredKind)?.title ?? { zh: inferredKind, en: inferredKind })} />
          <span className="dt-hint">{t('projectRepoKindAutoHint')}</span>
        </div>
      : <Field label={t('projectRepoKind')} hint={t('projectRepoKindHint')}>
          <select className="dt-select" value={value.kind}
            onChange={event => onChange({ kind: event.target.value as RepoKind, config: {} })}>
            {kinds.map(item => <option key={item.kind} value={item.kind}>{localized(t, item.title)}</option>)}
          </select>
        </Field>}
    <VerifyRow label={t('projectRepoUrl')} busy={checking.remote === true} check={checks.remote} onVerify={() => onVerify('remote')}>
      <Field label={t('projectRepoUrl')} hint={t('projectRepoUrlHint')}>
        <Input className="dt-mono" value={displayUrl} placeholder={t('projectRepoUrlEmpty')}
          onChange={event => setRemote(event.target.value)} />
      </Field>
    </VerifyRow>
  </>
}

/** 任务来源编辑：先选来源类型，再显示该类型需要的凭据与字段；仓库位置由项目统一注入。 */
function SourceEditor({ kinds, value, credential, feishuCredentials, checks, checking, credentialError, onChange, onCredential,
  onVerify }: {
  kinds: readonly TaskSourceKindView[]
  value: SourceValue
  credential: string
  feishuCredentials: readonly FeishuCredentialView[]
  checks: Record<string, SourceCheck>
  checking: Record<string, boolean>
  credentialError?: string | undefined
  onChange: (next: SourceValue) => void
  onCredential: (next: string) => void
  onVerify: (field: string) => void
}) {
  const { t, call } = usePanel()
  const spec = kinds.find(item => item.kind === value.kind)
  const setConfig = (field: FieldSpec, next: unknown) => onChange({ ...value, config: { ...value.config, [field.key]: next } })
  /** 飞书群消息来源的群选择：从凭据的机器人已加入群中选取，也保留手动输入 oc_ ID 的回退。 */
  const [chats, setChats] = useState<{ id: string; name: string }[]>([])
  const fetchChats = useAction(async () => {
    const result = await call('POST feishu-im/chats', { body: { credential } })
    setChats(result.chats)
  })
  /** 切换类型时清空字段；不需要飞书凭据的类型同时解除凭据绑定，避免保存无用的引用。 */
  const chooseKind = (kind: string) => {
    onChange({ kind, config: {} })
    setChats([])
    if (!kinds.find(item => item.kind === kind)?.needsFeishuCredential) onCredential('')
  }
  return <>
    <Field label={t('projectSourceKind')} hint={t('projectSourceKindHint')}>
      <select className="dt-select" value={value.kind} onChange={event => chooseKind(event.target.value)}>
        {kinds.map(item => <option key={item.kind} value={item.kind}>{localized(t, item.title)}</option>)}
      </select>
    </Field>
    {spec?.needsFeishuCredential && <VerifyRow label={t('projectFeishuCredentialLabel')} busy={checking.feishuCredential === true}
      check={checks.feishuCredential} onVerify={() => onVerify('feishuCredential')}>
      <Field label={t('projectFeishuCredentialLabel')} hint={t('projectFeishuCredentialHint')} note={credentialError}>
        <select className="dt-select" value={credential} onChange={event => { onCredential(event.target.value); setChats([]) }}>
          <option value="">{t('projectFeishuCredentialNone')}</option>
          {feishuCredentials.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
        </select>
      </Field>
    </VerifyRow>}
    {value.kind === 'feishu-im' && <VerifyRow label={t('projectImChat')} busy={fetchChats.busy} check={checks.chatId}
      onVerify={() => onVerify('chatId')}>
      <Field label={t('projectImChat')} hint={t('projectImChatHint')}>
        <div className="dt-verify-row">
          {chats.length
            ? <select className="dt-select" aria-label={t('projectImChat')} value={String(value.config.chatId ?? '')}
              onChange={event => onChange({ ...value, config: { ...value.config, chatId: event.target.value } })}>
              <option value="">{t('projectImChatNone')}</option>
              {chats.map(chat => <option key={chat.id} value={chat.id}>{chat.name || chat.id}</option>)}
            </select>
            : <Input aria-label={t('projectImChat')} value={String(value.config.chatId ?? '')}
              placeholder={t('projectImChatEmpty')}
              onChange={event => onChange({ ...value, config: { ...value.config, chatId: event.target.value } })} />}
          <Button variant="outline" size="sm" disabled={fetchChats.busy} aria-busy={fetchChats.busy}
            onClick={() => { void fetchChats.run() }}>{fetchChats.busy ? t('verifyBusy') : t('projectImChatFetch')}</Button>
        </div>
      </Field>
    </VerifyRow>}
    {(spec?.fields ?? []).filter(field => !(value.kind === 'feishu-im' && field.key === 'chatId')).map(field =>
      <VerifyRow key={field.key} label={localized(t, field.label)}
        busy={checking[field.key] === true} check={checks[field.key]} onVerify={() => onVerify(field.key)}>
        <SourceField field={field} value={value.config[field.key]} saved={undefined} fact={undefined} labels={{}}
          onChange={next => setConfig(field, next)} />
      </VerifyRow>)}
  </>
}

/** 下载 016 标准工作簿模板；文件在浏览器侧生成，不经过状态目录。 */
function DownloadTemplateButton() {
  const { t, call, notify } = usePanel()
  const [busy, setBusy] = useState(false)
  /** 下载模板；失败时通过面板提示，不写入任何设置。 */
  const download = async () => {
    setBusy(true)
    try {
      const { filename, content } = await call('GET task-format/template')
      const bytes = Uint8Array.from(atob(content), char => char.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }
  return <Button variant="outline" disabled={busy} onClick={() => { void download() }}>{t('taskTemplateDownload')}</Button>
}

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

/** 项目设置分区：新建项目向导 + 已保存项目的编辑与删除；消息来源在飞书凭据的「消息接入」页配置。 */
export function ProjectSettings({ focus }: { focus?: string }) {
  const { t } = usePanel()
  const { settings } = useSettings()
  return <>
    <ProjectWizard />
    <div className="dt-cards">
      {settings.projects.length === 0 ? <p className="dt-hint">{t('projectNone')}</p>
        : settings.projects.map(project => <ProjectCard key={project.id} project={project} focus={focus === project.id} />)}
    </div>
  </>
}

/** 向导步骤：基本信息，代码仓库，任务来源，执行与调度。 */
const PROJECT_STEPS = ['basics', 'codeRepo', 'taskSource', 'execution'] as const
type ProjectStep = typeof PROJECT_STEPS[number]
/** 新建项目的默认执行参数；与 ProjectSchema 的默认值保持一致。 */
const PROJECT_DEFAULTS = {
  intervalMinutes: '30', maxRetries: '2', retryBackoffSeconds: '60',
  pendingStatuses: '待处理, todo, pending, open', doneStatus: '已完成', failedStatus: '失败',
}
/** 新建项目的仓库/来源默认值：仓库取目录第一项，任务来源优先 Excel；配置为空，保存时由服务端补默认值。 */
const emptyRepo = (kinds: readonly CodeRepoKindView[]): RepoValue => ({ kind: (kinds[0]?.kind ?? 'github') as RepoKind, config: {} })
const emptySource = (kinds: readonly TaskSourceKindView[]): SourceValue =>
  ({ kind: (kinds.find(item => item.kind === 'excel') ?? kinds[0])?.kind ?? 'excel', config: {} })

/** 新建项目向导：四步填写完整参数，仓库与任务来源随项目一起创建。 */
function ProjectWizard() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const { git, feishu, error: credentialError } = useCredentials()
  const [step, setStep] = useState<ProjectStep>('basics')
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [repo, setRepo] = useState<RepoValue>(() => emptyRepo(settings.codeRepoKinds))
  const [source, setSource] = useState<SourceValue>(() => emptySource(settings.taskSourceKinds))
  const [gitCredential, setGitCredential] = useState('')
  const [feishuCredential, setFeishuCredential] = useState('')
  const [repoChecks, setRepoChecks] = useState<Record<string, SourceCheck>>({})
  const [sourceChecks, setSourceChecks] = useState<Record<string, SourceCheck>>({})
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const [branches, setBranches] = useState<string[]>([])
  const [defaultBranch, setDefaultBranch] = useState('')
  const [directory, setDirectory] = useState('')
  const [branch, setBranch] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState(PROJECT_DEFAULTS.intervalMinutes)
  const [runOnStart, setRunOnStart] = useState(true)
  const [maxRetries, setMaxRetries] = useState(PROJECT_DEFAULTS.maxRetries)
  const [retryBackoffSeconds, setRetryBackoffSeconds] = useState(PROJECT_DEFAULTS.retryBackoffSeconds)
  const [pendingStatuses, setPendingStatuses] = useState(PROJECT_DEFAULTS.pendingStatuses)
  const [doneStatus, setDoneStatus] = useState(PROJECT_DEFAULTS.doneStatus)
  const [failedStatus, setFailedStatus] = useState(PROJECT_DEFAULTS.failedStatus)
  const interval = Number(intervalMinutes), retries = Number(maxRetries), backoff = Number(retryBackoffSeconds)
  const numbersValid = [interval, retries, backoff].every(value => Number.isInteger(value) && value >= 0)
  const policyValid = [pendingStatuses, doneStatus, failedStatus].every(value => value.trim() !== '')
  /** 仓库步就绪：全地址已填、连通性验证通过且已选分支；配置或凭据变更后必须重新验证。 */
  const repoConnected = repoChecks.remote?.ok === true
  const sourceVerified = sourceChecks[sourcePrimaryField(source.kind)]?.ok === true
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
    setBranch(current => current && result.branches.includes(current) ? current : result.defaultBranch || current)
  })
  /** 仓库或凭据变更：清空验证结果与分支，逼着用户对新配置重新验证，避免把旧结论带进下一步。
   *  仓库类型与认证方式随凭据的联动在 RepoEditor 内完成。 */
  const updateRepo = (next: RepoValue) => { setRepo(next); setRepoChecks({}); setBranches([]); setDefaultBranch(''); setBranch('') }
  const updateGitCredential = (next: string) => {
    setGitCredential(next); setRepoChecks({}); setBranches([]); setDefaultBranch(''); setBranch('')
  }
  /** 任务来源变更：同样清空该步的验证结果。 */
  const updateSource = (next: SourceValue) => { setSource(next); setSourceChecks({}) }
  /** 仓库字段预检：候选配置与 Git 凭据一起提交，不写入设置；地址字段验证通过后自动拉取分支。 */
  const verifyRepo = async (field: string) => {
    setChecking(current => ({ ...current, [field]: true }))
    try {
      const result = await call('POST code-repos/verify', { body: { kind: repo.kind, config: repo.config, field,
        gitCredential } })
      setRepoChecks(current => ({ ...current, ...Object.fromEntries(result.checks.map(check => [check.field, check])) }))
      if (result.checks.some(check => check.field === 'remote' && check.ok)) void fetchBranches.run()
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(current => ({ ...current, [field]: false })) }
  }
  /** 任务来源字段预检：连同项目的仓库候选与飞书凭据一起提交，驱动据此读取真实任务。 */
  const verifySource = async (field: string) => {
    setChecking(current => ({ ...current, [field]: true }))
    try {
      const result = await call('POST task-sources/verify', { body: { kind: source.kind, config: source.config, field,
        repo, gitCredential, feishuCredential } })
      setSourceChecks(current => ({ ...current, ...Object.fromEntries(result.checks.map(check => [check.field, check])) }))
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(current => ({ ...current, [field]: false })) }
  }
  const create = useAction(async () => {
    const { id } = await call('POST projects', { body: {
      name: name.trim(), enabled, codeRepo: repo, taskSource: source,
      gitCredential, feishuCredential,
      execution: { directory: directory.trim(), branch: branch.trim() },
      schedule: { intervalMinutes: interval, runOnStart },
      retry: { maxRetries: retries, retryBackoffSeconds: backoff },
      taskPolicy: { pendingStatuses: pendingStatuses.split(/[,，]/).map(status => status.trim()).filter(Boolean),
        doneStatus: doneStatus.trim(), failedStatus: failedStatus.trim() },
    } })
    notify(t('projectAdded', { id }))
    setName(''); setRepo(emptyRepo(settings.codeRepoKinds)); setSource(emptySource(settings.taskSourceKinds))
    setGitCredential(''); setFeishuCredential('')
    setRepoChecks({}); setSourceChecks({}); setBranches([]); setDefaultBranch(''); setDirectory(''); setBranch('')
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
    <SegmentedControl className="dt-wizard-steps" label={t('projectWizardSteps')} value={step}
      options={PROJECT_STEPS.map((value, index) => ({ value, label: t(`projectStep.${value}`, { number: index + 1 }) }))}
      onChange={setStep} />
    <div className="dt-form dt-block">
      {step === 'basics' && <>
        <Field label={t('projectName')} hint={t('projectNameHint')}>
          <Input required value={name} placeholder={t('projectNamePlaceholder')} onChange={event => setName(event.target.value)} />
        </Field>
        <Field label={t('projectEnabled')} hint={t('projectEnabledHint')}>
          <div><Switch checked={enabled} onChange={setEnabled} label={t('projectEnabled')} /></div>
        </Field>
      </>}
      {step === 'codeRepo' && <>
        <div className="dt-add-grid">
          <RepoEditor kinds={settings.codeRepoKinds} value={repo} credential={gitCredential} credentials={git}
            checks={repoChecks} checking={checking} credentialError={credentialError} onChange={updateRepo}
            onCredential={updateGitCredential} onVerify={field => { void verifyRepo(field) }} />
        </div>
        <Field label={t('projectBranch')} hint={t('projectBranchHint')}>
          <div className="dt-verify-row">
            {branches.length
              ? <select className="dt-select" aria-label={t('projectBranch')} value={branch}
                onChange={event => setBranch(event.target.value)}>
                {branches.map(item => <option key={item} value={item}>{item === defaultBranch
                  ? `${item} (${t('projectBranchDefault')})` : item}</option>)}
              </select>
              : <Input aria-label={t('projectBranch')} value={branch} placeholder={t('projectBranchEmpty')}
                onChange={event => setBranch(event.target.value)} />}
            <Button variant="outline" size="sm" disabled={fetchBranches.busy} aria-busy={fetchBranches.busy}
              onClick={() => { void fetchBranches.run() }}>{fetchBranches.busy ? t('verifyBusy') : t('projectBranchFetch')}</Button>
          </div>
        </Field>
      </>}
      {step === 'taskSource' && <>
        <div className="dt-add-grid">
          <SourceEditor kinds={settings.taskSourceKinds} value={source} credential={feishuCredential}
            feishuCredentials={feishu} checks={sourceChecks} checking={checking} credentialError={credentialError}
            onChange={updateSource} onCredential={setFeishuCredential} onVerify={field => { void verifySource(field) }} />
        </div>
        {source.kind === 'excel' && <div className="dt-row-buttons"><DownloadTemplateButton /></div>}
      </>}
      {step === 'execution' && <>
        <Field label={t('projectDirectory')} hint={t('projectDirectoryHint')}>
          <Input className="dt-mono" value={directory} placeholder={t('executionDirectoryEmpty')}
            onChange={event => setDirectory(event.target.value)} />
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
function ProjectCard({ project, focus }: { project: ProjectView; focus: boolean }) {
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

/** 项目编辑：仓库、任务来源、执行位置与调度策略在同一表单中保存。 */
function ProjectForm({ project }: { project: ProjectView }) {
  const { t, call, notify } = usePanel()
  const { settings } = useSettings()
  const { git, feishu, error: credentialError } = useCredentials()
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const saved = {
    name: project.value.name,
    enabled: project.value.enabled,
    codeRepo: project.value.codeRepo,
    taskSource: project.value.taskSource,
    gitCredential: project.value.gitCredential,
    feishuCredential: project.value.feishuCredential,
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
    name: value.name,
    enabled: value.enabled,
    codeRepo: value.codeRepo,
    taskSource: value.taskSource,
    gitCredential: value.gitCredential,
    feishuCredential: value.feishuCredential,
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
  /** 保存前的仓库预检：使用当前草稿的凭据引用，不写入设置。 */
  const verifyRepo = async (field: string) => {
    setChecking(current => ({ ...current, [field]: true }))
    try {
      const result = await call('POST code-repos/verify', { body: { kind: value.codeRepo.kind, config: value.codeRepo.config,
        field, gitCredential: value.gitCredential } })
      setChecks(current => ({ ...current, ...Object.fromEntries(result.checks.map(check => [check.field, check])) }))
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(current => ({ ...current, [field]: false })) }
  }
  /** 任务来源预检：用已保存的项目 ID 解析真实仓库，Excel 驱动因此能读到项目的工作副本。 */
  const verifySource = async (field: string) => {
    setChecking(current => ({ ...current, [field]: true }))
    try {
      const result = await call('POST task-sources/verify', { body: { kind: value.taskSource.kind, config: value.taskSource.config,
        field, projectId: project.id, repo: value.codeRepo, gitCredential: value.gitCredential,
        feishuCredential: value.feishuCredential } })
      setChecks(current => ({ ...current, ...Object.fromEntries(result.checks.map(check => [check.field, check])) }))
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(current => ({ ...current, [field]: false })) }
  }
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
      </div>
      <div className="dt-form dt-block">
        <div className="dt-subhead"><span className="dt-field-head">{t('projectCodeRepoLabel')}</span></div>
        <div className="dt-add-grid">
          <RepoEditor kinds={settings.codeRepoKinds} value={value.codeRepo} credential={value.gitCredential} credentials={git}
            checks={checks} checking={checking} credentialError={credentialError}
            onChange={codeRepo => edit({ codeRepo })} onCredential={gitCredential => edit({ gitCredential })}
            onVerify={field => { void verifyRepo(field) }} />
        </div>
      </div>
      <div className="dt-form dt-block">
        <div className="dt-subhead"><span className="dt-field-head">{t('projectTaskSourceLabel')}</span></div>
        <div className="dt-add-grid">
          <SourceEditor kinds={settings.taskSourceKinds} value={value.taskSource} credential={value.feishuCredential}
            feishuCredentials={feishu} checks={checks} checking={checking} credentialError={credentialError}
            onChange={taskSource => edit({ taskSource })} onCredential={feishuCredential => edit({ feishuCredential })}
            onVerify={field => { void verifySource(field) }} />
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
