#!/usr/bin/env node
/**
 * 自我迭代升级（011 §9.2 第 10 项的脚本化）：对本检出的 link 安装执行一次完整的
 * 「拉取 → 依赖 → 构建 → 重载插件 → 实机验证」闭环，全部步骤可跳过、失败即停、退出码可脚本化。
 *
 *   node scripts/self-update.mjs [--profile NAME] [--no-pull] [--no-install] [--no-build] [--no-reload] [--no-verify] [--yes]
 *
 * 步骤：
 *   1. pull         git pull --ff-only（本地有未提交改动时拒绝，避免覆盖工作）
 *   2. install      pnpm install --frozen-lockfile
 *   3. build        pnpm build
 *   4. reload       对 profile 里的 dsh-superagent 条目做 disable → enable 热启用
 *                   （插件管理器语义；不重启宿主应用，不中断已有会话）
 *   5. verify       scripts/verify-live.mjs 全绿才算升级完成
 *
 * 前提：插件以 `link:<本检出>` 安装进目标 profile（桌面版实测的回路）；tgz 安装请改走
 * docs/006-deployment.md「从打包产物安装」。每次变更都要核对 startup.json 的 version 字段
 * 与 package.json 一致——版本漂移说明重载没有真正发生。
 * 退出码：0 成功；1 任一步骤失败（输出指明步骤与原因）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = { profile: '', pull: true, install: true, build: true, reload: true, verify: true, yes: false }
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index]
  if (argument === '--profile') options.profile = process.argv[++index]
  else if (argument === '--no-pull') options.pull = false
  else if (argument === '--no-install') options.install = false
  else if (argument === '--no-build') options.build = false
  else if (argument === '--no-reload') options.reload = false
  else if (argument === '--no-verify') options.verify = false
  else if (argument === '--yes') options.yes = true
  else if (argument === '--help' || argument === '-h') { console.log('usage: self-update [--profile NAME] [--no-pull] [--no-install] [--no-build] [--no-reload] [--no-verify] [--yes]'); process.exit(0) }
  else { console.error(`unrecognized argument: ${argument}`); process.exit(1) }
}
const sleep = ms => new Promise(done => setTimeout(done, ms))
const fail = message => { console.error(`SELF_UPDATE_FAILED: ${message}`); process.exit(1) }
const run = (name, file, args, useRootCwd = true) => {
  console.log(`==> ${name}: ${file} ${args.join(' ')}`)
  const result = spawnSync(file, args, { cwd: useRootCwd ? ROOT : undefined, stdio: 'inherit', shell: false })
  if (result.status !== 0) fail(`${name} 失败（退出码 ${result.status ?? 'signal'}）`)
}

/** 本地有未提交改动时拒绝 pull：自我迭代绝不覆盖进行中的工作。 */
function assertCleanTree() {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  if (status.trim()) fail('检出有未提交改动；先提交或贮藏（git stash），自我迭代不会覆盖进行中的工作。')
}

/** 读 profile 的插件清单与 patch，定位 dsh-superagent 安装形态与其 stateDir（verify-live 需要）。 */
function readProfileState(profile) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const directory = join(home, 'profiles', profile)
  const file = join(directory, 'package.json')
  if (!existsSync(file)) fail(`profile ${profile} 不存在（${directory}）；先用 docs/006-deployment.md 的安装步骤创建它。`)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const installed = parsed.dependencies && Object.keys(parsed.dependencies).includes('dsh-superagent')
  if (!installed) fail(`profile ${profile} 未安装 dsh-superagent（package.json dependencies 里没有）；本脚本只管理 link 安装。`)
  const link = parsed.dependencies['dsh-superagent']
  if (!String(link).startsWith('link:')) fail(`profile ${profile} 的 dsh-superagent 不是 link 安装（${link}）；tgz 安装请走 docs/006 的打包产物升级路径。`)
  // stateDir 在 profile patch 的 dsh-superagent 条目 config 里；解析它供 verify-live 定位 startup.json。
  const patchFile = join(directory, 'cordis.patch.yml')
  let stateDir = ''
  if (existsSync(patchFile)) {
    const lines = readFileSync(patchFile, 'utf8').split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      if (/^\s*-\s*id:\s*dsh-superagent\b/.test(lines[index] ?? '')) {
        for (let scan = index + 1; scan < lines.length; scan++) {
          // 扫到下一个顶层条目为止；stateDir 在该条目的 config 缩进块里。
          if (/^-\s/.test(lines[scan] ?? '')) break
          const match = /^\s*stateDir:\s*(.+?)\s*$/.exec(lines[scan] ?? '')
          if (match) { stateDir = match[1] ? match[1].replace(/^['"]|['"]$/g, '') : ''; break }
        }
        break
      }
    }
  }
  return { directory, stateDir }
}

/**
 * 等待重载生效：轮询 stateDir/startup.json，直到 at 更新；顺带核对 version 与本检出 package.json
 * 一致——不一致说明宿主没有真正重载新产物（重载权威信号是 startup 记录的变化，不是日志）。
 */
async function waitReloaded(stateDirFile, previousAt) {
  const expected = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version) ?? ''
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const entry = JSON.parse(readFileSync(stateDirFile, 'utf8'))
      if (entry.at !== previousAt) {
        if (entry.version && entry.version !== expected) {
          fail(`插件已重新激活但版本不匹配：运行中 ${entry.version}，检出 ${expected}——重载没有拿到新产物，检查安装方式（link 应指向本检出）。`)
        }
        console.log(`    插件已重新激活（at=${entry.at}, version=${entry.version ?? expected}）`)
        return
      }
    } catch { /* 重启中 */ }
    await sleep(2_000)
  }
  fail('120 秒内 startup.json 未更新；宿主没有重载插件——按上面打印的手工步骤操作后重跑（--no-pull --no-install --no-build --no-reload）。')
}

async function main() {
  if (options.pull) { assertCleanTree(); run('pull', 'git', ['pull', '--ff-only']) }
  if (options.install) run('install', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install', '--frozen-lockfile'])
  if (options.build) run('build', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['build'])
  if (options.reload) {
    const profile = options.profile || process.env.DSH_SUPERAGENT_PROFILE
      || fail('未指定 --profile；自我迭代需要知道重载哪个 profile。')
    readProfileState(profile)
    const stateDirFile = join(homedir(), '.dsh', 'state', profile, 'startup.json')
    const before = existsSync(stateDirFile) ? JSON.parse(readFileSync(stateDirFile, 'utf8')).at : ''
    console.log('==> reload（手工步）：用 DeepSeek Harness 插件管理器对 dsh-superagent 条目先禁用再启用，')
    console.log('    或让编码智能体通过 plugin_manager 工具执行同一操作（application: applied 即生效）。')
    console.log('    不要重启宿主应用；不要手写 profile 的 patch 文件（官方实践禁止，且有 30–90 秒延迟与正式化风险）。')
    console.log('    等待重载生效（startup.json 更新，最长 120 秒）……')
    await waitReloaded(stateDirFile, before)
  }
  if (options.verify) {
    console.log('==> verify: verify-live 全绿检查')
    const args = [join(ROOT, 'scripts', 'verify-live.mjs')]
    if (options.profile) {
      // profile 的 stateDir 来自其 patch 条目（插件配置，不随 profile 名约定），显式传给 verify-live。
      const { stateDir } = readProfileState(options.profile)
      if (stateDir) args.push('--state-dir', stateDir)
      else args.push('--profile', options.profile)
    }
    const verify = spawnSync(process.execPath, args, { stdio: 'inherit' })
    if (verify.status !== 0) fail('verify-live 未通过；升级无效或插件异常。')
  }
  console.log('SELF_UPDATE_OK')
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
