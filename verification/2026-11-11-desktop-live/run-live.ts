/**
 * 桌面版 DeepSeek Harness 直连验证（2026-11-11）。
 *
 * 通过已加载插件的管理 HTTP 接口创建真实的代码仓库、Excel 任务来源与项目，
 * 让运行在桌面版里的真实调度器完成 git 同步、拆分、建单与真实 DSH 会话执行，
 * 最后核对队列、工单、回写后的 CSV 与执行工作区文件。
 *
 * 关键设计：
 * - 本机无法访问 github.com，也不能把本地磁盘路径写进 `remote`（部署解析只接受 https/http/ssh）。
 *   因此这里启动一个只读静态 HTTP 服务，用 git 的 dumb 协议托管一个本地裸库；
 *   记录使用 `auth: 'ssh'`（该模式不运行 gh，也不要求 GitHub 账号）。
 * - 提供服务的进程与 git 调用必须异步，否则同步子进程会阻塞事件循环导致服务不可达。
 *
 * 运行：`node --experimental-transform-types verification/2026-11-11-desktop-live/run-live.ts`
 * 前置：桌面版已加载 dsh-superagent 且 `stateDir/startup.json` 为 ready。
 */
import { execFile } from 'node:child_process'
import { chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const evidence = join(here, 'result.json')
/** 桌面版插件的状态目录；可用 `DSH_STATE_DIR` 覆盖。 */
const stateDir = process.env.DSH_STATE_DIR ?? join(homedir(), '.dsh', 'state', 'superagent')
const startupFile = join(stateDir, 'startup.json')
/** 临时裸库与种子仓库放在系统临时目录，不进入仓库。 */
const scratch = join(tmpdir(), 'dsh-desktop-live')
const repoId = 'live-ledger'
const sourceId = 'live-backlog'
const projectId = 'live-project'

/** 写入证据文件；每一步都落盘，失败时也保留已完成阶段。 */
function save(value: unknown): void {
  writeFileSync(evidence, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
/** 断言；失败立即抛出，避免带着错误状态继续下一步。 */
function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`)
}
/** 运行一次 git 并返回标准输出；失败时带上命令与 stderr。 */
async function git(args: string[], cwd?: string): Promise<string> {
  try {
    return (await exec('git', args, { cwd, encoding: 'utf8', timeout: 60_000 })).stdout
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    throw new Error(`git ${args.join(' ')} 失败：${stderr.trim() || String(error)}`)
  }
}
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const stamp = (): string => new Date().toISOString()

/**
 * 递归删除目录。Windows 上 git 对象默认只读，直接删除会 EPERM；
 * 先清掉只读位，再带重试删除，避免残留旧工作副本干扰下一次验证。
 */
function removeTree(dir: string): void {
  if (!existsSync(dir)) return
  const unlock = (target: string): void => {
    const info = lstatSync(target)
    if (info.isDirectory()) {
      for (const name of readdirSync(target)) unlock(join(target, name))
      chmodSync(target, 0o700)
    } else chmodSync(target, 0o600)
  }
  try { unlock(dir) } catch { /* 个别文件不可写时仍尝试删除其余内容。 */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

/** 读取桌面版插件写入的启动记录，取管理接口的监听端口。 */
function startup(): { port: number; phase: string; pid: number; at: string } {
  const text = readFileSync(startupFile, 'utf8')
  const parsed = JSON.parse(text) as { listen?: { port?: number }; phase?: string; pid?: number; at?: string }
  check(parsed.listen?.port, `startup.json 没有监听端口：${text}`)
  return { port: parsed.listen!.port!, phase: parsed.phase ?? '', pid: parsed.pid ?? 0, at: parsed.at ?? '' }
}

/** 管理接口调用；host 必须是实际监听地址，并携带同源请求头。 */
let port = startup().port
async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/${path}`, {
    method,
    headers: { 'x-orchestrator-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const value = text ? JSON.parse(text) as unknown : undefined
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`)
  return value as T
}
/** 健康探针；失败返回 undefined，供等待重启期间轮询。 */
async function health(): Promise<{ ok: boolean; stage: string; configured: boolean; problem: unknown } | undefined> {
  try {
    return await api('GET', 'health')
  } catch {
    return undefined
  }
}
/** 等待管理接口恢复健康；重启会换端口，因此每轮重新读取 startup.json。 */
async function waitReady(label: string, timeoutMs = 90_000): Promise<{ port: number; pid: number; at: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // 重启期间 startup.json 可能被替换，读取失败按未就绪处理并继续等待。
    let entry: { port: number; phase: string; pid: number; at: string }
    try { entry = startup() } catch { await sleep(1_000); continue }
    if (entry.port !== port) port = entry.port
    const probe = await health()
    if (probe?.ok) return { port: entry.port, pid: entry.pid, at: entry.at }
    await sleep(1_000)
  }
  throw new Error(`${label}：${timeoutMs / 1000}s 内管理接口未恢复 ready`)
}

/** 起一个只读静态服务，用 git dumb 协议托管临时裸库。 */
async function serveBare(bare: string): Promise<Server> {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/^\/+/, '')
    const file = normalize(join(bare, rel))
    const inside = file.startsWith(normalize(bare)) && existsSync(file) && statSync(file).isFile()
    if (!inside) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  return server
}

/** 读取 CSV 的字节特征，确认回写保留 BOM 与 CRLF。 */
function textFeatures(file: string): { bom: boolean; crlf: boolean; text: string } {
  const buffer = readFileSync(file)
  const text = buffer.toString('utf8')
  return { bom: buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf, crlf: /\r\n/.test(text), text }
}

/** 轮询队列快照，直到出现指定项目的条目或超时。 */
async function waitQueue(project: string, timeoutMs: number): Promise<{ snapshot: any; entry?: any }> {
  const deadline = Date.now() + timeoutMs
  let snapshot: any
  while (Date.now() < deadline) {
    snapshot = await api('GET', 'queue')
    const entry = (snapshot.items as any[]).find(item => item.project === project)
    if (entry) return { snapshot, entry }
    await sleep(2_000)
  }
  return { snapshot }
}

/** 主流程：准备本地远端 → 创建设置 → 等真实调度执行 → 收集证据。 */
async function main(): Promise<void> {
  const result: Record<string, unknown> = { startedAt: stamp(), stateDir, phases: [] as unknown[], server: null as unknown }
  const log = (phase: string, detail: unknown) => {
    (result.phases as unknown[]).push({ phase, at: stamp(), detail })
    save(result)
    console.log(`[${phase}]`, JSON.stringify(detail).slice(0, 400))
  }
  // 插件重挂载可能换进程与端口，并短暂经历状态目录锁等待；先等它稳定到 ready。
  const initialReady = await waitReady('启动前等待插件就绪', 90_000)
  result.startup = initialReady
  log('插件就绪', initialReady)
  const before = await health()
  log('初始健康探针', before)
  check(before?.ok, `插件未就绪：${JSON.stringify(before)}`)

  // 0. 清理上一次验证留下的记录与工作副本，保证可重复运行且从空设置开始。
  for (const [kind, id] of [['projects', projectId], ['task-sources', sourceId], ['code-repos', repoId]] as const) {
    try { await api('DELETE', `${kind}/${id}`) } catch { /* 不存在时忽略，首次运行即为此情形。 */ }
  }
  for (const dir of [join(stateDir, 'repos', repoId), join(stateDir, 'work', '桌面直连验证')]) removeTree(dir)
  const afterReset = await health()
  log('清理旧记录后可用的设置', { codeRepos: (afterReset as any)?.sources ?? [] })

  // 1. 临时裸库：BOM + CRLF 的任务清单，只有一个任务，避免拆出多个工作项。
  removeTree(scratch)
  const bare = join(scratch, 'live.git')
  const seed = join(scratch, 'seed')
  await git(['init', '--bare', '--initial-branch=main', bare])
  await git(['init', '--initial-branch=main', seed])
  // 关闭换行转换，确保远端确实保存 CRLF，回写保留 CRLF 才有可验证的意义。
  for (const [key, value] of [['user.name', 'DSH Live'], ['user.email', 'live@localhost'], ['core.autocrlf', 'false']]) {
    await git(['config', key, value], seed)
  }
  mkdirSync(join(seed, 'tasks'), { recursive: true })
  // 任务 ID 每次唯一：工单 ID 由触发器键派生，复用旧 ID 会命中上一次已结束的工单而不产生新执行。
  const taskId = `LIVE-${Date.now()}`
  const instruction = '这是桌面版直连验证任务：请直接调用 orchestrator_report 报告 state=ready、summary=desktop-live-ok，不要修改任何文件。'
  writeFileSync(join(seed, 'tasks', 'backlog.csv'),
    `\uFEFFtask_id,title,status,description,priority\r\n${taskId},${instruction},todo,,P1\r\n`, 'utf8')
  await git(['add', '.'], seed)
  await git(['commit', '--quiet', '-m', 'seed: 桌面直连验证任务'], seed)
  await git(['remote', 'add', 'origin', bare], seed)
  await git(['push', '--quiet', 'origin', 'main'], seed)
  await git(['update-server-info'], bare)
  const server = await serveBare(scratch)
  const remote = `http://127.0.0.1:${(server.address() as { port: number }).port}/live.git`
  result.server = { remote }
  log('启动本地 dumb HTTP git 服务', { remote })

  // 2. 代码仓库记录：先创建（config 为空），再用设置块写入 SSH 模式与自定义远端。
  const createdRepo = await api('POST', 'code-repos', { kind: 'github', id: repoId, name: '桌面验证仓库', config: {} })
  log('创建代码仓库记录', createdRepo)
  const savedRepo = await api('PUT', `settings/codeRepo:${repoId}`, {
    value: { name: '桌面验证仓库', enabled: true, config: { instanceUrl: '', repository: 'local/live', cli: '', auth: 'ssh', remote, sshKey: '' } },
    revision: (createdRepo as { revision: number }).revision,
  })
  log('写入仓库配置（触发插件重挂载）', savedRepo)
  const ready = await waitReady('仓库配置生效')
  result.restart = ready
  log('管理接口恢复 ready', ready)

  // 3. 任务来源与项目：两者都读取实时设置，不需要再次重启。
  const createdSource = await api('POST', 'task-sources', {
    kind: 'excel', id: sourceId, name: '桌面验证清单', config: { repo: repoId, file: 'tasks/backlog.csv' },
  })
  log('创建 Excel 任务来源', createdSource)
  const createdProject = await api('POST', 'projects', {
    id: projectId, name: '桌面直连验证', enabled: true, codeRepo: repoId, taskSource: sourceId,
    execution: { directory: '', branch: 'main' },
    schedule: { intervalMinutes: 30, runOnStart: true },
    retry: { maxRetries: 0, retryBackoffSeconds: 10 },
    taskPolicy: { pendingStatuses: ['todo'], doneStatus: 'done', failedStatus: 'blocked' },
  })
  log('创建项目', createdProject)

  // 4. 等真实调度轮询：TICK_MS 为 15 秒，同步、拆分与建单都在这一轮完成。
  const queued = await waitQueue(projectId, 90_000)
  check(queued.entry, `90s 内没有看到队列条目：${JSON.stringify(queued.snapshot)}`)
  result.queueAfterPoll = queued.snapshot
  log('调度轮询产生队列条目', queued.entry)

  // 5. 等真实 DSH 会话执行结束：工单进入终态或队列条目结算。
  const deadline = Date.now() + 8 * 60_000
  let entry = queued.entry
  let ticket: any
  while (Date.now() < deadline) {
    const snapshot = await api<any>('GET', 'queue')
    entry = (snapshot.items as any[]).find(item => item.id === (queued.entry as any).id) ?? entry
    if (entry?.ticketId) {
      const page = await api<any>('GET', `tickets/${entry.ticketId}`)
      // 工单详情路由直接返回工单对象；兼容可能存在的 `{ ticket }` 包装。
      ticket = page.ticket ?? page
      if (ticket?.ended) break
    }
    await sleep(3_000)
  }
  // 工单结束事件到队列结算有几毫秒延迟；等条目离开运行态后再取最终快照。
  for (let waited = 0; waited < 60_000 && ['running', 'starting'].includes(entry?.state ?? ''); waited += 1_000) {
    const snapshot = await api<any>('GET', 'queue')
    entry = (snapshot.items as any[]).find(item => item.id === (queued.entry as any).id) ?? entry
    if (!['running', 'starting'].includes(entry?.state ?? '')) break
    await sleep(1_000)
  }
  result.queueFinal = await api('GET', 'queue')
  result.ticket = ticket
  const ended = ticket?.ended?.outcome ?? ''
  log('真实执行结束', { queueState: entry?.state, outcome: ended, ticketId: entry?.ticketId })

  // 6. 回写后的工作副本：等副作用队列把 done 写回 CSV，再核对 BOM 与 CRLF。
  let csv: { bom: boolean; crlf: boolean; text: string } | undefined
  const csvFile = join(stateDir, 'repos', repoId, 'tasks', 'backlog.csv')
  for (let waited = 0; waited < 120_000; waited += 3_000) {
    if (existsSync(csvFile)) {
      const current = textFeatures(csvFile)
      // 任务标题里没有 ASCII 逗号，因此第三列就是状态列。
      if (new RegExp(`^${taskId},[^,]*,done`, 'm').test(current.text)) { csv = current; break }
    }
    await sleep(3_000)
  }
  result.writeback = csv ? { file: csvFile, bom: csv.bom, crlf: csv.crlf, text: csv.text } : { file: csvFile, missing: true }
  if (csv) log('回写结果', { bom: csv.bom, crlf: csv.crlf, line: csv.text.split(/\r?\n/)[1] })

  // 7. 执行工作区：工单目录真实存在，且真实会话确实在桌面版宿主里运行过。
  const workspaceRoot = join(stateDir, 'work')
  result.workspaces = existsSync(workspaceRoot)
    ? readdirSync(workspaceRoot, { recursive: true, withFileTypes: true }).slice(0, 40).map(item => join(item.parentPath ?? '', item.name))
    : []
  result.finishedAt = stamp()
  result.ok = ended === 'completed' && entry?.state === 'succeeded' && !!csv
  log('完成', { ok: result.ok })

  // 8. 停止继续轮询：远端服务即将关闭，避免调度器每分钟报连接失败。
  const settings = await api<any>('GET', 'settings')
  const project = (settings.projects as any[]).find(item => item.id === projectId)
  if (project) {
    await api('PUT', `settings/project:${projectId}`, { value: { ...project.value, enabled: false }, revision: project.revision })
    log('停用项目以停止轮询', { revision: project.revision })
  }
  server.close()
  save(result)
  check(result.ok, `端到端未通过：outcome=${ended} queue=${entry?.state} writeback=${!!csv}`)
  console.log('DESKTOP_LIVE_OK')
}

main().catch(error => {
  // 失败时也把错误写进证据，保留已完成阶段。
  try {
    const existing = existsSync(evidence) ? JSON.parse(readFileSync(evidence, 'utf8')) as Record<string, unknown> : {}
    save({ ...existing, error: String(error), failedAt: stamp() })
  } catch { /* 证据写入失败不掩盖原始错误。 */ }
  console.error('DESKTOP_LIVE_FAIL', error)
  process.exitCode = 1
})
