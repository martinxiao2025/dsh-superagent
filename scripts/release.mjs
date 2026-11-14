#!/usr/bin/env node
/**
 * 发布脚本：校验门禁（pnpm check）、确认 CHANGELOG 有对应版本小节、写入包版本并打 git 标签。
 * 不推送、不发布 npm——打包与分发由 `pnpm pack` 与 DSH 插件安装流程承担。
 *
 * 用法：`pnpm release 0.3.0`；带 `--dry` 只打印计划不落盘。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dry = process.argv.includes('--dry')
const version = process.argv.slice(2).filter(a => a !== '--dry')[0]
const SemVer = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
if (!version || !SemVer.test(version)) {
  console.error('usage: pnpm release <version> [--dry]   e.g. pnpm release 0.3.0')
  process.exit(2)
}

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', cwd: ROOT })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  return result.stdout
}

// 1. 门禁：typecheck + test + build 全绿。
console.log(`> pnpm check (release ${version})`)
if (!dry) run('pnpm', ['check'])

// 2. CHANGELOG 必须有该版本的小节，且包版本尚未是它。
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
if (!new RegExp(`^## ${version.replaceAll('.', '\\.')}\\b`, 'm').test(changelog)) {
  throw new Error(`CHANGELOG.md has no "## ${version}" section; write the release notes first.`)
}
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
if (manifest.version === version) throw new Error(`package.json is already ${version}; bump the target version.`)
if (manifest.version !== '0.2.0' && !changelog.includes('## Unreleased')) {
  throw new Error('package.json version does not match 0.2.0 baseline; verify manually.')
}

// 3. 写版本并提交 + 打标签（annotated，信息指向 CHANGELOG 小节）。
console.log(`> version ${manifest.version} → ${version}`)
if (!dry) {
  manifest.version = version
  writeFileSync(join(ROOT, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  run('git', ['add', 'package.json', 'CHANGELOG.md'])
  run('git', ['-c', 'user.name=release', '-c', 'user.email=release@localhost', 'commit', '-m', `chore: release ${version}`])
  run('git', ['tag', '-a', `v${version}`, '-m', `dsh-superagent ${version}`])
}
console.log(`release ${version} ${dry ? '(dry run)' : 'done'}; push with: git push --tags`)
