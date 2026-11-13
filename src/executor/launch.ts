/**
 * 工作单元启动：把新接受的任务分配排队、准备工单工作区并把任务分配消息注入工作单元会话。
 * 从 `dsh.ts` 门面拆出；共享状态经由 `WorkerContext` 传入，本模块不持有任何可变状态。
 */
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { latestAssignment, liveTicket, type AssessmentOutcome, type Assignment, type Execution, type Ticket,
  type Trigger } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import { runAsWorker, shellArgv, verifyDirectory } from '../infra/environment.ts'
import { recordTicketSource } from '../infra/worker-sources.ts'
import { materializeWorkspace, removeWorkspace } from '../code-repos/workspace.ts'
import { projectRepoId } from '../projects/kind.ts'
import { executionRoot, projectDirectory, ticketDirectoryName } from '../app/execution-environment.ts'
import { Later } from '../app/effects.ts'
import { batchLine, batchOf, capped, RETRIED, workerSessionId, WorktreeNameSchema } from './format.ts'
import type { WorkerContext } from './dsh.ts'

/** 工作区准备命令的最大运行时长。 */
export const PREPARE_TIMEOUT_MS = 10 * 60_000
/** 工单消息中内联任务分配文本的字符上限；更长的文本通过其资源读取。 */
export const ASSIGNMENT_CHARS = 1500
/**
 * 启动期间工单的工作区准备命令失败时抛出的内部错误。
 * DshExecutor 捕获它并立即把工单标记为失败，而不是自动重试，因为已存在的目录会被视为已准备，
 * 而自动重试会把失败的准备命令在该目录中留下的内容当作已准备的工作区。
 */
export class PrepareFailed extends Error {}
/** 在已校验的英文工作树名称后附加稳定的 12 字符工单 ID 后缀。 */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** 项目名转成执行目录下的一级目录；空名称回退到项目记录 ID。 */
const projectFolderName = (name: string): string => name.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)

/** 构建新接受工单的执行元数据：工单短名（用于分支）、项目名与工单子目录，以及任务分配文本。 */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string, trigger?: Trigger): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  // 项目调度显式给出项目身份与目录名；消息来源的工单仍按来源记录推导。
  const identity = outcome.project?.id ?? projectDirectory(settings, trigger?.source, name)
  const folder = outcome.project ? projectFolderName(outcome.project.name) || outcome.project.id : identity
  const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // 来源触发器与任务分配一同投递，因此 `assignment` 省略触发器文本。
  const assignment = ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()
  // 项目目录保留分组与归属，每张工单再在自己的子目录内执行，同项目并发时互不覆盖。
  const directory = join(executionRoot(settings, stateDir), folder, ticketDirectoryName(ticket.id))
  return { name, project: identity, directory, assignment }
}

/**
 * 以工单的执行环境变量，在工单工作区中运行配置的 `executor.prepare` 命令，然后按工作单元的视角校验该目录。
 * 项目工单会先把项目代码仓库检出到工单目录：worker 必须在真实仓库副本上工作，而不是一个空目录。
 * 准备命令失败会抛出 `PrepareFailed`，不会自动重试；本次创建的工作区会被移除。
 * @throws 当工作区无法创建或准备命令失败时抛出带原因的错误。
 */
export async function prepareDirectory(w: WorkerContext, ticket: Ticket): Promise<void> {
  const { host } = w
  const directory = ticket.execution?.directory ?? ''
  const settings = host.store.settings()
  const basis = ticket.mandate.basis
  const projectId = basis.via === 'scheduled' ? basis.project : undefined
  const project = projectId ? settings.projects[projectId] : undefined
  const repo = projectId ? projectRepoId(projectId) : ''
  const checkout = (args: string[], cwd: string) => host.commands.scope(repo).git(args, cwd)
  await mkdir(dirname(directory), { recursive: true })
  const workspace = repo
    ? await materializeWorkspace({ git: checkout, stateDir: host.machine.stateDir, repo, directory,
      branch: project!.execution.branch, signal: host.lifetime })
    : undefined
  const command = settings.executor.prepare.trim()
  const env = Object.fromEntries(host.environment(ticket).map(variable => [variable.key, variable.value]))
  // 强制超时，使挂起的准备命令（例如在凭据提示上）让工单失败，而不是无限占用工作单元槽位。
  const signal = AbortSignal.any([host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
  if (command) await runAsWorker(host.context.subprocess, shellArgv(command), repo ? directory : dirname(directory), signal, env)
    .catch(async (error: unknown) => {
      // 删除失败的准备命令留下的工作区，以免后续重试把它当作已准备。
      await (workspace === 'created' && repo ? removeWorkspace(checkout, host.machine.stateDir, repo, directory) : rmdir(directory))
        .catch(() => { /* 目录不存在，或保留了命令写入的内容，输出中会说明。 */ })
      throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  await mkdir(directory, { recursive: true })
  await verifyDirectory(directory, host.context.subprocess, host.lifetime)
}

/** 启动失败后把工单标记为失败；工单会等待新的人工输入或显式重试到达。 */
export function launchFailed(w: WorkerContext, ticketId: string, assignmentId: string, error: unknown): void {
  const ticket = w.host.store.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
  w.failed(ticketId, String(error))
}

/** 启动排队的任务分配，除非其工单已结束或期间被更新的任务分配取代。 */
export async function launchQueued(w: WorkerContext, { ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
  const ticket = w.host.store.tickets.get(ticketId)
  const assignment = ticket && latestAssignment(ticket)
  if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
  w.slots.reserve(ticketId, 'launch')
  try { await launch(w, ticket, assignment); w.clearRetries(ticketId, 'launch', assignmentId) }
  catch (error) {
    // 关闭或暂停会把启动重新排队以便恢复，瞬时的网络/提供方错误会退避重试。
    // 失败的准备命令不会自动重试，因为已存在的目录会被视为已准备，重试
    // 会把失败的准备命令在该目录中留下的内容当作已准备的工作区；因此
    // 工单被标记为失败，并等待新的人工输入或显式重试到达。
    if (w.host.closing() || error instanceof Later) throw error
    if (!(error instanceof PrepareFailed) && w.retriesLaunch(ticketId, assignmentId, error)) throw error
    launchFailed(w, ticketId, assignmentId, error)
  } finally { w.slots.free(ticketId) }
}

/** 为已接受的任务分配准备工作区与会话，并把任务分配消息排队进工作单元会话。 */
export async function launch(w: WorkerContext, ticket: Ticket, assignment: Assignment): Promise<void> {
  const { host } = w
  const current = () => {
    if (host.closing()) throw new Error('dsh-superagent is stopping')
    if (host.paused()) throw new Later('Processing is paused')
    const stored = host.store.tickets.get(ticket.id)
    return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
  }
  const source = w.sourceTrigger(ticket)
  const workspace = ticket.execution?.directory ?? ''
  if (!current()) return
  // 工作单元会话的环境变量无法按工单注入；登记目录后，垫片与 git 凭据助手据此选择本工单的来源记录。
  if (source && workspace) await recordTicketSource(host.machine.stateDir, workspace, source.source)
  // 工作区目录只准备一次；已存在的目录视为已准备，包括在 `prepare` 命令出现之前创建的工作树。
  // 每个工单的子目录独立准备，因此同项目的另一张工单不会复用它或覆盖其中内容。
  if (!await stat(workspace).then(() => true, () => false)) {
    await prepareDirectory(w, ticket)
    if (!current()) return
  }
  if (!current()) return
  const sessionId = workerSessionId(ticket.id)
  const agent = await host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')
  if (!current()) return
  // 被本任务分配取代的那个任务分配的后台工作先停止，以免其结束清除本任务分配的消息。
  await w.stopped(ticket.id)
  if (!current()) return
  // 为本任务分配放回的消息可能仍等待在会话中，由重启的取消保留，或跨崩溃持久化；
  // 此时本次启动的消息会把它带入下一步，与随后投递的副本并存：只保留那一个副本。
  for (const id of host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(host.sessions.promptedId(id))
  // 第一条消息承载任务分配和来源触发器；后续任务分配的消息只说明新增内容，除非
  // 会话丢失了第一条，例如有人删除了它。
  const first = `assignment:${ticket.id}`
  const later = ticket.assignments.length > 1
  const told = later && await host.sessions.holds(sessionId, first)
  if (!current()) return
  const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
  const assignmentText = ticket.execution?.assignment ?? ''
  const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
  const card = told || !source ? undefined : await w.triggerCard(ticket, source.id)
  if (!current()) return
  const batch = told ? [] : batchOf(host, ticket).map(batchLine)
  const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
    : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
      ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
      ...(batch.length ? { batch } : {}), ...retried })
  const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
  await host.sessions.prompt(sessionId, requestId, text, 'queue',
    () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
    () => { host.engine.assignmentStarted(ticket.id, assignment.id) })
  host.engine.assignmentStarted(ticket.id, assignment.id)
}
