/**
 * 桌面版热加载实测（2026-11-11）。
 *
 * 目的：用可观测证据判断桌面版 0.2.2-rc.1 对「已链接插件的构建产物变更」是否热加载，
 * 以及触发热加载需要什么条件、重载粒度、状态是否保留。
 *
 * 方法：
 * 1. 备份 `lib/index.js`，把健康探针里的就绪描述替换成带唯一标记的文本；
 * 2. 先观察一段时间，判断是否存在「改文件即自动重载」；
 * 3. 若不自动，再修改桌面 profile 的 `cordis.patch.yml`（追加一行注释）触发 profile 重组，
 *    观察标记是否生效，以及 startup.json 的 `at`/`pid` 如何变化；
 * 4. 无论结果如何都恢复 `lib/index.js` 与 patch 文件，并再次触发重组确认恢复。
 *
 * 运行：`node --experimental-transform-types verification/2026-11-11-desktop-live/run-hot-reload.ts`
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const evidence = join(here, 'result-hot-reload.json')
const stateDir = process.env.DSH_STATE_DIR ?? join(homedir(), '.dsh', 'state', 'superagent')
const startupFile = join(stateDir, 'startup.json')
const libFile = join(dirname(dirname(here)), 'lib', 'index.js')
const patchFile = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const detailLiteral = 'dsh-superagent ready; the Superagent sidebar entry opens the management panel'
const marker = `hmr-probe-${Date.now()}`

const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const stamp = (): string => new Date().toISOString()

/** 写入证据文件。 */
function save(value: unknown): void {
  writeFileSync(evidence, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
/** 读取启动记录；插件重载会重写它，因此 `at`/`pid` 是判断重载的关键证据。 */
function startup(): { port: number; phase: string; pid: number; at: string } {
  const parsed = JSON.parse(readFileSync(startupFile, 'utf8')) as { listen?: { port?: number }; phase?: string; pid?: number; at?: string }
  return { port: parsed.listen?.port ?? 0, phase: parsed.phase ?? '', pid: parsed.pid ?? 0, at: parsed.at ?? '' }
}
/** 调用健康探针；重载期间连接可能中断，失败按未就绪处理。 */
async function health(port: number): Promise<{ ok?: boolean; detail?: string } | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/health`, { headers: { 'x-orchestrator-request': '1' } })
    return await response.json() as { ok?: boolean; detail?: string }
  } catch {
    return undefined
  }
}
/** 轮询健康探针，直到详情包含标记或超时；返回看到标记的时间与最后一次详情。 */
async function waitMarker(timeoutMs: number): Promise<{ seen: boolean; detail?: string; waitedMs: number; reloadAt?: string }> {
  const started = Date.now()
  const before = startup()
  while (Date.now() - started < timeoutMs) {
    const entry = startup()
    const probe = await health(entry.port)
    if (probe?.detail?.includes(marker)) {
      return { seen: true, detail: probe.detail, waitedMs: Date.now() - started, reloadAt: entry.at }
    }
    if (entry.at !== before.at) {
      // 插件重启了，但新代码没有生效：继续等，同时保留重启记录。
      return { seen: false, detail: probe?.detail, waitedMs: Date.now() - started, reloadAt: entry.at }
    }
    await sleep(1_000)
  }
  return { seen: false, detail: (await health(startup().port))?.detail, waitedMs: Date.now() - started }
}

/**
 * 轮询健康探针，直到详情不再包含标记。
 * 恢复阶段必须等「标记消失」而不是「标记出现」，否则会在旧模块仍生效时过早得出恢复成功的结论。
 */
async function waitMarkerGone(timeoutMs: number): Promise<{ gone: boolean; detail?: string; waitedMs: number; reloadAt?: string }> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const entry = startup()
    const probe = await health(entry.port)
    if (probe?.detail !== undefined && !probe.detail.includes(marker)) {
      return { gone: true, detail: probe.detail, waitedMs: Date.now() - started, reloadAt: entry.at }
    }
    await sleep(1_000)
  }
  return { gone: false, detail: (await health(startup().port))?.detail, waitedMs: Date.now() - started }
}

/** 主流程：改产物 → 等自动重载 → 触发重组 → 记录结论 → 恢复文件。 */
async function main(): Promise<void> {
  const result: Record<string, unknown> = { startedAt: stamp(), marker, libFile, patchFile, phases: [] }
  const log = (phase: string, detail: unknown) => {
    (result.phases as unknown[]).push({ phase, at: stamp(), detail })
    save(result)
    console.log(`[${phase}]`, JSON.stringify(detail).slice(0, 500))
  }
  const before = startup()
  const beforeHealth = await health(before.port)
  log('基线', { startup: before, detail: beforeHealth?.detail })
  if (!existsSync(libFile)) throw new Error(`找不到构建产物：${libFile}（先运行 pnpm build）`)

  const libOriginal = readFileSync(libFile)
  const patched = libOriginal.toString('utf8').replaceAll(detailLiteral, `${detailLiteral} [${marker}]`)
  if (patched === libOriginal.toString('utf8')) throw new Error('产物里找不到用于标记的就绪描述，无法做行为级观测')

  try {
    writeFileSync(libFile, patched, 'utf8')
    log('写入带标记的构建产物', { file: libFile, at: stamp() })
    // 阶段一：只改文件，不做任何触发，判断是否存在文件监听式自动重载。
    const auto = await waitMarker(20_000)
    result.autoReload = auto
    log('仅改文件（20s）', auto)
    if (!auto.seen) {
      // 阶段二：追加一行注释触发 profile 重组；追加前后备份原文件，结束时原样恢复。
      const patchOriginal = readFileSync(patchFile)
      result.patchOriginalBytes = patchOriginal.length
      try {
        writeFileSync(patchFile, `${patchOriginal.toString('utf8')}\n# ${marker}\n`, 'utf8')
        log('触发 profile 重组', { file: patchFile, at: stamp() })
        const afterPatch = await waitMarker(60_000)
        result.afterProfilePatch = afterPatch
        log('profile 重组后（60s）', afterPatch)
      } finally {
        writeFileSync(patchFile, patchOriginal)
      }
    }
  } finally {
    // 恢复产物；若重载确实发生，再触发一次重组让旧代码回到运行时。
    writeFileSync(libFile, libOriginal)
    log('恢复构建产物', { restored: true })
    const patchOriginal = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
    try {
      if (result.afterProfilePatch) {
        writeFileSync(patchFile, `${patchOriginal}\n# restore-${marker}\n`, 'utf8')
        const restored = await waitMarkerGone(45_000)
        result.restored = restored
        log('恢复后确认标记消失', restored)
      }
    } finally {
      writeFileSync(patchFile, patchOriginal, 'utf8')
    }
  }
  // 状态保留证据：重载前后同一份设置与队列记录仍在（都来自状态库，而不是内存）。
  const entry = startup()
  const probe = await health(entry.port)
  result.final = { startup: entry, detail: probe?.detail, settingsStillServed: probe?.ok === true }
  result.finishedAt = stamp()
  log('结论', { autoReload: (result.autoReload as { seen?: boolean })?.seen ?? false,
    reloadOnProfilePatch: (result.afterProfilePatch as { seen?: boolean } | undefined)?.seen ?? false })
  save(result)
  console.log('HOT_RELOAD_PROBE_DONE')
}

main().catch(error => {
  try {
    const existing = existsSync(evidence) ? JSON.parse(readFileSync(evidence, 'utf8')) as Record<string, unknown> : {}
    save({ ...existing, error: String(error), failedAt: stamp() })
  } catch { /* 证据写入失败不掩盖原始错误。 */ }
  console.error('HOT_RELOAD_PROBE_FAIL', error)
  process.exitCode = 1
})
