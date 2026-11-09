/** 从磁盘加载随包发布的内置技能定义和提示词模板。 */
import { readFileSync } from 'node:fs'
import { packagePath } from '../infra/paths.ts'
/**
 * 读取随包发布的文本文件，并规范为 Unix 换行。
 * @throws 文件缺失或仅含空白时会在错误中指明该文件，因为缺少它 `dsh-superagent` 无法加载。
 */
function packaged(...parts: string[]): { path: string; text: string } {
  const path = packagePath(...parts)
  let text: string
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Missing packaged file: ${path}`, { cause: error }) : error
  }
  if (!text.trim()) throw new Error(`Empty packaged file: ${path}`)
  return { path, text }
}
function load(name: string) {
  const { path, text } = packaged('skills', `dsh-superagent-${name}`, 'SKILL.md')
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  return { name: match[1]!, description: match[2]!, content: match[3]!, path }
}
export const bundledSkills = { feishu: load('feishu'), github: load('github'), gitlab: load('gitlab') }
/**
 * 加载内置提示词文件（`prompts/<name>.md`）。源 `.md` 文件把每个中文段落写在一行内，以便 diff 易读；
 * `promptFile` 会在每个段落内用空格连接各行，同时保留空行分隔的段落。
 */
export function promptFile(name: string): string {
  const paragraphs = packaged('prompts', `${name}.md`).text.trim().split(/\n(?:[ \t]*\n)+/)
  return paragraphs.map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
