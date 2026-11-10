/** 管理 API 的挂载点：在运行时创建之前就挂上 `/orchestrator/api`，初始化失败时不再退化成空体 404。 */
import type { Context } from '@deepseek-ai/cordis'
import { registerHttp, type HttpHost } from './http.ts'
import type { StartupPhase, StartupStatus } from './startup.ts'

/**
 * 管理路由的挂载点：在 `Runtime` 创建之前先登记 `/orchestrator/api`，之后再把可用的运行时挂上去。
 * 初始化失败时取下运行时，健康接口与其余接口改用启动状态回答，而不是让宿主返回空体 404。
 */
export class AdminMount {
  private host: HttpHost | undefined
  private state: StartupStatus
  private readonly disposer: () => void
  constructor(ctx: Context, stateDir: string) {
    this.state = { phase: 'starting', detail: '', stateDir }
    // 用取值函数注册：运行时稍后才创建，初始化失败时健康接口仍可报告阶段与原因。
    this.disposer = registerHttp(ctx, () => this.host, () => this.state)
  }
  /** 挂载可用的运行时；之后管理路由按正常流程处理请求。 */
  attach(host: HttpHost): void { this.host = host }
  /** 运行时初始化失败时取下它，使其余接口返回可诊断的 503 而不是 500。 */
  detach(): void { this.host = undefined }
  /** 更新启动阶段与失败原因；健康接口与 503 响应读取它。 */
  set(status: Partial<StartupStatus> & { phase: StartupPhase }): void { this.state = { ...this.state, ...status } }
  status(): StartupStatus { return this.state }
  /** 卸载管理路由；重复调用安全。 */
  dispose(): void { this.disposer() }
}
