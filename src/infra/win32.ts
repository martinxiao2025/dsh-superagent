/**
 * Windows 特有规则的唯一权威实现：cmd.exe 命令行引用、路径大小写归一与 PATHEXT 解析。
 * 此前同一规则在 commands、worker-sources 垫片、workspace-gc、code-repos/sync 与 deployment 各有一份拷贝，
 * 靠注释约定对齐；现在实现（供本进程调用）与源码形态（供生成的垫片内嵌，垫片无法 import 本模块）都集中在这里。
 */
import { resolve } from 'node:path'

/**
 * 为 `cmd.exe /d /s /c` 命令行引用一个参数：整体加双引号，内嵌引号按 cmd 的预期加倍。
 * `spawnArgv`/`spawnCommand`（本进程）与 worker-dispatch 垫片（生成的独立脚本）共用这一条规则。
 */
export const cmdQuote = (argument: string): string => `"${argument.replaceAll('"', '""')}"`
/** `cmdQuote` 的源码形态：垫片以字符串数组拼接生成，无法 import 本模块，用同一常量保证规则单源。 */
export const CMD_QUOTE_SOURCE = 'value => `"${value.replaceAll(\'"\', \'""\')}"`'
/**
 * 路径归一为可比较的键：绝对路径，Windows 上统一小写（路径大小写不敏感）并保持分隔符原样；
 * POSIX 原样返回。登记与查找（worker-sources、workspace-gc、code-repos/sync）必须共用本函数。
 */
export function normalizePath(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
/** `normalizePath` 的源码形态（垫片作用域内已有 `resolve`）；与 `normalizePath` 保持同一规则。 */
export const NORMALIZE_PATH_SOURCE = 'path => process.platform === \'win32\' ? resolve(path).toLowerCase() : resolve(path)'
/** Windows 会像 `cmd` 和 `where` 那样为裸命令名附加的扩展名；POSIX 不附加任何扩展名。 */
export function pathExtensions(): readonly string[] {
  return process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : []
}
