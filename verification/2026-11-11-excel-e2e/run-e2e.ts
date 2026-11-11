/**
 * Excel/CSV 任务来源端到端验证（2026-11-11）。
 *
 * 使用真实 SQLite 状态库、真实 `ProjectScheduler`、真实 Excel 驱动、真实 git 同步与真实持久化副作用，
 * 只把「DSH 会话执行」替换成记录工单结束事件的内存执行器；桌面版真实执行在后续步骤单独验证。
 *
 * 覆盖：读取任务 → 拆分工作项 → 轮询/派工 → 状态回写（BOM/CRLF 保留）→ 失败退避重试 → 幂等重扫 → 工作项变化。
 * 直接运行：`node --experimental-transform-types verification/2026-11-11-excel-e2e/run-e2e.ts`
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../../src/app/store.ts'
import { Effects } from '../../src/app/effects.ts'
import { ProjectScheduler } from '../../src/app/scheduler.ts'
import { Commands } from '../../src/infra/commands.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { testDeployment, testGithub } from '../../tests/fixtures/deployment.ts'

const here = dirname(fileURLToPath(import.meta.url))
const evidenceFile = join(here, 'result.json')
// 临时仓库与状态库放在系统临时目录，避免工作副本嵌进本仓库后误改本仓库的远端。
const scratch = join(tmpdir(), 'dsh-excel-e2e')

/** 运行一次 git 并返回标准输出；失败时带上命令与 stderr。 */
function git(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    throw new Error(`git ${args.join(' ')} 失败：${stderr.trim() || String(error)}`)
  }
}

/** 断言并记录；失败立即抛出，避免带着错误状态继续。 */
function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`)
}

/** 可读的时间戳。 */
const stamp = (at: number): string => new Date(at).toISOString()

/** 把证据写入 `result.json`。 */
function save(result: unknown): void {
  writeFileSync(evidenceFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

/** 读取 CSV 的字节特征，确认回写保留了 BOM 与 CRLF。 */
function textFeatures(file: string): { bom: boolean; crlf: boolean; text: string } {
  const buffer = readFileSync(file)
  const text = buffer.toString('utf8')
  return { bom: buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf, crlf: /\r\n/.test(text), text }
}

/** 构造初始任务清单：A 成功、B 失败重试、C 两个工作项；BOM + CRLF。 */
const initialCsv = '\uFEFF' + [
  'task_id,title,status,description,priority',
  'A,发布准备,todo,,P1',
  'B,回归测试,todo,,P1',
  'C,文档更新,todo,"1. 改 012\r\n2. 改 013",P2',
].join('\r\n') + '\r\n'

/** 一轮完整的验证。 */
async function main(): Promise<void> {
  if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true })
  mkdirSync(join(scratch, 'state'), { recursive: true })
  const origin = join(scratch, 'origin.git')
  const originUrl = origin.replaceAll('\\', '/')
  const seed = join(scratch, 'seed')
  const stateDir = join(scratch, 'state')
  const workCopy = join(stateDir, 'repos', 'ledger')

  // 1. 真实 git 远端（裸库）与种子提交
  git(['init', '--bare', '--initial-branch=main', origin])
  git(['init', '--initial-branch=main', seed])
  for (const [key, value] of [['user.name', 'E2E'], ['user.email', 'e2e@localhost'], ['core.autocrlf', 'false']]) git(['config', key, value], seed)
  mkdirSync(join(seed, 'tasks'), { recursive: true })
  writeFileSync(join(seed, 'tasks', 'backlog.csv'), initialCsv, 'utf8')
  git(['add', '.'], seed)
  git(['commit', '--quiet', '-m', 'seed: 初始任务清单'], seed)
  git(['remote', 'add', 'origin', origin], seed)
  git(['push', '--quiet', '-u', 'origin', 'main'], seed)

  // 2. 真实状态库与设置
  const store = new Store(join(stateDir, 'orchestrator.sqlite'))
  const base = store.settings()
  const nowOf = () => clock
  let clock = Date.now()
  store.saveSettings(SettingsSchema.parse({
    ...base,
    codeRepos: { ledger: { kind: 'github', name: '本地仓库', enabled: true,
      config: { repository: 'local/excel-e2e', auth: 'https', remote: originUrl, instanceUrl: '', cli: '', sshKey: '', login: '', noreply: '' } } },
    taskSources: { backlog: { kind: 'excel', name: '任务清单', enabled: true, config: { repo: 'ledger', file: 'tasks/backlog.csv' } } },
    projects: { books: { name: '电子书', enabled: true, codeRepo: 'ledger', taskSource: 'backlog',
      execution: { directory: '', branch: 'main' }, schedule: { intervalMinutes: 30, runOnStart: true },
      retry: { maxRetries: 1, retryBackoffSeconds: 5 },
      taskPolicy: { pendingStatuses: ['todo'], doneStatus: 'done', failedStatus: 'blocked' } } },
    executor: { ...base.executor, maxWorkers: 1 },
  }))

  // 3. 真实副作用队列 + 真实调度器，执行器为记录工单的内存桩
  const deployment = testDeployment({ stateDir, sources: { ledger: testGithub({ id: 'ledger', repository: 'local/excel-e2e', auth: 'https', remote: originUrl }) } })
  const lifetime = new AbortController()
  const commands = new Commands(() => deployment, {}, lifetime.signal)
  const effects = new Effects(store, { claim: () => ({ set: () => {} }) } as never, nowOf)
  const running = new Map<string, string>()
  let ticketSeq = 0
  const engine = {
    schedule(input: { project: string }) {
      const ticketId = `ticket-${++ticketSeq}`
      const at = stamp(clock)
      store.tickets.save({ id: ticketId, project: input.project, created: at,
        assignments: [{ id: `${ticketId}-a1`, state: 'pending', at }], inputs: [] } as never)
      running.set(input.project, ticketId)
      return { ticketId }
    },
    stopTicket(ticketId: string) {
      for (const [project, id] of running) if (id === ticketId) running.delete(project)
    },
  }
  const scheduler = new ProjectScheduler({
    store, settings: () => store.settings(), engine: engine as never,
    executor: { slotsInUse: () => running.size, projectsInUse: () => [...running.keys()] },
    effects, commands, stateDir, lifetime: lifetime.signal, now: nowOf,
  })
  effects.handle('writeback', payload => scheduler.writeBackNow(payload), { retry: [5_000, 600_000] })
  effects.start()

  const phases: { phase: string; at: string; detail: unknown }[] = []
  const record = (phase: string, detail: unknown) => phases.push({ phase, at: stamp(clock), detail })

  /** 结束当前工单并触发结算（模拟 worker 会话结束回调）。 */
  const endTicket = (project: string, outcome: 'completed' | 'failed') => {
    const ticketId = running.get(project)
    check(ticketId, `${project} 没有运行中的工单`)
    const ticket = store.tickets.get(ticketId!)!
    store.tickets.save({ ...ticket, ended: { outcome, by: 'executor', at: stamp(clock) } })
    running.delete(project)
    scheduler.observe(ticketId!)
    return ticketId
  }
  const entries = () => store.queue.list()
  const byTask = (task: string) => entries().filter(entry => entry.task === task)

  // 4. 启动调度：runOnStart 的首轮周期检查完成真实同步、拆分与派工
  scheduler.start()
  for (let waited = 0; waited < 30_000 && running.size === 0; waited += 250) await new Promise(done => setTimeout(done, 250))
  scheduler.stop()
  check(running.get('books'), `启动后没有派工：${JSON.stringify(scheduler.snapshot().projects)}`)
  const afterStart = entries().map(entry => ({ id: entry.id, task: entry.task, item: entry.item, title: entry.title, state: entry.state }))
  check(afterStart.length === 4, `期望 4 个工作项，实际 ${afterStart.length}`)
  check(byTask('C').length === 2, '任务 C 应拆出 2 个工作项')
  check(existsSync(join(workCopy, 'tasks', 'backlog.csv')), '工作副本缺少清单文件')
  record('启动轮询：真实同步 + 拆分 + 派工', { entries: afterStart, workCopyHead: git(['rev-parse', 'HEAD'], workCopy).trim() })

  // 5. 执行中再次扫描：轮询被推迟，不并发拉取
  const beforeDefer = git(['rev-parse', 'HEAD'], workCopy).trim()
  await scheduler.scan()
  const deferred = scheduler.snapshot().projects.find(project => project.id === 'books')?.deferred
  check(deferred?.reason, '执行中轮询应被推迟并留下原因')
  check(git(['rev-parse', 'HEAD'], workCopy).trim() === beforeDefer, '推迟期间不应拉取')
  check(entries().length === 4, '推迟期间不应产生新条目')
  record('执行中扫描：轮询推迟', { deferred, gitHead: beforeDefer, entries: entries().length })

  // 6. A 成功：写回 done（保留 BOM/CRLF），并推送工作副本提交，保持本地远端线性
  const aTicket = endTicket('books', 'completed')
  await effects.idle('writeback')
  const csvAfterA = textFeatures(join(workCopy, 'tasks', 'backlog.csv'))
  check(csvAfterA.bom && csvAfterA.crlf, '回写后应保留 BOM 与 CRLF')
  check(/,done,/.test(csvAfterA.text) || /,done\r?$/.test(csvAfterA.text.split('\r\n')[1] ?? ''), 'A 的状态应回写为 done')
  git(['push', '--quiet', 'origin', 'main'], workCopy)
  record('A 成功：回写 done', { ticket: aTicket, csv: csvAfterA.text, workCopyLog: git(['log', '--oneline', '-2'], workCopy).trim() })

  // 7. B 第一次失败：退避重排，不写回失败状态
  await scheduler.scan()
  const bFirst = running.get('books')
  check(bFirst, 'B 应被派工')
  endTicket('books', 'failed')
  const bRetry = byTask('B')[0]!
  check(bRetry.state === 'queued' && bRetry.attempt === 1, `B 应退避重排为 attempt 1，实际 ${bRetry.state}/${bRetry.attempt}`)
  check(!/,blocked/.test(readFileSync(join(workCopy, 'tasks', 'backlog.csv'), 'utf8')), '退避中不应写回失败状态')
  record('B 首次失败：退避重排', { ticket: bFirst, entry: { state: bRetry.state, attempt: bRetry.attempt, dueAt: bRetry.dueAt, reason: bRetry.reason } })

  // 8. 退避到期后重试仍失败：达到 maxRetries，写回 blocked
  clock += 5_000
  await scheduler.scan()
  const bSecond = running.get('books')
  check(bSecond && bSecond !== bFirst, '退避到期后应创建新工单')
  endTicket('books', 'failed')
  await effects.idle('writeback')
  const bDone = byTask('B')[0]!
  check(bDone.state === 'failed' && bDone.attempt === 2, `B 应最终失败 attempt 2，实际 ${bDone.state}/${bDone.attempt}`)
  const csvAfterB = textFeatures(join(workCopy, 'tasks', 'backlog.csv'))
  check(/B,回归测试,blocked/.test(csvAfterB.text), 'B 的状态应回写为 blocked')
  git(['push', '--quiet', 'origin', 'main'], workCopy)
  record('B 重试耗尽：最终失败并回写 blocked', { ticket: bSecond, entry: { state: bDone.state, attempt: bDone.attempt, reason: bDone.reason }, csv: csvAfterB.text })

  // 9. C 的第一个工作项成功：整条任务写回 done，第二个工作项按任务消失取消
  await scheduler.scan()
  const cTicket = running.get('books')
  check(cTicket, 'C 应有工作项被派工')
  endTicket('books', 'completed')
  await effects.idle('writeback')
  const csvAfterC = textFeatures(join(workCopy, 'tasks', 'backlog.csv'))
  check(/C,文档更新,done/.test(csvAfterC.text), 'C 的状态应回写为 done')
  git(['push', '--quiet', 'origin', 'main'], workCopy)
  await scheduler.scan()
  const cEntries = byTask('C').map(entry => ({ state: entry.state, reason: entry.reason, item: entry.item }))
  check(cEntries.some(entry => entry.state === 'succeeded'), 'C 应有一个成功的子项')
  check(cEntries.some(entry => entry.state === 'cancelled'), 'C 的另一个子项应按任务消失取消')
  record('C 首个子项成功：整任务回写 done，次子项取消', { ticket: cTicket, entries: cEntries, csv: csvAfterC.text })

  // 10. 幂等：重复扫描不产生新条目
  const stable = JSON.stringify(entries().map(entry => ({ id: entry.id, state: entry.state, attempt: entry.attempt })))
  await scheduler.poll('books')
  await scheduler.poll('books')
  check(JSON.stringify(entries().map(entry => ({ id: entry.id, state: entry.state, attempt: entry.attempt }))) === stable, '重复轮询不应改变队列')
  record('幂等重扫：队列不变', { entries: entries().map(entry => ({ id: entry.id, task: entry.task, state: entry.state })) })

  // 11. 工作项变化：新增任务 D 入队；改写 D 的描述后旧条目取消、新条目入队
  git(['pull', '--quiet', '--ff-only'], seed)
  const dLine = 'D,附录更新,todo,"1. 补附录 A",P2'
  writeFileSync(join(seed, 'tasks', 'backlog.csv'), `${readFileSync(join(seed, 'tasks', 'backlog.csv'), 'utf8').trimEnd()}\r\n${dLine}\r\n`, 'utf8')
  git(['commit', '--quiet', '-am', 'feat: 新增任务 D'], seed)
  git(['push', '--quiet', 'origin', 'main'], seed)
  await scheduler.poll('books')
  const dFirst = byTask('D')
  check(dFirst.length === 1 && dFirst[0]!.state === 'queued', 'D 应入队一项')
  const dLineChanged = 'D,附录更新,todo,"1. 补附录 A\r\n2. 补附录 B",P2'
  const seedCsv = readFileSync(join(seed, 'tasks', 'backlog.csv'), 'utf8').replace(dLine, dLineChanged)
  writeFileSync(join(seed, 'tasks', 'backlog.csv'), seedCsv, 'utf8')
  git(['commit', '--quiet', '-am', 'feat: 补充任务 D 的工作项'], seed)
  git(['push', '--quiet', 'origin', 'main'], seed)
  await scheduler.poll('books')
  const dEntries = byTask('D').map(entry => ({ itemKey: entry.itemKey, state: entry.state, reason: entry.reason }))
  check(dEntries.some(entry => entry.state === 'cancelled' && /changed/.test(entry.reason ?? '')), '旧的工作项应按改写取消')
  check(dEntries.some(entry => entry.state === 'queued'), '改写后的工作项应重新入队')
  record('工作项变化：旧项取消、新项入队', { entries: dEntries })

  // 12. 汇总证据
  const summary = {
    generatedAt: new Date().toISOString(),
    scratch,
    stateDir,
    workCopy,
    origin,
    phases,
    final: {
      queue: entries().map(entry => ({ id: entry.id, project: entry.project, task: entry.task, item: entry.item, title: entry.title,
        state: entry.state, attempt: entry.attempt, reason: entry.reason, ticketId: entry.ticketId, contentHash: entry.contentHash })),
      tickets: store.tickets.list().map(ticket => ({ id: ticket.id, ended: ticket.ended })),
      csv: readFileSync(join(workCopy, 'tasks', 'backlog.csv'), 'utf8'),
      csvFeatures: textFeatures(join(workCopy, 'tasks', 'backlog.csv')),
      workCopyLog: git(['log', '--oneline'], workCopy).trim().split('\n'),
      effects: store.db.prepare('SELECT kind, key, attempts, error, due FROM effect ORDER BY seq').all().map(row => ({ ...row })),
      snapshot: scheduler.snapshot(),
    },
  }
  save(summary)
  lifetime.abort()
  console.log(`通过：${phases.length} 个阶段，证据写入 ${evidenceFile}`)
}

main().catch(error => {
  save({ failedAt: new Date().toISOString(), error: String(error instanceof Error ? error.stack ?? error.message : error) })
  console.error(error)
  process.exitCode = 1
})
