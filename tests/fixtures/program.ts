/**
 * 跨平台假程序夹具：假 CLI 一律用 Node 编写，POSIX 用 sh 启动器，Windows 用 .cmd 启动器，
 * 因此测试不再依赖 `sh`、`sleep`、`echo`、`cat` 等 POSIX 命令。
 */
import { execFile } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnCommand } from '../../src/infra/commands.ts'

/** Windows 用 `PATHEXT` 中登记的大小写写启动器，与产品解析 PATH 得到的路径一致；其余平台无扩展名。 */
const batchExtension = (): string => (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').find(extension => extension.toLowerCase() === '.cmd') ?? '.CMD'

/** 假程序在 PATH 上可被解析到的文件名：POSIX 无扩展名，Windows 需要 `PATHEXT` 里的扩展名。 */
export const programName = (name: string): string => process.platform === 'win32' ? `${name}${batchExtension()}` : name

/**
 * 在 `directory` 写入一个可执行的假程序，返回它的路径。
 * `body` 是函数体源码，可使用 `argv`、`env` 与 `require`；`return` 一个数字作为退出码。
 * 源码写进 `.cjs` 文件，不受所在目录 `package.json` 的 `type` 影响；PATH 解析与批处理启动在各平台一致。
 */
export function programSource(directory: string, name: string, body: string): string {
  const script = join(directory, `${name}.cjs`)
  writeFileSync(script, [
    'const main = async (argv, env) => {',
    body,
    '}',
    'Promise.resolve(main(process.argv.slice(2), process.env)).then(',
    '  code => process.exit(typeof code === "number" ? code : 0),',
    '  error => { console.error(error && error.message ? error.message : String(error)); process.exit(1) },',
    ')',
    '',
  ].join('\n'))
  if (process.platform === 'win32') {
    const launcher = join(directory, programName(name))
    // 写死脚本的绝对路径：批处理经 PATH 以裸名字启动时 `%0` 不含目录，`%~dp0` 会退回当前目录。
    writeFileSync(launcher, ['@echo off', `"${process.execPath}" "${script}" %*`, 'exit /b %ERRORLEVEL%', ''].join('\r\n'))
    return launcher
  }
  const launcher = join(directory, name)
  writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`)
  chmodSync(launcher, 0o755)
  return launcher
}

/** 以跨平台方式运行一个程序：`.cmd`/`.bat` 经 `cmd.exe` 启动，其余直接启动。 */
export function runProgram(program: string, args: readonly string[], options: Parameters<typeof execFile>[2] = {}): Promise<{ stdout: string; stderr: string }> {
  const { file, args: argv, windowsVerbatimArguments } = spawnCommand(program, args)
  return new Promise((resolve, reject) => {
    execFile(file, argv, { ...options, windowsVerbatimArguments }, (error, stdout, stderr) => error
      ? reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }))
      : resolve({ stdout: String(stdout), stderr: String(stderr) }))
  })
}
