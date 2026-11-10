/** 来源记录的身份拼接：记录 ID 是来源身份，线程、触发器、KV 键与健康项都按它命名。 */
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
