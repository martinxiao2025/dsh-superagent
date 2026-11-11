/** 设置标签页外壳，按创建流程在凭据、项目、阶段配置、提示词与部署之间路由。 */
import type { StateView } from './api.ts'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalSettings } from './eval.tsx'
import { ExecutionSettings } from './execution.tsx'
import { FeishuCredentialSettings } from './feishu-credentials.tsx'
import { GitCredentialSettings } from './git-credentials.tsx'
import { ProjectSettings } from './projects.tsx'
import { PromptsPage } from './prompts.tsx'
import { usePanel } from './provider.tsx'
import { SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts'
import { SettingsProvider } from './settings-kit.tsx'

const STAGE_GROUPS: readonly SettingsGroup[] = ['gitCredentials', 'feishuCredentials', 'projects', 'eval', 'execution']
/** 与主菜单同名但含义是配置的分组；导航上追加“配置”标记，避免与运行页混淆。 */
const CONFIG_GROUPS: readonly SettingsGroup[] = ['projects', 'eval', 'execution']
export function SettingsPage({ group, query, state, deploymentForm }: {
  group: SettingsGroup; query: { source?: string; version?: string }; state: StateView; deploymentForm: DeploymentForm
}) {
  const { t, navigate } = usePanel()
  const content = (() => {
    switch (group) {
      case 'gitCredentials': return <SettingsProvider><GitCredentialSettings /></SettingsProvider>
      case 'feishuCredentials': return <SettingsProvider><FeishuCredentialSettings /></SettingsProvider>
      case 'projects': return <SettingsProvider><ProjectSettings {...query.source ? { focus: query.source } : {}} /></SettingsProvider>
      case 'eval': return <SettingsProvider><EvalSettings version={query.version} /></SettingsProvider>
      case 'execution': return <SettingsProvider><ExecutionSettings /></SettingsProvider>
      case 'prompts': return <PromptsPage />
      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />
    }
  })()
  return <div className="dt-settings">
    <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
      {SETTINGS_GROUPS.map(value => <button key={value} type="button" className="dt-settings-link" data-stage={STAGE_GROUPS.includes(value)
        || undefined}
        aria-current={value === group ? 'page' : undefined} onClick={() => navigate(settingsRoute(value),
          true)}>{t(`settingsGroup.${value}`)}{CONFIG_GROUPS.includes(value)
          && <span className="dt-settings-tag">{t('settingsGroupTag')}</span>}</button>)}
    </nav>
    <div className="dt-settings-body">
      <h2 className="dt-settings-title">{t(`settingsGroup.${group}`)}</h2>
      {content}
    </div>
  </div>
}
