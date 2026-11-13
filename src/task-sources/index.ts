/** 任务来源驱动注册表：面板下拉、逐字段预检与运行时读取都从这里取得驱动。 */
import { checkFailed, verifyFields, type SourceCheck } from '../setup.ts'
import { excelTaskSource } from './excel.ts'
import { feishuImTaskSource } from './feishu-im.ts'
import { feishuWikiTaskSource } from './feishu-wiki.ts'
import type { TaskSourceDriver, TaskSourceRecord, TaskSourceVerifyDeps } from './kind.ts'

/** 内置驱动；新增来源只需在这里登记，面板下拉与预检自动出现。 */
export const TASK_SOURCE_DRIVERS: readonly TaskSourceDriver[] = [excelTaskSource, feishuImTaskSource, feishuWikiTaskSource]

/** 新增任务来源表单的候选配置。 */
export interface TaskSourceVerifyMeta {
  id?: string
  name?: string
  /** 记录 ID 是否已被占用；旧记录编辑时可返回 false。 */
  taken?(id: string): boolean
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
    return verifyFields({
      kind, field, config,
      schema: driver?.schema,
      allFields: driver ? driver.fields.filter(entry => !entry.advanced).map(entry => entry.key) : [],
      // 未在驱动字段中声明的字段直接判不支持，不进入驱动预检。
      check: async (name, data) => driver!.fields.some(item => item.key === name)
        ? driver!.verify(data, name, deps)
        : [checkFailed(name, 'checkUnsupported', { field: name })],
      meta: { name: meta.name, id: meta.id, taken: meta.taken },
      // 名称、登记信息与类型通过结果先于配置检查出现，包括配置无效时。
      identityFirst: true,
    })
  }
}

/** 默认注册表；宿主与测试共用。 */
export const taskSources = new TaskSourceRegistry()

/** 任务来源独占的知识库范围（飞书 `spaceId`）；驱动未声明或配置无效时返回空串。 */
export function taskSourceKnowledgeBase(record: TaskSourceRecord): string {
  const driver = taskSources.kind(record.kind)
  if (!driver?.knowledgeBase) return ''
  const parsed = driver.schema.safeParse(record.config)
  return parsed.success ? driver.knowledgeBase(parsed.data) : ''
}
