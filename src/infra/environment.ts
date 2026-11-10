/**
 * 进程环境与 CLI 垫片：把 git、gh 和 lark-cli 绑定到部署的账号，并阻止被禁用的命令。
 * 工作单元读取的变量名避免出现 `KEY|PASSWORD|SECRET|TOKEN`，因为 DSH 会从子进程环境中剥离形如凭据的变量。
 * 这里提供的是默认路径防护栏，而非操作系统级安全边界，因为工作单元以运维者的 OS 用户身份运行。
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { firstSource, hostOf, type Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** 项目早先名称（`dsh-tag`、`dsh-go`、`dsh-freelancer`）下写入文件的标记，`dsh-superagent` 也拥有并会替换这些文件。 */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** 工作单元需要的命令，`blockedCommands` 无法屏蔽它们：垫片和 git。 */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}
/** 在 shell 中运行 `command` 的 argv：POSIX 上用 `sh -c`，Windows 上用 cmd 的 `/c`（Windows 没有 `sh`）。 */
export const shellArgv = (command: string): string[] => process.platform === 'win32'
  ? [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', command]
  : ['sh', '-c', command]

/**
 * 告诉 git 要操作哪个仓库、工作树和索引的变量。在 git 内部启动的宿主（例如通过 `git rebase --exec`）会把它们传下去，
 * 而在其下启动的 git 会作用到那个仓库。GIT_CEILING_DIRECTORIES 被保留：它不指名任何仓库，
 * 并会让 git 在运维者选定的位置停止向上搜索仓库。
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * 返回环境变量覆盖项，用于剥离环境中的 GitHub 令牌、交互式提示、宿主自身环境可能指明的仓库，
 * 以及运维者的 git 身份/配置覆盖项。
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // 工作单元的 git 从其目录查找仓库，而绝不从宿主环境获取。
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // 清除环境中的 git 配置覆盖项；否则通过环境传入的配置会到达智能体运行的每条 git 命令。
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // 当凭据助手没有答案时，git 必须失败而不是弹出提示；`GIT_ASKPASS: ''` 也会覆盖 `core.askPass` 和 `SSH_ASKPASS`。
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // 清除运维者的提交身份变量；提示词会指定提交身份，而运维环境变量会覆盖工作单元设置的值。
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** 当普通文件的前两行包含 dsh-superagent 标记时为 true；符号链接、目录或其他非普通文件永远不会被视为由 dsh-superagent 写入。 */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2).map(line => line.replace(/\r$/, ''))
  // 批处理垫片用 `rem` 标记自身，`cmd` 会忽略它，因此标记仍位于第二行。
  return [MARKER, ...LEGACY_MARKERS].flatMap(marker => [marker, `rem ${marker}`]).some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* 文件尚不存在。 */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * 工作单元垫片的文件名。Windows 只能启动 `PATHEXT` 扩展名所列的文件，因此那里的垫片是
 * 批处理文件；POSIX shell 会解析无扩展名的名称。
 */
export const shimFile = (name: string): string => process.platform === 'win32' ? `${name}.cmd` : name
/** 批处理垫片：`cmd` 忽略第一行与标记行，然后执行正文。 */
const batch = (body: readonly string[]): string => ['@echo off', `rem ${MARKER}`, ...body].join('\r\n') + '\r\n'
/** 从 PATH 中移除垫片目录的 POSIX 行；垫片目录按 PATH 中的写法原样写入。 */
const posixWithoutShims = (dir: string): string[] => [
  `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
  'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
  'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
]
/**
 * 从 PATH 中移除垫片目录的 Windows 行，逐项比较完整路径与脚本所在目录。
 * 累加在子例程中执行，因为 `for` 块内的 `%rest%` 只会在解析块时展开一次，
 * 每一项都会覆盖前一个值，最终只留下最后一项。
 */
const WINDOWS_WITHOUT_SHIMS = [
  'set "self=%~dp0"', 'set "rest="',
  'for %%P in ("%PATH:;=" "%") do call :dsh_keep "%%~P"',
  'set "PATH=%rest:~1%"',
  'goto :dsh_run',
  ':dsh_keep',
  'if /I not "%~f1\\"=="%self%" set "rest=%rest%;%~1"',
  'exit /b 0',
  ':dsh_run',
]
/**
 * 用调用方的参数运行 `program` 的垫片正文。垫片目录先离开 PATH，这样按名称调用 `gh` 的包装脚本
 * 会到达真实二进制，而不是再次回到这个垫片。
 */
function shimRunning(program: string, dir: string): string {
  if (process.platform !== 'win32') return `#!/bin/sh\n${MARKER}\n${posixWithoutShims(dir).join('\n')}\nexec ${shellQuote(program)} "$@"\n`
  return batch([...WINDOWS_WITHOUT_SHIMS, `"${program}" %*`, 'exit /b %ERRORLEVEL%'])
}
/** 把 `message` 打印到标准错误并以 1 退出，用于被屏蔽的命令或缺失的飞书机器人。 */
function shimFailing(message: string): string {
  if (process.platform !== 'win32') return `#!/bin/sh\n${MARKER}\necho ${shellQuote(message)} >&2\nexit 1\n`
  // `echo(` 会原样打印该行剩余内容（包括右括号），因此文本会结束该行。
  return batch([`1>&2 echo(${message}`, 'exit /b 1'])
}

/**
 * 原子地把工作单元 CLI 垫片和隔离的 git 配置文件写入状态目录，拒绝覆盖外来文件。
 * 每个垫片在运行目标前先从 PATH 移除垫片目录，这样按名称解析 `gh` 或 `lark-cli` 的包装脚本会到达真实二进制。
 */
export async function writeEnvironment(deployment: Deployment, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, sources } = deployment
  const github = firstSource(deployment, 'github')
  const feishu = firstSource(deployment, 'feishu')
  const gitlab = firstSource(deployment, 'gitlab')
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // 工作单元可能并发运行：把每个垫片写入临时文件再原子重命名，确保任何命令都不会绕过垫片目录解析到目标。
  const kept = new Set<string>()
  const shim = async (name: string, text: string): Promise<void> => {
    const file = shimFile(name)
    const temporary = join(dir, `.${file}.${process.pid}.tmp`)
    await writeFile(temporary, text, { mode: 0o755 })
    await rename(temporary, join(dir, file))
    kept.add(file)
  }
  await shim('gh', github ? shimRunning(github.cli, dir) : shimFailing('gh is unavailable: this installation has no GitHub Source.'))
  await shim('lark-cli', feishu ? shimRunning(feishu.cli, dir) : shimFailing('lark-cli is unavailable: this installation has no Feishu Source.'))
  // 只在配置了 GitLab 来源时遮蔽 PATH 上的 glab；否则保留运维者自带的 glab。
  if (gitlab) await shim('glab', shimRunning(gitlab.cli, dir))
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    const advice = github ? `use gh, which acts as ${github.login}` : 'no GitHub Source is configured'
    await shim(name, shimFailing(`${name} is blocked in this installation; ${advice}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  // 每个 GitHub 来源记录一个站点的凭据助手；同一站点只保留第一条记录。
  const credentials = new Map<string, string>()
  for (const source of Object.values(sources)) {
    if (source.kind !== 'github') continue
    const host = hostOf(source.instanceUrl, 'github.com')
    if (!credentials.has(host)) credentials.set(host, credentialHelper(source.cli))
  }
  await own(workerGitConfig(stateDir), [
    MARKER,
    // 让 git 在没有工作单元显式设置身份时拒绝提交，而不是从运维者的 OS 用户猜测。
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    ...credentials.size ? [...credentials].map(([host, helper]) => `[credential "https://${host}"]\n\thelper = ${gitQuote(helper)}`) : [],
    ...credentials.has('github.com') ? ['[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/'] : [],
    // 包含 Git LFS 过滤器，因为运维者的全局 gitconfig（通常保存它们）被忽略。
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** 应用环境覆盖项并把工作单元垫片前置到 `process.env.PATH`，返回恢复回调。 */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** 通过 DSH 子进程运行时启动命令，该运行时会剥离形如凭据的环境变量。 */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** 验证工作单元的 git 调用会解析到第一条 GitHub 来源记录的凭据助手；没有 GitHub 来源时不校验。 */
export async function verifyEnvironment(deployment: Deployment, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { stateDir } = deployment
  const github = firstSource(deployment, 'github')
  if (!github) return
  const host = hostOf(github.instanceUrl, 'github.com')
  // `-z` 用 NUL 分隔字段，且从不引用路径。
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', `credential.https://${host}.helper`], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  if (helpers.join('\0') !== [`file:${workerGitConfig(stateDir)}`, credentialHelper(github.cli), ''].join('\0')) throw new SetupError('gitTooOld')
}

/**
 * 验证工单目录的本地或工作树 git 配置未定义自定义的 `credential.*` 或 `http.*extraheader`
 * 键，否则智能体的 git 会从仓库自身的配置读取并据此行动。
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // 没有匹配的键时，`git config --get-regexp` 会以退出码 1 结束。
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
