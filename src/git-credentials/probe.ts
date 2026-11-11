/** Git 凭据的默认探测：SSH 用临时私钥，HTTPS 用只在本次调用生效的请求头。 */
import { rmSync } from 'node:fs'
import type { Commands } from '../infra/commands.ts'
import { sshCommandOf } from '../code-repos/sync.ts'
import type { SecretVault } from '../secrets/vault.ts'
import type { GitProbe } from './service.ts'

/** `git ls-remote --heads` 每个分支一行，空仓库没有输出。 */
const heads = (output: string): number => output.split(/\r?\n/).filter(line => line.trim() !== '').length

export function gitProbe(commands: Pick<Commands, 'run'>, vault: SecretVault): GitProbe {
  return async ({ remote, kind, material }) => {
    if (kind === 'ssh') {
      const key = vault.temporary('git', 'probe_key', material.privateKey ?? '')
      try {
        const output = await commands.run('git', ['-c', `core.sshCommand=${sshCommandOf(key)}`, 'ls-remote', '--heads', remote])
        return { branches: heads(output) }
      } finally {
        rmSync(key, { force: true })
      }
    }
    const user = material.username || 'x-access-token'
    const auth = Buffer.from(`${user}:${material.token ?? ''}`).toString('base64')
    const output = await commands.run('git', ['-c', `http.extraheader=AUTHORIZATION: basic ${auth}`, 'ls-remote', '--heads', remote])
    return { branches: heads(output) }
  }
}
