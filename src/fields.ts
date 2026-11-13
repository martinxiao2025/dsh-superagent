/** UI 表单字段规范的中性叶子：来源、代码仓库与任务来源三个域共享，不依赖任何其他模块。 */

export interface Localized { zh: string; en: string }
/** `advanced` 会把很少改动的字段（例如轮询可调参数）折叠到卡片的“高级”区域之后。 */
export interface FieldBase { key: string; label: Localized; hint?: Localized; advanced?: true }
/**
 * 配置字段规范；`rows` 编辑以第一列为键的记录列表，`choose` 从已解析的来源标签中选择，
 * `sources` 从已安装的来源记录中选择（按 `kinds` 过滤），`fact` 显示来自 `facts` 的只读值。
 */
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'select'; options: { value: string; label: Localized }[] }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; pattern?: string; readonly?: boolean; choose?: Localized }
  | FieldBase & { type: 'sources'; kinds: string[]; choose: Localized }
  | FieldBase & { type: 'fact' }
  | FieldBase & { type: 'rows'; columns: ({ key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean; choose?: Localized; refresh?: Localized } | { key: string; label: Localized; type: 'select'; options: { value: string; label: Localized }[] })[] }
