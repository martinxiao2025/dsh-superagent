/**
 * U8 演示工单注入脚本。
 *
 * 用途：向桌面版真实状态库（orchestrator.sqlite）写入若干「演示工单」，覆盖两个项目与未分配三种情况，
 * 让执行页的项目分组在没有真实 GitHub 触发的情况下也能渲染出真实数据。工单不启动工作单元，只用于 UI 取证。
 *
 * 用法：
 *   node inject-demo-tickets.mjs prepare   # 写入演示工单并创建各自的工单目录
 *   node inject-demo-tickets.mjs cleanup   # 删除全部演示工单与其目录
 *
 * 只操作 id 以 `demo-ui-` 开头的行与目录，不触碰真实工单。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DB = 'C:/Users/61054/.dsh/state/superagent/orchestrator.sqlite'
const ROOT = 'C:/Users/61054/.dsh/state/superagent/work'
const mode = process.argv[2] ?? 'prepare'

/** 返回 `minutes` 分钟前的 ISO 时间戳。 */
const at = (minutes = 0) => new Date(Date.now() - minutes * 60_000).toISOString()

/**
 * 构造一张演示工单：未结束、最近一次任务分配已结束（idle），因此启动后不会拉起工作单元。
 * `project` 为空表示尚未分配项目，UI 应把它放进“待分配”分组。
 */
function ticket(id, title, project, minutes) {
  const createdAt = at(minutes + 30)
  const updatedAt = at(minutes)
  const execution = project ? { name: `${project.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(-2)}`,
    project, directory: join(ROOT, project, id).replaceAll('/', '\\'), assignment: '演示工单：仅用于执行页分组取证，不启动工作单元。' } : undefined
  return { id, title, decisionId: `demo-decision-${id.slice(-2)}`,
    mandate: { strength: 'explicit', policyVersion: 'demo', basis: {}, actor: { source: 'feishu', id: 'ou_demo' }, scope: '执行页分组验证' },
    channels: [], assignments: [{ id: `${id}-a1`, state: 'ended', createdAt, endedAt: updatedAt }], inputs: [], undelivered: [],
    createdAt, updatedAt, origin: { triggerId: `demo-trigger-${id}`, triggerIds: [`demo-trigger-${id}`] },
    ...execution ? { execution } : {} }
}

const DEMO = [
  ticket('demo-ui-01', '修复登录页在深色模式下的对比度', 'Demo.ProjectOnline', 12),
  ticket('demo-ui-02', '补充订单导出的单元测试', 'Demo.ProjectOnline', 26),
  ticket('demo-ui-03', '把结算服务的重试逻辑收敛到一处', 'ledger-app', 40),
  ticket('demo-ui-04', '升级依赖并修复类型报错', 'ledger-app', 55),
  ticket('demo-ui-05', '整理 0.2 版本的发布说明', '', 70),
]

const db = new DatabaseSync(DB)
db.exec('PRAGMA busy_timeout = 5000')
if (mode === 'prepare') {
  const insert = db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value')
  for (const item of DEMO) {
    insert.run(item.id, JSON.stringify(item))
    if (item.execution) mkdirSync(item.execution.directory, { recursive: true })
  }
  console.log(JSON.stringify({ mode, inserted: DEMO.map(item => ({ id: item.id, project: item.execution?.project ?? '',
    directory: item.execution?.directory ?? '' })) }, null, 2))
} else {
  const remove = db.prepare("DELETE FROM ticket WHERE id LIKE 'demo-ui-%'")
  const result = remove.run()
  for (const item of DEMO) {
    if (item.execution && existsSync(item.execution.directory)) rmSync(item.execution.directory, { recursive: true, force: true })
  }
  // 顺带移除演示工单用空的项目目录；非空目录（真实工单产物）保留。
  for (const project of new Set(DEMO.map(item => item.execution?.project).filter(Boolean))) {
    const dir = join(ROOT, project)
    if (existsSync(dir)) { try { rmSync(dir, { recursive: false }) } catch {} }
  }
  console.log(JSON.stringify({ mode, deleted: Number(result.changes) }, null, 2))
}
db.close()
