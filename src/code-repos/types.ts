/** 代码仓库类型目录：只用于克隆与同步；面板渲染表单、服务端字段预检共用同一份声明。 */
import { githubType } from '../sources/github.ts'
import { gitlabType } from '../sources/gitlab.ts'

export const CODE_REPO_TYPES = [githubType, gitlabType]

/** 按类型名取代码仓库类型；未知类型返回 undefined。 */
export const codeRepoType = (kind: string) => CODE_REPO_TYPES.find(type => type.kind === kind)
