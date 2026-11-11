/**
 * 离线重置桌面版插件状态目录（2026-11-11）。
 *
 * 旧版设置把 `codeRepo`/`taskSource` 存成记录引用，与「并入项目」后的内联结构不兼容，
 * 插件启动即失败且管理接口返回 503，面板的 Reset 动作不可用。
 * 这里在桌面版停止后调用插件自己的 `resetState`：先备份整个状态目录，再删除插件拥有的条目。
 *
 * 运行：`node --experimental-transform-types verification/2026-11-11-wizard/reset-state.ts`
 * 前置：DeepSeek Harness 桌面版已退出（状态目录锁随进程释放）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resetState } from '../../src/app/reset.ts'

const stateDir = process.env.DSH_STATE_DIR ?? join(homedir(), '.dsh', 'state', 'superagent')
const report = await resetState({ stateDir })
console.log(JSON.stringify(report, null, 2))
