/** 来源记录的身份拼接：记录 ID 是来源身份，线程、触发器、KV 键、健康项与环境变量都按它命名。 */
import { key } from '../core/index.ts'

/** 线程键：`<记录ID>:<记录内后缀>`，例如 `github-main:123`。 */
export const threadKey = (record: string, local: string): string => `${record}:${local}`

/** 触发器 ID：`<记录ID>-<本地种类>` 加上稳定的序号或摘要。 */
export const triggerKey = (record: string, local: string, ...parts: string[]): string => key(`${record}-${local}`, ...parts)

/** 来源作用域的 KV 键：`<族名>:<记录ID>[:<其余部分>]`。 */
export const kvKey = (family: string, record: string, ...parts: (string | number)[]): string =>
  [family, record, ...parts.map(String)].join(':')

/**
 * 健康项名称，与种类声明的条目一一对应：第一项就是记录 ID，其余是 `<记录ID>:<条目名>`。
 * 这样面板按记录展示状态，同类型的多条记录互不覆盖。
 */
export const healthNames = (record: string, declared: readonly string[]): string[] =>
  declared.map((_, index) => index === 0 ? record : `${record}:${declared[index]}`)

/** 执行环境变量名：`DSH_SUPERAGENT_SOURCE_<记录ID>_<字段>`，连字符换成下划线。 */
export const envKey = (record: string, field: string): string =>
  `DSH_SUPERAGENT_SOURCE_${record.toUpperCase().replace(/-/g, '_')}_${field}`

/** 记录 ID 对应的环境变量前缀，供需要成组写入变量的调用方使用。 */
export const envPrefix = (record: string): string => `DSH_SUPERAGENT_SOURCE_${record.toUpperCase().replace(/-/g, '_')}`
