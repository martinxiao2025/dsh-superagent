/** 内置来源适配器清单：新增类型只需实现 `SourceAdapter` 并在此登记，核心流程不变。 */
import { pipelineAdapter } from '../pipeline/pipeline.ts'
import { feishuAdapter } from './feishu.ts'
import { githubAdapter } from './github.ts'
import { gitlabAdapter } from './gitlab.ts'
import type { SourceAdapter } from './kind.ts'

/** 擦除具体配置类型，使不同种类的适配器可以放在同一个列表里。 */
const erased = <C extends Record<string, unknown>>(adapter: SourceAdapter<C>): SourceAdapter => adapter as unknown as SourceAdapter

export const ADAPTERS: readonly SourceAdapter[] = [githubAdapter, gitlabAdapter, erased(feishuAdapter), erased(pipelineAdapter)]
