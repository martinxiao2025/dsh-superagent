import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NUMBERED = /^(\d{3})-[a-z0-9-]+\.md$/
const numbered = readdirSync(join(ROOT, 'docs')).filter(name => NUMBERED.test(name)).sort()
const entries = ['README.md', 'SETUP.md']
const documents = [...entries, ...readdirSync(join(ROOT, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)]
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
function links(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!.split('#')[0]!).filter(target => target && !/^[a-z]+:/.test(target))
}
// 文档始终用 `/` 命名路径，因此在每个平台上都用相同的分隔符比较。
const slash = (path: string): string => path.split(sep).join('/')
const files = (directory: string): string[] => readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => slash(relative(ROOT, join(entry.parentPath, entry.name))))
/**
 * 从 `docs/007-architecture.md` 中 `## <heading>` 下表格的第一列提取仓库相对文件路径。
 * 裸文件名继承同一单元格中前一个路径的目录。
 */
function listed(heading: string): string[] {
  // Git 可能以任一换行符检出文档，因此两种都要拆分。
  const lines = read('docs/007-architecture.md').split(/\r?\n/)
  const start = lines.indexOf(`## ${heading}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  // 前两行是表头及其分隔行。
  const rows = lines.slice(start, end < 0 ? undefined : end).filter(line => line.startsWith('| ')).slice(2)
  return rows.flatMap(row => {
    let directory = ''
    return [...row.split('|')[1]!.matchAll(/`([^`]+)`/g)].map(([, name]) => {
      if (!name!.includes('/')) return `${directory}/${name!}`
      directory = dirname(name!)
      return name!
    })
  })
}

describe('文档', () => {
  it('文档从 000 开始连续编号', () => {
    expect(numbered.map(name => name.slice(0, 3))).toEqual(numbered.map((_, index) => String(index).padStart(3, '0')))
  })
  it('编号文档只链接到更早的编号文档', () => {
    const violations = numbered.flatMap(name => links(join(ROOT, 'docs', name)).flatMap(target => {
      const linked = resolve(ROOT, 'docs', target)
      if (!linked.endsWith('.md')) return []
      const number = NUMBERED.exec(basename(linked))?.[1]
      return dirname(linked) === join(ROOT, 'docs') && number !== undefined && number < name.slice(0, 3) ? [] : [`${name} → ${target}`]
    }))
    expect(violations).toEqual([])
  })
  it('每个本地链接都能解析', () => {
    const files = [...entries.map(name => join(ROOT, name)), ...numbered.map(name => join(ROOT, 'docs', name))]
    const missing = files.flatMap(file => links(file).filter(target => !existsSync(resolve(dirname(file), target))).map(target => `${file.slice(ROOT.length + 1)} → ${target}`))
    expect(missing).toEqual([])
  })
  it('任何文档都不含合并冲突标记', () => {
    expect(documents.filter(path => /^(<{7}|>{7}) /m.test(read(path)))).toEqual([])
  })
  it('在 007 架构的模块表中列出 src 的每个模块，且只列出存在的文件', () => {
    const modules = listed('模块')
    expect(files('src').filter(path => !modules.includes(path))).toEqual([])
    expect(modules.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })
  it('在 007 架构的测试表中列出每个测试，且只列出存在的文件', () => {
    const tests = listed('测试')
    expect(files('tests').filter(path => /\.spec\.tsx?$/.test(path) && !tests.includes(path))).toEqual([])
    expect(tests.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })
})
