/** 任务源端口与工厂：运行状态机只依赖本接口，新增任务源只需登记一个适配器。 */
import type { Commands } from '../infra/commands.ts'
import { taskColumns, type PipelineConfig } from './config.ts'
import { readTaskRows } from './excel.ts'
import { readFeishuTasks } from './feishu.ts'
import { normalizeTasks, type RawTask } from './tasks.ts'

/** 任务源端口：读取全部任务项，只做规范化，不拆分也不去重。 */
export interface TaskSourcePort {
  load(input: { signal: AbortSignal }): Promise<RawTask[]>
}

/** 按配置创建任务源；缺省或未支持的 `kind` 直接报错，避免静默返回空清单。 */
export function createTaskSource(config: PipelineConfig, commands: Commands): TaskSourcePort {
  if (config.taskKind === 'excel') {
    return {
      /** 读取本地清单文件并按列映射规范化。 */
      async load({ signal }) {
        signal.throwIfAborted()
        const rows = await readTaskRows(config.taskFile, config.taskSheet)
        signal.throwIfAborted()
        return normalizeTasks(rows, taskColumns(config))
      },
    }
  }
  if (config.taskKind === 'feishu') {
    return {
      /** 读取飞书知识库文档并按表头或复选框规范化。 */
      async load({ signal }) {
        signal.throwIfAborted()
        const tasks = await readFeishuTasks(commands, config, taskColumns(config))
        signal.throwIfAborted()
        return tasks
      },
    }
  }
  throw new Error(`不支持的任务源：${String(config.taskKind)}`)
}
