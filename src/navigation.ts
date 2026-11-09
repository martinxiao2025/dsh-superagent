/** 在确保会话目录已加载后，于工作区中打开一个 DSH 会话。 */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * 当宿主会话目录尚未就绪或未列出目标会话时，由 `openKnownSession` 抛出。
 * 管理面板捕获它以显示本地化的错误消息。
 */
export class SessionNavigationError extends Error {
  constructor(readonly code: 'not-ready' | 'not-listed') { super(code) }
}

/** 一旦目录列出 `id` 就在工作区中选中它，除非先被中止。 */
export async function openKnownSession(sessions: Pick<ISessions, 'list' | 'refresh'>, id: SessionId, open: (id: SessionId) => void, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  if (sessions.list.getSnapshot().phase !== 'ready' || !sessions.list.getSnapshot().byId[id]) await sessions.refresh()
  if (signal.aborted) return false
  const list = sessions.list.getSnapshot()
  if (list.phase !== 'ready') throw new SessionNavigationError('not-ready')
  if (!list.byId[id]) throw new SessionNavigationError('not-listed')
  open(id)
  return true
}
