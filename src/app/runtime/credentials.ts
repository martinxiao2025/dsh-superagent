/**
 * 凭据域的装配工厂：从 Runtime 拆出的第①阶段（评审 4.1）——构造加密存储、两域凭据服务与
 * 按凭据现取的飞书知识库/群消息读取能力。`Runtime` 只调用本工厂；此文件之外不接触凭据材料。
 */
import type { Commands } from '../../infra/commands.ts'
import type { Machine } from '../../deployment-types.ts'
import { gitProbe } from '../../git-credentials/probe.ts'
import { GitCredentials } from '../../git-credentials/service.ts'
import { feishuProbe } from '../../feishu-credentials/probe.ts'
import { FeishuCredentials } from '../../feishu-credentials/service.ts'
import { httpWikiApi, larkWikiApi, type FeishuWikiApi, type FeishuWikiReader } from '../../task-sources/feishu-api.ts'
import { httpImApi, larkImApi, type FeishuImApi, type FeishuImReader } from '../../task-sources/feishu-im-api.ts'
import { SecretVault } from '../../secrets/vault.ts'
import type { Store } from '../store.ts'

/** `buildCredentials` 所需的最小宿主面。 */
export interface CredentialsHost {
  readonly store: Store
  readonly commands: Commands
  readonly machine: Machine
  readonly lifetime: AbortSignal
}
/** 构造结果：两个凭据服务与两个飞书读取能力；`vault` 由调用方在停止时关闭。 */
export function buildCredentials(host: CredentialsHost): { vault: SecretVault; gitCredentials: GitCredentials; feishuCredentials: FeishuCredentials;
  feishuWikiReader: FeishuWikiReader; feishuImReader: FeishuImReader } {
  const { store, commands, machine, lifetime } = host
  // 凭据记录与项目引用相互独立：项目只保存记录 ID，材料永远不进入设置快照。
  const vault = new SecretVault(machine.stateDir)
  const projects = () => store.projects.map()
  const gitCredentials = new GitCredentials({ credentials: store.gitCredentials, vault, projects, probe: gitProbe(commands, vault) })
  const feishuCredentials = new FeishuCredentials({ credentials: store.feishuCredentials, vault,
    references: () => feishuCredentialReferences(store.projects.list()), probe: feishuProbe(commands) })
  /** 凭据的调用方式：CLI 身份用可执行文件，应用身份用 appId 与密钥；材料只在这里短暂读取。 */
  const feishuApi = (credential: string): { cli: string } | { appId: string; secret: string } | undefined => {
    const record = store.feishuCredentials.get(credential)
    if (!record) return undefined
    if (record.mode === 'cli') return { cli: record.cli.trim() || 'lark' }
    const secret = feishuCredentials.material(credential)?.appSecret
    return record.appId && secret ? { appId: record.appId, secret } : undefined
  }
  /** CLI 身份调用：以机器人身份、JSON 输出，失败时把业务码并进消息。 */
  const larkCall = (cli: string) => async (args: string[]): Promise<unknown> => {
    const output = await commands.run(cli, [...args, '--as', 'bot', '--format', 'json'], machine.stateDir)
    const result = JSON.parse(output) as { ok: boolean; data: unknown; error?: { code?: number; message?: string } }
    if (!result.ok) throw new Error(`${result.error?.message ?? 'Feishu command failed'}${result.error?.code ? ` (${result.error.code})` : ''}`)
    return result.data
  }
  // 凭据材料只在读取知识库或群消息时短暂进入内存；两种能力共用同一份凭据解析。
  // 按 credential 缓存读取器实例（评审 S5）：同一凭据的多次读取复用其 token 缓存与连接，而不是每次重建。
  const wikiReaders = new Map<string, Promise<FeishuWikiApi | undefined>>()
  const imReaders = new Map<string, Promise<FeishuImApi | undefined>>()
  const feishuWikiReader: FeishuWikiReader = credential => {
    let cached = wikiReaders.get(credential)
    if (!cached) {
      cached = (async () => {
        const api = feishuApi(credential)
        if (!api) return undefined
        return 'cli' in api ? larkWikiApi(larkCall(api.cli)) : httpWikiApi(api.appId, api.secret, lifetime)
      })()
      cached.catch(() => wikiReaders.delete(credential))
      wikiReaders.set(credential, cached)
    }
    return cached
  }
  const feishuImReader: FeishuImReader = credential => {
    let cached = imReaders.get(credential)
    if (!cached) {
      cached = (async () => {
        const api = feishuApi(credential)
        if (!api) return undefined
        return 'cli' in api ? larkImApi(larkCall(api.cli)) : httpImApi(api.appId, api.secret, lifetime)
      })()
      cached.catch(() => imReaders.delete(credential))
      imReaders.set(credential, cached)
    }
    return cached
  }
  return { vault, gitCredentials, feishuCredentials, feishuWikiReader, feishuImReader }
}
/** 收集项目引用的飞书凭据 ID；删除凭据时按它统计引用（随工厂同迁，保持单一出处）。 */
export function feishuCredentialReferences(projects: { project: { feishuCredential?: string } }[]): string[] {
  return projects.flatMap(({ project }) => project.feishuCredential ? [project.feishuCredential] : [])
}
