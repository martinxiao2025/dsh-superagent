/** 内置来源适配器清单：消息来源只保留飞书；代码仓库不产生触发器。 */
import { feishuAdapter } from './feishu.ts'
import type { SourceAdapter } from './kind.ts'

export const ADAPTERS: readonly SourceAdapter[] = [feishuAdapter]
