/**
 * 向导添加项目全流程实测（2026-11-11）。
 *
 * 通过真实插件的管理 HTTP 接口，按向导的顺序驱动完整链路：
 * 创建 Git 凭据 → 仓库连通性验证（携带凭据）→ 拉取远端分支 → 任务来源验证（真实读取清单）
 * → 创建项目（选定 `feature/desktop-live` 分支）→ 真实调度、DSH 会话执行 → 回写到选定分支。
 *
 * 关键设计与 desktop-live 一致：本机无法访问 github.com，用进程内只读静态服务以 git dumb
 * 协议托管本地裸库；凭据用 HTTPS + 令牌（服务端忽略 Authorization，只验证链路真实走通）。
 * 分支场景是本次新增的核心断言：远端有两个分支，项目选中 `feature/desktop-live`，
 * 工作副本与执行工作区都必须落在该分支上，回写也发生在该分支。
 *
 * 运行：`node --experimental-transform-types verification/2026-11-11-wizard/run-wizard.ts`
 * 前置：桌面版已加载 dsh-superagent 且 `stateDir/startup.json` 为 ready。
 */
import { execFile } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DirectConnect } from '../direct-connect.ts'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const evidence = join(here, 'result.json')
const stateDir = process.env.DSH_STATE_DIR ?? join(homedir(), '.dsh', 'state', 'superagent')
const scratch = join(tmpdir(), `dsh-wizard-${Date.now()}`)
const projectId = 'wizard-project'
const credentialId = 'wizard-credential'

const sleep = async (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const stamp = (): string => new Date().toISOString()
function save(value: unknown): void { writeFileSync(evidence, JSON.stringify(value, null, 2), 'utf8') }
function check(condition: unknown, message: string): void { if (!condition) throw new Error(message) }
function removeTree(dir: string): void { rmSync(dir, { recursive: true, force: true }) }

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return stdout
}

/** 直连桌面版管理接口：端口自动跟随重挂载。 */
const dc = new DirectConnect({ stateDir })

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

function textFeatures(file: string): { bom: boolean; crlf: boolean; text: string } {
  const buffer = readFileSync(file)
  return { bom: buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf, crlf: /\r\n/.test(buffer.toString('utf8')),
    text: buffer.toString('utf8') }
}

async function waitQueue(project: string, timeoutMs: number): Promise<{ snapshot: any; entry?: any }> {
  const deadline = Date.now() + timeoutMs
  let snapshot: any
  while (Date.now() < deadline) {
    snapshot = await dc.api('GET', 'queue')
    const entry = (snapshot.items as any[]).find(item => item.project === project)
    if (entry) return { snapshot, entry }
    await sleep(2_000)
  }
  return { snapshot }
}

async function main(): Promise<void> {
  const result: Record<string, unknown> = { startedAt: stamp(), stateDir, phases: [] as unknown[], server: null as unknown }
  const log = (phase: string, detail: unknown) => {
    (result.phases as unknown[]).push({ phase, at: stamp(), detail })
    save(result)
    console.log(`[${phase}]`, JSON.stringify(detail).slice(0, 300))
  }
  const initialReady = await dc.waitReady('启动前等待插件就绪')
  result.startup = initialReady
  log('插件就绪', initialReady)

  // 0. 清理上一次验证的项目与工作副本；仓库与任务来源已并入项目，一条 DELETE 即可。
  // 删除会改变部署材料并触发初始化重跑（换端口），先等 ready 再继续清理凭据。
  try { await dc.api('DELETE', `projects/${projectId}`) } catch { /* 不存在时忽略 */ }
  await dc.waitReady('清理旧项目后等待就绪')
  removeTree(join(stateDir, 'repos', `repo-${projectId}`))
  removeTree(join(stateDir, 'repos', 'repo-candidate'))
  removeTree(join(stateDir, 'work', '向导直连验证'))
  try { await dc.api('DELETE', `git-credentials/${credentialId}`) } catch { /* 不存在时忽略 */ }

  // 1. 临时裸库：main 与 feature/desktop-live 两个分支，各带一份 BOM + CRLF 的任务清单。
  removeTree(scratch)
  const bare = join(scratch, 'live.git')
  const seed = join(scratch, 'seed')
  await git(['init', '--bare', '--initial-branch=main', bare])
  await git(['init', '--initial-branch=main', seed])
  for (const [key, value] of [['user.name', 'DSH Wizard'], ['user.email', 'wizard@localhost'], ['core.autocrlf', 'false']]) {
    await git(['config', key, value], seed)
  }
  mkdirSync(join(seed, 'tasks'), { recursive: true })
  const taskId = `WIZ-${Date.now()}`
  const instruction = '这是向导全流程验证任务：请直接调用 orchestrator_report 报告 state=ready、summary=wizard-live-ok，不要修改任何文件。'
  writeFileSync(join(seed, 'tasks', 'backlog.csv'),
    `\uFEFFtask_id,title,status,description,priority\r\n${taskId},${instruction},todo,,P1\r\n`, 'utf8')
  await git(['add', '.'], seed)
  await git(['commit', '--quiet', '-m', 'seed: 向导验证任务'], seed)
  await git(['remote', 'add', 'origin', bare], seed)
  await git(['push', '--quiet', 'origin', 'main'], seed)
  // 第二个分支：内容一致，仅用于断言分支列表与「项目选定分支」生效。
  await git(['checkout', '--quiet', '-b', 'feature/desktop-live'], seed)
  await git(['commit', '--quiet', '--allow-empty', '-m', 'feature 分支锚点'], seed)
  await git(['push', '--quiet', 'origin', 'feature/desktop-live'], seed)
  await git(['checkout', '--quiet', 'main'], seed)
  await git(['update-server-info'], bare)
  const featureHead = (await git(['rev-parse', 'origin/feature/desktop-live'], seed)).trim()
  const server = await serveBare(scratch)
  const remote = `http://127.0.0.1:${(server.address() as { port: number }).port}/live.git`
  result.server = { remote, featureHead, taskId }
  log('启动本地 dumb HTTP git 服务（main + feature/desktop-live）', { remote })

  // 2. 向导第 0 步：创建 Git 凭据并对其验证（凭据页的真实探测，材料进加密存储）。
  const credential = await dc.api('POST', 'git-credentials', { id: credentialId,
    value: { name: '向导验证凭据', kind: 'https', provider: 'generic', username: 'wizard-bot', token: 'wizard-token' } })
  log('创建 Git 凭据', credential)
  const credentialChecks = await dc.api<{ checks: { field: string; ok: boolean; code: string }[] }>('POST', 'git-credentials/verify',
    { id: credentialId, repository: remote })
  result.credentialChecks = credentialChecks
  check(credentialChecks.checks.every(item => item.ok), `凭据验证未通过：${JSON.stringify(credentialChecks)}`)
  log('凭据验证（含仓库可达）通过', credentialChecks)

  // 3. 向导仓库步：项目表单只填仓库全地址（config.remote），站点与仓库路径由服务端从地址推导。
  const repoConfig = { remote, auth: 'https' }
  const repoChecks = await dc.api<{ checks: { field: string; ok: boolean; code: string }[] }>('POST', 'code-repos/verify',
    { kind: 'github', config: repoConfig, field: 'remote', gitCredential: credentialId })
  result.repoChecks = repoChecks
  check(repoChecks.checks.every(item => item.ok), `仓库连通性验证未通过：${JSON.stringify(repoChecks)}`)
  log('仓库连通性验证通过（携带凭据）', repoChecks)
  const branches = await dc.api<{ remote: string; branches: string[]; defaultBranch: string }>('POST', 'code-repos/branches',
    { kind: 'github', config: repoConfig, gitCredential: credentialId })
  result.branches = branches
  check(branches.branches.includes('main') && branches.branches.includes('feature/desktop-live'),
    `分支列表缺少预期分支：${JSON.stringify(branches)}`)
  check(branches.defaultBranch === 'main', `默认分支应为 main：${JSON.stringify(branches)}`)
  log('拉取远端分支', branches)

  // 4. 向导任务来源步：真实同步工作副本并读取清单。
  const sourceChecks = await dc.api<{ checks: { field: string; ok: boolean; code: string; values?: Record<string, string> }[] }>(
    'POST', 'task-sources/verify',
    { kind: 'excel', config: { file: 'tasks/backlog.csv' }, field: 'file',
      repo: { kind: 'github', config: repoConfig }, gitCredential: credentialId })
  result.sourceChecks = sourceChecks
  check(sourceChecks.checks.every(item => item.ok), `任务来源验证未通过：${JSON.stringify(sourceChecks)}`)
  log('任务来源验证通过（真实读取清单）', sourceChecks)

  // 5. 向导提交：创建项目，执行分支选定为 feature/desktop-live（保存会触发重挂载）。
  const created = await dc.api('POST', 'projects', {
    id: projectId, name: '向导直连验证', enabled: true,
    codeRepo: { kind: 'github', config: repoConfig },
    taskSource: { kind: 'excel', config: { file: 'tasks/backlog.csv' } },
    gitCredential: credentialId, feishuCredential: '',
    execution: { directory: '', branch: 'feature/desktop-live' },
    schedule: { intervalMinutes: 30, runOnStart: true },
    retry: { maxRetries: 0, retryBackoffSeconds: 10 },
    taskPolicy: { pendingStatuses: ['todo'], doneStatus: 'done', failedStatus: 'blocked' },
  })
  log('创建项目（分支 feature/desktop-live）', created)
  const ready = await dc.waitReady('项目配置生效')
  log('管理接口恢复 ready', ready)

  // 6. 等真实调度：同步应检出项目选定分支。
  const queued = await waitQueue(projectId, 90_000)
  check(queued.entry, `90s 内没有看到队列条目：${JSON.stringify(queued.snapshot)}`)
  result.queueAfterPoll = queued.snapshot
  log('调度轮询产生队列条目', queued.entry)
  const workCopy = join(stateDir, 'repos', `repo-${projectId}`)
  const workCopyBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workCopy)).trim()
  result.workCopyBranch = workCopyBranch
  log('工作副本所在分支', { branch: workCopyBranch })

  // 7. 等真实 DSH 会话执行结束。
  const deadline = Date.now() + 8 * 60_000
  let entry = queued.entry
  let ticket: any
  while (Date.now() < deadline) {
    const snapshot = await dc.api<any>('GET', 'queue')
    entry = (snapshot.items as any[]).find(item => item.id === (queued.entry as any).id) ?? entry
    if (entry?.ticketId) {
      const page = await dc.api<any>('GET', `tickets/${entry.ticketId}`)
      ticket = page.ticket ?? page
      if (ticket?.ended) break
    }
    await sleep(3_000)
  }
  for (let waited = 0; waited < 60_000 && ['running', 'starting'].includes(entry?.state ?? ''); waited += 1_000) {
    const snapshot = await dc.api<any>('GET', 'queue')
    entry = (snapshot.items as any[]).find(item => item.id === (queued.entry as any).id) ?? entry
    if (!['running', 'starting'].includes(entry?.state ?? '')) break
    await sleep(1_000)
  }
  result.queueFinal = await dc.api('GET', 'queue')
  result.ticket = ticket
  const ended = ticket?.ended?.outcome ?? ''
  log('真实执行结束', { queueState: entry?.state, outcome: ended, ticketId: entry?.ticketId })

  // 8. 执行工作区：per-ticket worktree，应检出项目选定分支指向的提交。
  const workspace = String(ticket?.directory ?? '')
  let workspaceRef = ''
  if (workspace && existsSync(workspace)) {
    workspaceRef = (await git(['rev-parse', 'HEAD'], workspace)).trim()
  }
  result.workspace = { path: workspace, head: workspaceRef, featureHead, refMatches: workspaceRef === featureHead }
  log('执行工作区 worktree', result.workspace)

  // 9. 回写：状态应写进选定分支上的清单，BOM 与 CRLF 保留。
  let csv: { bom: boolean; crlf: boolean; text: string } | undefined
  const csvFile = join(workCopy, 'tasks', 'backlog.csv')
  for (let waited = 0; waited < 120_000; waited += 3_000) {
    if (existsSync(csvFile)) {
      const current = textFeatures(csvFile)
      if (new RegExp(`^${taskId},[^,]*,done`, 'm').test(current.text)) { csv = current; break }
    }
    await sleep(3_000)
  }
  result.writeback = csv ? { file: csvFile, bom: csv.bom, crlf: csv.crlf, text: csv.text } : { file: csvFile, missing: true }
  if (csv) log('回写结果', { bom: csv.bom, crlf: csv.crlf, line: csv.text.split(/\r?\n/)[1] })

  result.finishedAt = stamp()
  result.ok = ended === 'completed' && entry?.state === 'succeeded' && !!csv
    && workCopyBranch === 'feature/desktop-live' && result.workspace.refMatches === true
  log('完成', { ok: result.ok })

  // 10. 停止继续轮询：远端服务即将关闭，避免调度器持续报连接失败。
  const settings = await dc.api<any>('GET', 'settings')
  const project = (settings.projects as any[]).find(item => item.id === projectId)
  if (project) {
    await dc.api('PUT', `settings/project:${projectId}`, { value: { ...project.value, enabled: false }, revision: project.revision })
    log('停用项目以停止轮询', { revision: project.revision })
  }
  server.close()
  save(result)
  check(result.ok, `端到端未通过：outcome=${ended} queue=${entry?.state} writeback=${!!csv} branch=${workCopyBranch}`)
  console.log('WIZARD_LIVE_OK')
}

main().catch(error => {
  try {
    const existing = existsSync(evidence) ? JSON.parse(readFileSync(evidence, 'utf8')) as Record<string, unknown> : {}
    save({ ...existing, error: String(error), failedAt: stamp() })
  } catch { /* 证据写入失败不掩盖原始错误。 */ }
  console.error('WIZARD_LIVE_FAIL', error)
  process.exitCode = 1
})
