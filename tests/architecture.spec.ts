/**
 * 静态架构守卫：扫描 `src` 的 import 语句，锁定分层方向。
 * 规则（与 docs/007-architecture.md「依赖规则」一致）：
 * 1. `core` 不依赖除自身与 node: 内建之外的任何模块；
 * 2. `infra` 是最底层：不依赖 app/executor/sources/task-sources/code-repos/credential 域；
 * 3. `executor` 不值级依赖 `app`，除零依赖叶子 `app/later.ts`（Later 信号）；
 * 4. `deployment` 与 `infra` 之间没有值级环（infra 只允许类型导入 deployment-types 叶子）；
 * 5. 根文件（deployment.ts）与 infra 都不值级依赖对方（环已断开：类型权威在 deployment-types.ts）。
 * 依赖图脚本的口径（011 §1）以本文件为准在 CI 中持续执行；dependency-cruiser 的等价规则由本文件承载。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
/** 递归列出 `src` 下全部 TS 模块的绝对路径（POSIX 分隔符）。 */
function modules(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name).split('\\').join('/'))
}
/** 模块的值级 import 目标（跳过 `import type` 与 node:/包名）。 */
function valueImports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const out: string[] = []
  for (const match of text.matchAll(/import\s+(?!type\b)(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)) {
    const target = match[1]!
    if (target.startsWith('node:') || !target.startsWith('.')) continue
    out.push(target)
  }
  return out
}
/** 相对 import 解析到同目录或祖先目录的 TS 模块（补全 .ts/.tsx/index）。 */
function resolveImport(fromFile: string, target: string): string | undefined {
  const base = join(dirname(fromFile), target).split('\\').join('/')
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    try { readFileSync(candidate, 'utf8'); return candidate } catch { /* 尝试下一个候选。 */ }
  }
  return undefined
}
/** 模块路径的层名：`src` 后的第一段（根文件为 `''`）。 */
const layerOf = (file: string): string => {
  const relative = file.replace(`${SRC.split('\\').join('/')}/`, '')
  const segments = relative.split('/')
  return segments.length === 1 ? '' : segments[0]!
}

const all = modules(SRC)
const edges = all.flatMap(from => valueImports(from)
  .map(target => resolveImport(from, target)).filter((to): to is string => !!to).map(to => ({ from, to })))

describe('静态架构守卫', () => {
  it('core 只依赖自身与 node: 内建', () => {
    const violations = edges.filter(({ from, to }) => layerOf(from) === 'core' && layerOf(to) !== 'core')
    expect(violations.map(({ from, to }) => `${from} → ${to}`)).toEqual([])
  })
  it('infra 不依赖 app/executor/sources 或业务域', () => {
    const forbidden = new Set(['app', 'executor', 'sources', 'task-sources', 'code-repos', 'projects', 'queue', 'secrets',
      'git-credentials', 'feishu-credentials', 'client'])
    const violations = edges.filter(({ from, to }) => layerOf(from) === 'infra' && forbidden.has(layerOf(to)))
    expect(violations.map(({ from, to }) => `${from} → ${to}`)).toEqual([])
  })
  it('infra 对 deployment 只有类型依赖（deployment ↔ infra 无值级环）', () => {
    const violations = all.filter(file => layerOf(file) === 'infra')
      // 单行 import：`import type {…} from` 或 `import { type X } from` 都算类型依赖。
      .flatMap(file => readFileSync(file, 'utf8').split(/\r?\n/)
        .filter(line => /import\s/.test(line) && !/^\s*import\s+type\s/.test(line) && /['"]\.\.\/deployment(\-types)?\.ts['"]/.test(line)
          && line.split('{')[0]!.includes('import') && !/^import type/.test(line.trim()) && !/import\s+type\s*\{/.test(line))
        .map(() => `${file} 值级 import deployment`))
    expect(violations).toEqual([])
  })
  it('executor 不值级依赖 app，除零依赖叶子 app/later.ts', () => {
    const violations = edges.filter(({ from, to }) => layerOf(from) === 'executor'
      && layerOf(to) === 'app' && !to.endsWith('/app/later.ts'))
    expect(violations.map(({ from, to }) => `${from} → ${to}`)).toEqual([])
  })
  it('deployment.ts 不值级依赖 infra 的环境与命令模块（环已断开，仅剩类型与既有实现）', () => {
    // deployment.ts 仍通过 infra/environment 与 infra/commands 获取运行时助手；环的另一半已断：
    // infra 只能看到 deployment-types 叶子。锁定 deployment.ts 自身不得被 infra 值级反向依赖。
    const violations = edges.filter(({ from, to }) => layerOf(from) === 'infra' && /\/deployment\.ts$/.test(to))
    expect(violations.map(({ from, to }) => `${from} → ${to}`)).toEqual([])
  })
  it('scheduler 的宿主不再隐式回退：registry 与 syncRepo 为必传字段', () => {
    const text = readFileSync(join(SRC, 'app', 'scheduler.ts'), 'utf8')
    expect(text).toMatch(/readonly registry: TaskSourceRegistry/)
    expect(text).toMatch(/readonly syncRepo: \(projectId: string\) => Promise<string>/)
    expect(text).not.toMatch(/host\.registry \?\?|host\.syncRepo \?\?/)
  })
  it('code-repos/task-sources 的消费方经由 port.ts 取用同步与读取入口', () => {
    const violations = edges.filter(({ from, to }) =>
      layerOf(to) === 'code-repos' && /\/(sync|work|read)\.ts$/.test(to) && layerOf(from) !== 'code-repos')
    expect(violations.map(({ from, to }) => `${from} → ${to}`)).toEqual([])
  })
})
