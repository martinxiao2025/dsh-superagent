/** 设置视图：组合带版本号的配置块、各来源表单与策略元数据，以及执行环境详情。 */
import { SETUP_FIELDS } from '../../deployment.ts'
import { KV } from '../../kv.ts'
import { policyVersion } from '../../policy.ts'
import { CODE_REPO_TYPES, codeRepoType } from '../../code-repos/types.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import { taskSources } from '../../task-sources/index.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import type { Store } from '../store.ts'
import { problemOf, sourceHealth, type HealthMap, type SetupState } from './sources.ts'

/** 代码仓库类型目录由 code-repos/types.ts 提供，面板与字段预检共用。 */
function policyOf(sources: SourceRegistry, id: string, health: HealthMap) {
  const policy = sources.kindOf(id)?.policy
  if (!policy) return {}
  const part = sources.policyPart(id)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {}, ...sync
    ? { sync } : {} } }
}
/** 主触发来源属于记录 `id` 的未结束工单数量；面板据此提示删除保护与停用后果。 */
function openTicketCount(store: Store, id: string): number {
  return store.tickets.open().filter(ticket => store.triggers.get(ticket.origin.triggerId)?.source === id).length
}
/**
 * 按配置块（`{ value, revision }`）构建设置视图，包含各来源配置与需重启才生效的字段，
 * 以及执行环境详情（`stateDir` 提供工单默认工作目录的根路径）。
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor', value: V) => ({ value, revision: store.blockRevision(name) })
  return {
    policyVersion: policyVersion(settings),
    // 已安装的来源类型目录；面板用它渲染「新增来源」的选项。
    kinds: sources.kindsList().map(kind => ({ kind: kind.kind, title: kind.title, description: kind.description, fields: kind.fields })),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor) },
    sources: sources.instances(settings).map(instance => {
      const kind = sources.kindByName(instance.kind)
      const problem = problemOf(instance.id, setup)
      const { id, title } = sourceHealth(sources, instance, health)
      return { id, kind: instance.kind, name: instance.name, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { name: instance.name, enabled: instance.enabled, config: instance.config }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: SETUP_FIELDS[instance.kind] ?? [], fields: kind?.fields ?? [], facts: kind?.facts?.(setup.deployment?.sources[instance.id]) ?? {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, openTickets: openTicketCount(store, instance.id),
        ...problem ? { problem } : {}, ...policyOf(sources, instance.id, health) }
    }),
    // 代码仓库、任务来源与项目各自维护记录与版本；代码仓库的类型目录与字段来自类型描述。
    codeRepoKinds: CODE_REPO_TYPES.map(kind => ({ kind: kind.kind, title: kind.title, description: kind.description, fields: kind.fields })),
    codeRepos: Object.entries(settings.codeRepos).map(([id, record]) => {
      const type = codeRepoType(record.kind)
      return { id, kind: record.kind, name: record.name, enabled: record.enabled,
        title: type?.title, fields: type?.fields ?? [],
        value: { name: record.name, enabled: record.enabled, config: record.config }, revision: store.blockRevision(`codeRepo:${id}`) }
    }),
    // 任务来源类型目录由驱动注册表生成：新增一个驱动后，面板下拉自动出现。
    taskSourceKinds: taskSources.kinds().map(kind => ({ kind: kind.kind, title: kind.title, description: kind.description, fields: kind.fields })),
    taskSources: Object.entries(settings.taskSources).map(([id, record]) => {
      const kind = taskSources.kind(record.kind)
      return { id, kind: record.kind, name: record.name, enabled: record.enabled,
        title: kind?.title, fields: kind?.fields ?? [],
        value: { name: record.name, enabled: record.enabled, config: record.config }, revision: store.blockRevision(`taskSource:${id}`) }
    }),
    projects: Object.entries(settings.projects).map(([id, project]) => ({ id, name: project.name, enabled: project.enabled,
      codeRepo: project.codeRepo, taskSource: project.taskSource, value: project, revision: store.blockRevision(`project:${id}`) })),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]
