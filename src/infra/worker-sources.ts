/**
 * 工单来源记录的进程侧分发数据：记录 ID → CLI，以及工单目录 → 记录 ID。
 * 工作单元会话的环境变量无法按工单注入，因此垫片与 git 凭据助手通过「当前目录的祖先登记」选择记录；
 * 准备命令的目录尚未登记，改用显式传入的 `DSH_SUPERAGENT_SOURCE`。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** 调度器脚本路径；垫片与 git 凭据助手都经由它执行记录自己的 CLI。 */
export const workerDispatch = (stateDir: string): string => join(stateDir, 'worker-dispatch.mjs')
/** 分发数据文件路径。 */
const workerSources = (stateDir: string): string => join(stateDir, 'worker-sources.json')

/** 一条来源记录在执行侧需要的信息。 */
export interface WorkerRecord { kind: string; cli: string }
/** 分发数据：每个记录的种类与 CLI，以及已登记的工单目录。 */
interface WorkerSources { clis: Record<string, WorkerRecord>; tickets: Record<string, string> }

/**
 * 目录键：绝对路径，Windows 上统一小写（环境变量名与路径大小写不敏感）。
 * 调度器使用同一套规则查找，登记与查找必须一致。
 */
export function ticketKey(directory: string): string {
  const absolute = resolve(directory)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * 按 `stateDir` 串行化读改写：`writeEnvironment` 与工单登记是两个模块，共用同一个队列才不会互相覆盖。
 * 前一次失败不影响后一次。
 */
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  const key = ticketKey(stateDir)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(run, run)
  queues.set(key, next.catch(() => { /* 失败由调用方处理；队列继续。 */ }))
  return next
}

/** 读取分发数据；文件不存在或损坏时视为空。 */
async function read(stateDir: string): Promise<WorkerSources> {
  try {
    const parsed = JSON.parse(await readFile(workerSources(stateDir), 'utf8')) as Partial<WorkerSources>
    return { clis: parsed.clis ?? {}, tickets: parsed.tickets ?? {} }
  } catch { return { clis: {}, tickets: {} } }
}

/** 原子写入分发数据，使并发的调度器进程总能看到完整内容。 */
async function write(stateDir: string, value: WorkerSources): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const file = workerSources(stateDir)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/** 重写记录列表，保留工单登记，并清掉指向已删除记录的悬空登记。 */
export async function writeWorkerRecords(stateDir: string, records: Record<string, WorkerRecord>): Promise<void> {
  await serialized(stateDir, async () => {
    const current = await read(stateDir)
    const tickets = Object.fromEntries(Object.entries(current.tickets).filter(([, id]) => id in records))
    await write(stateDir, { clis: records, tickets })
  })
}

/** 登记工单目录的来源记录；工作单元的 shell 在该目录及其子目录中执行时据此选择 CLI。 */
export async function recordTicketSource(stateDir: string, directory: string, recordId: string): Promise<void> {
  await serialized(stateDir, async () => {
    const current = await read(stateDir)
    current.tickets[ticketKey(directory)] = recordId
    await write(stateDir, current)
  })
}

/**
 * 调度器正文（不含标记行）：按命令选择记录后执行其 CLI。
 * 只使用 Node 内置模块，因为它以独立进程运行；选择记录时绝不以「第一条记录」兜底。
 */
export const WORKER_DISPATCH_BODY: string = [
  "import { spawnSync } from 'node:child_process'",
  "import { readFileSync } from 'node:fs'",
  "import { delimiter, dirname, join, resolve } from 'node:path'",
  '',
  '// 命令名到适用的来源种类；git 凭据助手只服务会托管 Git 仓库的两类来源。',
  "const KINDS = { gh: ['github'], glab: ['gitlab'], 'lark-cli': ['feishu'], 'git-credential': ['github', 'gitlab'] }",
  "const LABELS = { github: 'GitHub', gitlab: 'GitLab', feishu: 'Feishu' }",
  '/** 打印原因并以 1 退出，与缺失来源时的垫片行为一致。 */',
  'const fail = message => { process.stderr.write(`${message}\\n`); process.exit(1) }',
  '',
  'const stateDir = dirname(process.argv[1])',
  'const bin = join(stateDir, \'worker-bin\')',
  'const [command, ...args] = process.argv.slice(2)',
  'const kinds = KINDS[command]',
  'if (!kinds) fail(`${command} is not a dsh-superagent worker command`)',
  '',
  'const sources = (() => {',
  '  try {',
  "    const value = JSON.parse(readFileSync(join(stateDir, 'worker-sources.json'), 'utf8'))",
  '    return { clis: value.clis ?? {}, tickets: value.tickets ?? {} }',
  '  } catch { return { clis: {}, tickets: {} } }',
  '})()',
  'const normalize = path => process.platform === \'win32\' ? resolve(path).toLowerCase() : resolve(path)',
  'const records = Object.entries(sources.clis).filter(([, record]) => kinds.includes(record.kind))',
  '',
  '// 记录选择：显式记录（准备命令的环境变量）→ 当前目录的祖先登记 → 该种类唯一一条；否则失败。',
  'const declared = process.env.DSH_SUPERAGENT_SOURCE',
  'let pinned = declared && sources.clis[declared] && kinds.includes(sources.clis[declared].kind) ? declared : undefined',
  'if (pinned === undefined) {',
  '  let directory = normalize(process.cwd())',
  '  for (;;) {',
  '    const id = sources.tickets[directory]',
  '    if (id !== undefined && sources.clis[id] && kinds.includes(sources.clis[id].kind)) { pinned = id; break }',
  '    const parent = dirname(directory)',
  '    if (parent === directory) break',
  '    directory = parent',
  '  }',
  '}',
  'const record = pinned !== undefined ? sources.clis[pinned] : records.length === 1 ? records[0][1] : undefined',
  'if (!record) {',
  "  const label = kinds.length > 1 ? 'GitHub or GitLab' : LABELS[kinds[0]]",
  "  if (!records.length) fail(`${command === 'git-credential' ? 'git' : command} is unavailable: this installation has no ${label} Source.`)",
  "  fail(`${command} cannot choose a Source record: this installation has ${records.length} ${label} Sources (${records.map(([id]) => id).join(', ')}); run it inside a ticket directory so it uses the ticket's Source record.`)",
  '}',
  '',
  '// 真实 CLI 的目录必须离开 PATH，否则按名字调用 gh 的包装脚本会再次回到垫片。',
  'const path = (process.env.PATH ?? \'\').split(delimiter).filter(entry => entry && normalize(entry) !== normalize(bin)).join(delimiter)',
  'const env = {}',
  "for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name.toUpperCase() !== 'PATH') env[name] = value",
  'env.PATH = path',
  '',
  "// git 会把凭据操作作为参数追加；`gh auth git-credential` 与 `glab auth git-credential` 都按该协议读取 stdin。",
  "const argv = command === 'git-credential' ? ['auth', 'git-credential', ...args] : args",
  'const batch = /\\.(?:cmd|bat)$/i.test(record.cli)',
  'const quote = value => `"${value.replaceAll(\'"\', \'""\')}"`',
  'const spec = process.platform === \'win32\' && batch',
  '  ? { file: process.env.ComSpec ?? \'cmd.exe\', args: [\'/d\', \'/s\', \'/c\', `"${quote(record.cli)} ${argv.map(quote).join(\' \')}"`], windowsVerbatimArguments: true }',
  '  : { file: record.cli, args: argv, windowsVerbatimArguments: false }',
  '// stdin、stdout 与 stderr 都继承：git 的凭据协议与 CLI 的输出必须原样通过。',
  'const result = spawnSync(spec.file, spec.args, { stdio: \'inherit\', env, windowsVerbatimArguments: spec.windowsVerbatimArguments })',
  'if (result.error) fail(`${command} could not run ${record.cli}: ${result.error.message}`)',
  'process.exit(result.status === null ? 1 : result.status)',
  '',
].join('\n')
