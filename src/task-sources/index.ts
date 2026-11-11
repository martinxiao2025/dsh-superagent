/** 任务来源驱动注册表：面板下拉、逐字段预检与运行时读取都从这里取得驱动。 */
import { LIMITS } from '../limits.ts'
import type { SourceCheck } from '../setup.ts'
import { excelTaskSource } from './excel.ts'
import { feishuImTaskSource } from './feishu-im.ts'
import { feishuWikiTaskSource } from './feishu-wiki.ts'
import {
  checkFailed, checkPassed,
  type TaskSourceDriver, type TaskSourceRecord, type TaskSourceVerifyDeps,
} from './kind.ts'

/** 内置驱动；新增来源只需在这里登记，面板下拉与预检自动出现。 */
export const TASK_SOURCE_DRIVERS: readonly TaskSourceDriver[] = [excelTaskSource, feishuImTaskSource, feishuWikiTaskSource]

/** 新增任务来源表单的候选配置。 */
export interface TaskSourceVerifyMeta {
  id?: string
  name?: string
  /** 记录 ID 是否已被占用；旧记录编辑时可返回 false。 */
  taken?(id: string): boolean
}

const checkName = (name: string): SourceCheck => {
  const value = name.trim()
  if (!value) return checkFailed('name', 'sourceNameRequired')
  if (value.length > LIMITS.sourceName) return checkFailed('name', 'sourceNameTooLong', { limit: String(LIMITS.sourceName) })
  if (/[\u0000-\u001f\u007f]/.test(value)) return checkFailed('name', 'sourceNameInvalid')
  return checkPassed('name', 'sourceNameOk', { name: value })
}
const checkId = (id: string, taken?: (id: string) => boolean): SourceCheck => {
  if (!id) return checkPassed('id', 'sourceIdAuto')
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return checkFailed('id', 'sourceIdInvalid', { id })
  if (taken?.(id)) return checkFailed('id', 'sourceIdTaken', { id })
  return checkPassed('id', 'sourceIdOk', { id })
}

/** 驱动注册表；测试可以传入额外驱动验证「注册即可接入」。 */
export class TaskSourceRegistry {
  constructor(readonly drivers: readonly TaskSourceDriver[] = TASK_SOURCE_DRIVERS) {}

  /** 面板下拉按标题排序；同名时按注册名稳定排序。 */
  kinds(): readonly TaskSourceDriver[] {
    return [...this.drivers].sort((left, right) => left.title.zh.localeCompare(right.title.zh) || left.kind.localeCompare(right.kind))
  }

  /** 按注册名取驱动；未知类型返回 undefined，由调用方决定报错还是返回预检失败。 */
  kind(name: string): TaskSourceDriver | undefined {
    return this.drivers.find(driver => driver.kind === name)
  }

  /**
   * 字段级预检：真实访问来源，但不写设置、不重启。
   * `field` 为 `all` 时先检查名称与登记信息，再按类型的非高级字段依次检查。
   */
  async verify(kind: string, config: unknown, field: string, meta: TaskSourceVerifyMeta,
    deps: TaskSourceVerifyDeps): Promise<SourceCheck[]> {
    const driver = this.kind(kind)
    if (!driver) return [checkFailed(field === 'all' ? 'kind' : field, 'sourceKindUnknown', { kind })]
    if (field === 'name') return [checkName(meta.name ?? '')]
    if (field === 'id') return [checkId(meta.id ?? '', meta.taken)]
    if (field === 'kind') return [checkPassed('kind', 'sourceKindOk', { kind })]
    const parsed = driver.schema.safeParse(config ?? {})
    const invalid = (): SourceCheck[] => [checkFailed(field === 'all' ? 'kind' : field, 'sourceConfigInvalid', {
      detail: parsed.success ? '' : parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') })]
    if (field !== 'all') {
      if (!parsed.success) return invalid()
      if (!driver.fields.some(item => item.key === field)) return [checkFailed(field, 'checkUnsupported', { field })]
      return driver.verify(parsed.data, field, deps)
    }
    // 名称必填优先于来源配置：名称缺失时不应先暴露配置格式问题。
    const checks: SourceCheck[] = [checkName(meta.name ?? '')]
    if (meta.id !== undefined) checks.push(checkId(meta.id, meta.taken))
    checks.push(checkPassed('kind', 'sourceKindOk', { kind }))
    if (!parsed.success) return [...checks, ...invalid()]
    for (const item of driver.fields.filter(entry => !entry.advanced)) {
      checks.push(...await driver.verify(parsed.data, item.key, deps))
    }
    return checks
  }
}

/** 默认注册表；宿主与测试共用。 */
export const taskSources = new TaskSourceRegistry()

/** 任务来源读取的代码仓库记录 ID；驱动未声明或配置无效时返回空串（表示不约束项目仓库）。 */
export function taskSourceRepo(record: TaskSourceRecord): string {
  const driver = taskSources.kind(record.kind)
  if (!driver?.repo) return ''
  const parsed = driver.schema.safeParse(record.config)
  return parsed.success ? driver.repo(parsed.data) : ''
}

/** 任务来源独占的知识库范围（飞书 `spaceId`）；驱动未声明或配置无效时返回空串。 */
export function taskSourceKnowledgeBase(record: TaskSourceRecord): string {
  const driver = taskSources.kind(record.kind)
  if (!driver?.knowledgeBase) return ''
  const parsed = driver.schema.safeParse(record.config)
  return parsed.success ? driver.knowledgeBase(parsed.data) : ''
}
