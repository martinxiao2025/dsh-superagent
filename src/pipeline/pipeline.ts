/**
 * `pipeline` 来源种类：把代码源、任务源与定时表登记为一条可启停的记录。
 * 记录本身不接收外部事件，只在自己的循环里按时间表运行。
 */
import type { PipelineConfig } from './config.ts'
import { PipelineConfigSchema } from './config.ts'
import type { SourceAdapter, SourceKind } from '../sources/kind.ts'
import { watchPipeline, type PipelineHost } from './runner.ts'

const label = (zh: string, en: string): { zh: string; en: string } => ({ zh, en })

/** 流水线记录的种类描述符：配置字段、健康条目与监听范围。 */
export const pipelineKind: SourceKind<PipelineConfig> = {
  kind: 'pipeline',
  title: label('任务流水线', 'Task pipeline'),
  description: label('按配置定时同步代码与任务清单，把待办拆成工单执行并回写结果。',
    'Fetch code and a task list on a schedule, turn items into tickets, and write results back.'),
  schema: PipelineConfigSchema,
  health: ['pipeline', 'code', 'tasks'],
  scope: ({ }, config) => {
    const ready = !!config.codeSource && (config.taskKind === 'excel' ? !!config.taskFile : !!config.wikiUrl && !!config.feishuSource)
    return ready ? { listened: true, observed: false } : { listened: false, reason: '流水线尚未配置代码源或任务源' }
  },
  fields: [
    { key: 'codeSource', type: 'text', label: label('代码来源记录', 'Code source record'), hint: label('填写 GitHub 或 GitLab 来源记录的 ID', 'ID of a GitHub or GitLab source record') },
    { key: 'remoteUrl', type: 'text', label: label('远端地址', 'Remote URL'), hint: label('留空按来源记录生成；可填 SSH 地址（git@host:owner/repo.git），不要内嵌账号密码', 'Empty derives from the record; SSH like git@host:owner/repo.git is allowed, never embed credentials'), advanced: true },
    { key: 'branch', type: 'text', label: label('分支', 'Branch'), hint: label('留空使用仓库默认分支', 'Empty uses the default branch') },
    { key: 'taskKind', type: 'select', label: label('任务源类型', 'Task source'), options: [
      { value: 'excel', label: label('本地 Excel / CSV', 'Local Excel / CSV') },
      { value: 'feishu', label: label('飞书知识库', 'Feishu wiki') },
    ] },
    { key: 'taskFile', type: 'text', label: label('任务清单文件', 'Task list file'), hint: label('绝对路径，支持 .xlsx、.csv、.tsv', 'Absolute path; .xlsx, .csv, .tsv') },
    { key: 'wikiUrl', type: 'text', label: label('知识库地址', 'Wiki URL'), hint: label('知识库节点或文档链接', 'Wiki node or document link') },
    { key: 'feishuSource', type: 'text', label: label('飞书来源记录', 'Feishu source record'), hint: label('读取知识库所使用的飞书来源记录 ID', 'Feishu record ID used to read the wiki'), advanced: true },
    { key: 'intervalMinutes', type: 'number', min: 1, max: 1440, label: label('运行间隔（分钟）', 'Interval (minutes)') },
    { key: 'runOnStart', type: 'switch', label: label('启动后立即运行', 'Run on start') },
    { key: 'taskSheet', type: 'text', label: label('工作表', 'Sheet'), hint: label('留空取第一张表', 'Empty uses the first sheet'), advanced: true },
    { key: 'directory', type: 'text', label: label('代码目录', 'Code directory'), hint: label('留空使用应用状态目录', 'Empty uses the app state directory'), advanced: true },
    { key: 'columnId', type: 'text', label: label('编号列', 'ID column'), advanced: true },
    { key: 'columnTitle', type: 'text', label: label('标题列', 'Title column'), advanced: true },
    { key: 'columnDescription', type: 'text', label: label('描述列', 'Description column'), advanced: true },
    { key: 'columnStatus', type: 'text', label: label('状态列', 'Status column'), advanced: true },
    { key: 'columnPriority', type: 'text', label: label('优先级列', 'Priority column'), advanced: true },
    { key: 'pendingStatuses', type: 'text', label: label('待办状态', 'Pending statuses'), hint: label('逗号分隔；状态为空也视为待办', 'Comma separated; empty status also counts'), advanced: true },
    { key: 'concurrency', type: 'number', min: 1, max: 8, label: label('并发工单数', 'Concurrent tickets'), advanced: true },
    { key: 'maxRetries', type: 'number', min: 0, max: 10, label: label('失败重试次数', 'Retries'), advanced: true },
    { key: 'retryBackoffSeconds', type: 'number', min: 0, max: 3600, label: label('重试退避（秒）', 'Retry backoff (s)'), advanced: true },
    { key: 'doneStatus', type: 'text', label: label('完成状态', 'Done status'), advanced: true },
    { key: 'failedStatus', type: 'text', label: label('失败状态', 'Failed status'), advanced: true },
  ],
}

/** 流水线适配器：把来源上下文组装为运行器能力，然后进入按时间表的循环。 */
export const pipelineAdapter: SourceAdapter<PipelineConfig> = {
  kind: pipelineKind,
  async watch(host, id, signal) {
    const context = host.context(pipelineKind, id)
    await context.ready
    const runnerHost: PipelineHost = {
      recordId: id,
      stateDir: context.stateDir,
      commands: context.commands,
      schedule: input => context.schedule(input),
      tickets: { get: ticketId => context.tickets.get(ticketId) },
      state: context.state,
      config: () => context.config<PipelineConfig>(),
      codeKinds: () => Object.fromEntries(Object.entries(context.deployment.sources).map(([key, source]) => [key, source.kind])),
      report: (entry, health) => context.report(entry, health),
    }
    await watchPipeline(runnerHost, signal)
  },
}
