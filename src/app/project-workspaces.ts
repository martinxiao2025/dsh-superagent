/**
 * 宿主侧的项目归类（M5）：每个启用项目在 DeepSeek Harness 中自动拥有一个 workspace（目录记录），
 * 标题即项目名——宿主侧边栏按 workspace 分组，项目根目录下的人工会话因此自然归类。
 * 工单 workspace（cwd 为各自 worktree）无法并入单一项目 workspace（宿主要求会话 cwd 与 workspace
 * 路径完全相等），改为统一命名「<项目名> · <工单标题>」（`Sessions.ensure`），同项目在宿主列表按前缀聚拢。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { projectDirectoryName } from '../execution-paths.ts'
import { normalizePath } from '../infra/win32.ts'
import type { Store } from './store.ts'

/** 宿主 workspace 注册表的最小结构面；真实实现（`ctx.workspaceRegistry`）与测试桩都按此形状提供。 */
export interface WorkspaceRegistryLike {
  /** 幂等创建：同一路径返回既有记录（`title` 只在首次创建时生效）。 */
  create(path: string, title?: string): Promise<{ id: string; title: string; setTitle(title: string): Promise<void> }>
  get(id: string): { id: string; title: string; path: string; setTitle(title: string): Promise<void> } | undefined
  list(): { id: string; path: string }[]
  delete(id: string): Promise<void>
}
/** `ProjectWorkspaces` 使用的宿主依赖。 */
export interface ProjectWorkspacesHost {
  readonly registry: WorkspaceRegistryLike
  readonly store: Pick<Store, 'projects' | 'tickets' | 'triggers'>
  /** 项目工单目录的根：项目 workspace 建在其下的项目目录上。 */
  readonly workRoot: string
}
/** 项目 workspace 归类：建立（幂等）、改名同步、注销与按路径遗忘；全部失败不阻塞项目写路径（由调用方告警）。 */
export class ProjectWorkspaces {
  constructor(private readonly host: ProjectWorkspacesHost) {}
  /**
   * 项目启用或改名时同步宿主 workspace：幂等建立（项目 ID 洗成目录名，建在 `workRoot` 下）、
   * 项目改名时同步标题，并把 workspace id 写回项目记录（`hostWorkspaceId`）。
   * @throws 当目录无法创建或宿主注册表拒绝时抛出；调用方决定是否阻塞保存。
   */
  async sync(projectId: string): Promise<void> {
    const project = this.host.store.projects.get(projectId)
    if (!project?.enabled) return
    const path = join(this.host.workRoot, projectDirectoryName(projectId))
    mkdirSync(path, { recursive: true })
    const stored = project.hostWorkspaceId ? this.host.registry.get(project.hostWorkspaceId) : undefined
    if (!stored) {
      const created = await this.host.registry.create(path, project.name)
      this.host.store.projects.save(projectId, { ...project, hostWorkspaceId: created.id })
      return
    }
    if (stored.title !== project.name) await stored.setTitle(project.name)
  }
  /** 项目删除时注销其宿主 workspace：目录与工单会话日志都保留，仅移除分组节点。 */
  async remove(projectId: string): Promise<void> {
    const id = this.host.store.projects.get(projectId)?.hostWorkspaceId
    if (id) { await this.host.registry.delete(id); return }
    // 项目记录已被先删（removeProject 的写路径顺序）：按项目目录路径遗忘。
    await this.forgetPath(join(this.host.workRoot, projectDirectoryName(projectId)))
  }
  /**
   * 工单工作区回收后注销路径匹配的 workspace：工单目录已删，分组节点不能残留为失效目录。
   * 归一化路径比较（win32 大小写不敏感）；找不到匹配的 workspace 时为空操作。
   */
  async forgetPath(directory: string): Promise<void> {
    const path = normalizePath(directory)
    for (const workspace of this.host.registry.list()) {
      if (normalizePath(workspace.path) !== path) continue
      await this.host.registry.delete(workspace.id).catch(() => { /* 已被并发的回收或人工删除。 */ })
    }
  }
}
