/** 初始化问题与健康检查码；英文复用日志与主会话所读取的宿主自身文本。 */
import { SETUP_PROBLEMS } from '../../setup.ts'
import { HEALTH_TEXT } from '../../infra/health.ts'

export const setupHealthText = {
  // 初始化问题与健康检查码；英文复用日志与主会话所读取的宿主自身文本
  'setup.repositoryUnset': ['GitHub 来源没有设置监听的仓库。', SETUP_PROBLEMS.repositoryUnset[1]],
  'setup.foreignFile': ['{file} 不是 dsh-superagent 写入的文件；移走它，或换一个状态目录。', SETUP_PROBLEMS.foreignFile[1]],
  'setup.gitTooOld': ['git 没有读取 dsh-superagent 为 github.com 写的凭据配置；需要 git 2.32 或更新版本。', SETUP_PROBLEMS.gitTooOld[1]],
  'setup.environmentFailed': ['准备智能体的运行环境失败。', SETUP_PROBLEMS.environmentFailed[1]],
  'setup.agentCliUnset': ['没有设置智能体的 GitHub CLI。', SETUP_PROBLEMS.agentCliUnset[1]],
  'setup.agentCliMissing': ['找不到智能体的 GitHub CLI。', SETUP_PROBLEMS.agentCliMissing[1]],
  'setup.agentCliSignedOut': ['智能体的 GitHub CLI 读不到它的账号。', SETUP_PROBLEMS.agentCliSignedOut[1]],
  'setup.agentCliNoAccount': ['智能体的 GitHub CLI 没有报告 GitHub 账号。', SETUP_PROBLEMS.agentCliNoAccount[1]],
  'setup.repositoryUnreadable': ['@{account} 读不到 {repository}。', SETUP_PROBLEMS.repositoryUnreadable[1]],
  'setup.repositoryUnreported': ['智能体的 GitHub CLI 没有返回 {repository}。', SETUP_PROBLEMS.repositoryUnreported[1]],
  'setup.repositoryReadOnly': ['@{account} 没有 {repository} 的推送权限。', SETUP_PROBLEMS.repositoryReadOnly[1]],
  'setup.feishuCliUnset': ['这条飞书来源记录没有填写机器人的 lark-cli。', 'The Feishu Source record names no bot lark-cli.'],
  'setup.gitlabProjectUnset': ['这条 GitLab 来源记录没有填写项目。', 'The GitLab Source record names no project.'],
  'setup.feishuCliFailed': ['机器人的 lark-cli 不可用。', SETUP_PROBLEMS.feishuCliFailed[1]],
  'setup.feishuNoApp': ['机器人的 lark-cli 的 auth status 没有报告应用。', SETUP_PROBLEMS.feishuNoApp[1]],
  'setup.feishuBotNotReady': ['应用 {app} 的机器人身份状态是 {status}；用 lark-cli 配置应用密钥。', SETUP_PROBLEMS.feishuBotNotReady[1]],
  'setup.feishuUserIdentity': ['机器人的 lark-cli 允许用户身份（strict mode 为 {mode}）；按 docs/006-deployment.md 给机器人一份 strict mode 为 bot 的单独配置。', SETUP_PROBLEMS.feishuUserIdentity[1]],
  'setup.feishuNoBot': ['飞书机器人接口没有返回机器人的 open_id。', SETUP_PROBLEMS.feishuNoBot[1]],
  'setup.gitlabCliUnset': ['没有设置智能体的 GitLab CLI。', SETUP_PROBLEMS.gitlabCliUnset[1]],
  'setup.gitlabCliMissing': ['找不到智能体的 GitLab CLI。', SETUP_PROBLEMS.gitlabCliMissing[1]],
  'setup.gitlabCliSignedOut': ['智能体的 GitLab CLI 读不到它的账号。', SETUP_PROBLEMS.gitlabCliSignedOut[1]],
  'setup.gitlabNoAccount': ['智能体的 GitLab CLI 没有报告 GitLab 账号。', SETUP_PROBLEMS.gitlabNoAccount[1]],
  'setup.gitlabProjectUnreadable': ['@{account} 读不到 {project}。', SETUP_PROBLEMS.gitlabProjectUnreadable[1]],
  'setup.gitlabProjectUnreported': ['智能体的 GitLab CLI 没有返回 {project}。', SETUP_PROBLEMS.gitlabProjectUnreported[1]],
  'setup.gitlabReadOnly': ['@{account} 没有 {project} 的 Developer 及以上权限。', SETUP_PROBLEMS.gitlabReadOnly[1]],
  'healthCode.setupPending': ['等待部署检查', HEALTH_TEXT.setupPending],
  'healthCode.sourceOff': ['已关闭', HEALTH_TEXT.sourceOff],
  'healthCode.feishuCliUnset': ['来源已打开，还没有设置机器人的 lark-cli', HEALTH_TEXT.feishuCliUnset],
  'healthCode.feishuBotMissing': ['等待飞书机器人', HEALTH_TEXT.feishuBotMissing],
  'healthCode.pollFailures': ['连续 {count} 次轮询失败，最近一次：{error}', HEALTH_TEXT.pollFailures],
} as const satisfies Record<string, readonly [string, string]>
