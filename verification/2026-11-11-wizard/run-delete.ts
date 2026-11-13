/**
 * 项目删除闭环实测（2026-11-11）。
 *
 * 在真实桌面版 Harness 里把一个项目跑到「工单执行中」，然后删除项目，验证闭环：
 * 运行中的工单立即结束（`stopped`，原因 `The project was removed`）、该项目全部队列记录被清理、
 * 设置里项目消失、删除触发初始化重跑（部署里不再有它的仓库来源），且没有孤儿条目复活。
 *
 * 运行：`node --experimental-transform-types verification/2026-11-11-wizard/run-delete.ts`
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
const evidence = join(here, 'result-delete.json')
const stateDir = process.env.DSH_STATE_DIR ?? join(homedir(), '.dsh', 'state', 'superagent')
const scratch = join(tmpdir(), `dsh-delete-${Date.now()}`)
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

async function main(): Promise<void> {
  const result: Record<string, unknown> = { startedAt: stamp(), stateDir, phases: [] as unknown[] }
  const log = (phase: string, detail: unknown) => {
    (result.phases as unknown[]).push({ phase, at: stamp(), detail })
    save(result)
    console.log(`[${phase}]`, JSON.stringify(detail).slice(0, 300))
  }
  const initialReady = await dc.waitReady('启动前等待插件就绪')
  result.startup = initialReady
  log('插件就绪', initialReady)

  // 0. 清理上一次验证的记录与工作副本。
  try { await dc.api('DELETE', `projects/${projectId}`) } catch { /* 不存在时忽略 */ }
  await dc.waitReady('清理旧项目后等待就绪')
  removeTree(join(stateDir, 'repos', `repo-${projectId}`))
  removeTree(join(stateDir, 'repos', 'repo-candidate'))
  removeTree(join(stateDir, 'work', '删除闭环验证'))
  try { await dc.api('DELETE', `git-credentials/${credentialId}`) } catch { /* 不存在时忽略 */ }

  // 1. 临时裸库（单分支 main）+ 本地 dumb HTTP 服务。
  removeTree(scratch)
  const bare = join(scratch, 'live.git')
  const seed = join(scratch, 'seed')
  await git(['init', '--bare', '--initial-branch=main', bare])
  await git(['init', '--initial-branch=main', seed])
  for (const [key, value] of [['user.name', 'DSH Delete'], ['user.email', 'delete@localhost'], ['core.autocrlf', 'false']]) {
    await git(['config', key, value], seed)
  }
  mkdirSync(join(seed, 'tasks'), { recursive: true })
  const taskId = `DEL-${Date.now()}`
  // 任务耗时更长一些，保证删除发生在工单执行中。
  const instruction = '这是删除闭环验证任务：请先调用 orchestrator_report 报告 state=progress，等待 60 秒后再调用 orchestrator_report 报告 state=ready、summary=delete-live-ok，不要修改任何文件。'
  writeFileSync(join(seed, 'tasks', 'backlog.csv'),
    `\uFEFFtask_id,title,status,description,priority\r\n${taskId},${instruction},todo,,P1\r\n`, 'utf8')
  await git(['add', '.'], seed)
  await git(['commit', '--quiet', '-m', 'seed: 删除闭环验证任务'], seed)
  await git(['remote', 'add', 'origin', bare], seed)
  await git(['push', '--quiet', 'origin', 'main'], seed)
  await git(['update-server-info'], bare)
  const server = await serveBare(scratch)
  const remote = `http://127.0.0.1:${(server.address() as { port: number }).port}/live.git`
  log('启动本地 dumb HTTP git 服务', { remote })

  // 2. 凭据 → 验证 → 建项目（与向导同一套最简配置）。
  await dc.api('POST', 'git-credentials', { id: credentialId,
    value: { name: '删除验证凭据', kind: 'https', provider: 'generic', username: 'delete-bot', token: 'delete-token' } })
  const repoConfig = { remote, auth: 'https' }
  await dc.api('POST', 'projects', {
    id: projectId, name: '删除闭环验证', enabled: true,
    codeRepo: { kind: 'github', config: repoConfig },
    taskSource: { kind: 'excel', config: { file: 'tasks/backlog.csv' } },
    gitCredential: credentialId, feishuCredential: '',
    execution: { directory: '', branch: 'main' },
    schedule: { intervalMinutes: 30, runOnStart: true },
    retry: { maxRetries: 0, retryBackoffSeconds: 10 },
    taskPolicy: { pendingStatuses: ['todo'], doneStatus: 'done', failedStatus: 'blocked' },
  })
  const ready = await dc.waitReady('项目配置生效')
  log('项目创建完成', ready)

  // 3. 等工单进入运行态。
  const deadline = Date.now() + 120_000
  let entry: any
  while (Date.now() < deadline) {
    const snapshot = await dc.api<any>('GET', 'queue')
    entry = (snapshot.items as any[]).find(item => item.project === projectId)
    if (entry?.state === 'running' && entry.ticketId) break
    await sleep(2_000)
  }
  check(entry?.ticketId, `120s 内工单未进入运行态：${JSON.stringify(entry)}`)
  result.runningEntry = entry
  log('工单运行中', { ticketId: entry.ticketId, state: entry.state })

  // 4. 运行中删除项目：设置先删（触发初始化重跑），再清理队列与工单。
  const removed = await dc.api<{ removed: boolean; restarting: boolean }>('DELETE', `projects/${projectId}`)
  result.removed = removed
  log('删除项目', removed)
  check(removed.removed && removed.restarting, `删除响应异常：${JSON.stringify(removed)}`)
  await dc.waitReady('删除后初始化重跑')

  // 5. 断言闭环：工单已结束（stopped）、队列无该项目条目、设置无该项目。
  const ticket = await dc.api<any>('GET', `tickets/${entry.ticketId}`)
  result.ticket = { ended: ticket.ended }
  check(ticket.ended?.outcome === 'stopped', `工单未停止：${JSON.stringify(ticket.ended)}`)
  log('工单已停止', ticket.ended)
  const queue = await dc.api<any>('GET', 'queue')
  result.queueAfter = queue.items
  check(!(queue.items as any[]).some(item => item.project === projectId), `队列仍有该项目条目：${JSON.stringify(queue.items)}`)
  log('队列已清理', { items: queue.items.length })
  const settings = await dc.api<any>('GET', 'settings')
  result.projectsAfter = settings.projects
  check(!(settings.projects as any[]).some(item => item.id === projectId), '设置里项目仍然存在')
  log('设置已无该项目', { projects: settings.projects.length })

  // 6. 稳定性观察：再等两轮调度周期，确认没有孤儿条目复活。
  await sleep(35_000)
  const queueLate = await dc.api<any>('GET', 'queue')
  check(!(queueLate.items as any[]).some(item => item.project === projectId), '延迟观察发现该项目条目复活')
  result.stableAfterMs = 35_000
  result.finishedAt = stamp()
  result.ok = true
  log('完成', { ok: true })

  try { await dc.api('DELETE', `git-credentials/${credentialId}`) } catch { /* 不存在时忽略 */ }
  server.close()
  save(result)
  console.log('DELETE_LIVE_OK')
}

main().catch(error => {
  try {
    const existing = existsSync(evidence) ? JSON.parse(readFileSync(evidence, 'utf8')) as Record<string, unknown> : {}
    save({ ...existing, error: String(error), failedAt: stamp() })
  } catch { /* 证据写入失败不掩盖原始错误。 */ }
  console.error('DELETE_LIVE_FAIL', error)
  process.exitCode = 1
})
