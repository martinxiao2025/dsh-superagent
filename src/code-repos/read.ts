/** 代码仓库文件读取：只读访问默认分支里的非隐藏文件或目录，供评估与执行使用。 */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'

/** 通过 GitHub API 读取仓库默认分支中的非隐藏文件或目录列表；隐藏条目和 `node_modules` 会被拒绝。 */
export async function readRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const resource = `contents/${parts.map(encodeURIComponent).join('/')}`
  if (kind === 'file') return commands.api(resource, '-H', 'Accept: application/vnd.github.raw')
  // 目录返回条目数组，文件返回单个对象。
  const entries = await commands.api(z.union([z.array(z.looseObject({ name: z.string() })), z.looseObject({})]), resource)
  if (!Array.isArray(entries)) throw new Error(`${path} is not a directory`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}
