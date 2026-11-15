/** 项目表单的共享构件（从 projects.tsx 拆出）：凭据上下文、代码仓库编辑器、任务来源编辑器与模板下载。 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { FeishuCredentialView } from '../feishu-credentials/kind.ts'
import { repositoryOfRemote } from '../code-repos/kind.ts'
import type { GitCredentialView } from '../git-credentials/kind.ts'
import type { FieldSpec } from '../fields.ts'
import type { SourceCheck } from '../setup.ts'
import type { SettingsView } from './api.ts'
import { VerifyRow } from './checks.tsx'
import { Button, Input } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field, SourceField } from './settings-kit.tsx'
import { errorText, localized, type T } from './text.ts'
import { LabelValue } from './widgets.tsx'

export type ProjectView = SettingsView['projects'][number]
export type CodeRepoKindView = SettingsView['codeRepoKinds'][number]
export type TaskSourceKindView = SettingsView['taskSourceKinds'][number]
export type RepoKind = 'github' | 'gitlab'
export type RepoValue = { kind: RepoKind; config: Record<string, unknown> }
export type SourceValue = { kind: string; config: Record<string, unknown> }

/** 仓库在列表中的短名：优先仓库路径，其次远端地址，最后退回类型名。 */
export function repoSummary(value: ProjectView['value']): string {
  const text = value.codeRepo.config.repository ?? value.codeRepo.config.project ?? value.codeRepo.config.remote
  return typeof text === 'string' && text ? text : value.codeRepo.kind
}

/** 任务来源在列表中的短名：类型目录里有本地化标题时优先显示标题。 */
export function sourceSummary(t: T, settings: SettingsView, value: ProjectView['value']): string {
  const kind = settings.taskSourceKinds.find(item => item.kind === value.taskSource.kind)
  return kind ? localized(t, kind.title) : value.taskSource.kind
}

/** 任务来源的主字段：连通性验证以它为准（Excel 读真实清单，飞书读真实空间或群）。 */
const SOURCE_PRIMARY: Record<string, string> = { excel: 'file', 'feishu-wiki': 'spaceId', 'feishu-im': 'chatId' }
export const sourcePrimaryField = (kind: string): string => SOURCE_PRIMARY[kind] ?? 'file'

/** 从仓库地址识别站点：gitlab 站点返回 gitlab，github 站点返回 github，其余 undefined（由用户选择）。 */
export function hostKind(remote: string): RepoKind | undefined {
  const info = repositoryOfRemote(remote.trim())
  if (!info) return undefined
  return info.host.includes('gitlab') ? 'gitlab' : info.host.includes('github') ? 'github' : undefined
}

/** Git 与飞书凭据的共享上下文：项目设置区只读取一次，向导与每张已展开的项目卡片复用，不再逐卡片重复请求。 */
interface Credentials { git: GitCredentialView[]; feishu: FeishuCredentialView[]; error?: string }
const CredentialsContext = createContext<Credentials | undefined>(undefined)
/** 读取项目设置区共享的凭据列表。 */
export function useCredentials(): Credentials {
  const value = useContext(CredentialsContext)
  if (!value) throw new Error('project settings rendered outside their credentials provider')
  return value
}
/** 拉取一次 Git 与飞书凭据；它们不属于设置快照，进入项目表单时由整个设置区共享这一份。 */
export function CredentialsProvider({ children }: { children: ReactNode }) {
  const { call } = usePanel()
  const [git, setGit] = useState<GitCredentialView[]>([])
  const [feishu, setFeishu] = useState<FeishuCredentialView[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    Promise.all([call('GET git-credentials'), call('GET feishu-credentials')]).then(([gitList, feishuList]) => {
      setGit(gitList.credentials); setFeishu(feishuList.credentials)
    }, failure => setError(errorText(failure)))
  }, [call])
  const value = useMemo(() => ({ git, feishu, error }), [git, feishu, error])
  return <CredentialsContext.Provider value={value}>{children}</CredentialsContext.Provider>
}

/** 代码仓库编辑：Git 凭据（认证方式随凭据）、仓库全地址与分支；站点与仓库路径由地址推导，不再单独填写。 */
export function RepoEditor({ kinds, value, credential, credentials, checks, checking, credentialError, onChange, onCredential,
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
export function SourceEditor({ kinds, value, credential, feishuCredentials, checks, checking, credentialError, onChange, onCredential,
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
export function DownloadTemplateButton() {
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
