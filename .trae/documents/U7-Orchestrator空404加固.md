# U7：`/orchestrator` 空 404 加固（根因、加固与桌面观测）

## Context

桌面版（DSH Desktop）偶发 `/orchestrator/api/*` 返回**空体 404**：同一构建、同一配置、先结束全部进程再启动，7 次中 4 次失败，此前一直未定位。客户端 bundle 独立加载，所以侧栏照常显示 Superagent，故障只在服务端。

本单元必须给出**可复现的触发条件或能解释根因的证据**（不能只加日志），并如实记录桌面连续启动 ≥5 次的观测结果；未复现时说明加固有效的证明方式。只做 U7，不进入 U8；提交信息用中文。

## 根因证据（已核实）

1. `@deepseek-ai/dsh-host-webserver` 的匹配顺序是 exact → 最长 prefix → fallback；**fallback 未注册时由它自己 `res.writeHead(404); res.end()`，即空体 404**（`node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js` L350-364）。
2. `src/app/runtime.ts` L89-96：构造 `Runtime` 时先 `mkdirSync(stateDir)`、再 `lockSync(stateDir, { stale: 30_000 })`；`registerHttp` 只在其后 `initialize()` 的第一行执行（L243-245）。`proper-lockfile` 默认 `retries: 0`，**锁新鲜时立即抛 `ELOCKED`**（其 README 与 `lib/lockfile.js` 的 `acquireLock`）。
3. `src/index.ts`：`apply` 先 `new Runtime(...)`，再 `await runtime.ready`。任一步抛错 → `apply` reject → Cordis 卸载插件 effect → `/orchestrator` 前缀从未注册 → **空体 404**；客户端 bundle 不受影响，侧栏仍在。
4. 现场证据：`C:\Users\61054\.dsh\state\superagent.lock` 与 stateDir **同级**存在，运行中实例每约 15 秒刷新其 mtime（实测 12:45:34 仍在刷新）。此前验证只检查了 `state\superagent` 目录内部，所以误判为"无锁"。
5. 复现条件：上一个实例被强杀（`Stop-Process`，Windows 直接 TerminateProcess，不会清理锁）后 **30 秒内**再启动，`lockSync` 立即 `ELOCKED` → 空体 404；≥30 秒后锁过期，启动成功。这与 4 次失败/3 次成功的交替记录一致。
6. 第二个结构性缺陷：`registerHttp` 在 `ctx.webServer.host !== '127.0.0.1'` 时**构造期**抛错；且 `/orchestrator` 前缀 handler 对非 `/orchestrator/api/` 路径自行返回空体 404，遮蔽其它 `/orchestrator/*` 路径。

## 加固设计

原则：**先挂载、后初始化；`apply` 不再 reject；失败可诊断、可自愈。**

### 1. 新增 `src/app/startup.ts`

- `recordStartup(stateDir, entry)`：`mkdirSync` 后写 `stateDir/startup.json`（UTF-8 无 BOM），写前把旧文件转存 `startup.prev.json`；用临时文件 + rename，Windows 先删目标。
- 字段：`at`、`pid`、`phase`、`detail`、`listen { host, port }`、`error { name, message, stack }`（截断）。
- `acquireStateLock(stateDir, options)`：异步循环调用 `lockSync(stateDir, { stale: 30_000 })`，捕获 `code === 'ELOCKED'` 后按间隔重试（默认 1s，总时长 35s，测试可注入更短值）；返回 `StateLock { release(); onCompromised(handler) }`，让取锁发生在 `Runtime` 构造之前，避开 `Runtime extends Service` 在构造期已 `provide('orchestrator')`、无法重复 `new Runtime` 的问题。
- 阶段常量：`http-registered`、`locked`、`store-open`、`ready`、`failed`。

### 2. 新增 `src/app/admin-mount.ts`

`AdminMount`：在 `apply` 一开始就注册 `/orchestrator/api` 前缀并持有可变的 `HttpHost` 与启动状态。

```ts
interface AdminStatus { phase: string; detail: string; error?: { name: string; message: string; stack?: string }; stateDir: string }
class AdminMount {
  constructor(ctx: Context, stateDir: string)   // 立即 registerHttp，保存 disposer
  attach(host: HttpHost): void
  detach(): void
  set(status: Partial<AdminStatus> & { phase: string }): void
  dispose(): void                                // 幂等卸载路由
}
```

### 3. `src/app/http.ts`

- `registerHttp` 增加重载：既支持现有 `(ctx, runtime: HttpHost)`（测试与 Runtime 自挂载），也支持 `(ctx, resolve: () => HttpHost | undefined, diag: () => AdminStatus)`。
- 删除构造期 `host !== '127.0.0.1'` 抛错；改为**请求期**校验回环 Host：`127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>`，并保留 `x-orchestrator-request: 1` 与 Origin 同源校验；非回环返回 403。
- 端口在请求时读取 `ctx.webServer.port`（构造期可能尚未监听）；`GET health` 用它报告 `listen`。
- 前缀从 `/orchestrator` 收窄为 `/orchestrator/api`（DSH 匹配按路径边界，不会误匹配 `/orchestrator/apifoo`），删除"非 API 路径返回空体 404"的分支。
- 无运行时（`resolve()` 返回 undefined）时：
  - `GET health` → **200** `{ ok: false, stage: phase, phase, detail, error, listen, stateDir, sources: [] }`；
  - 其它路由 → **503** `{ error: detail, code: 'startupPending', phase, detail, stateDir }`。
- 有运行时：保持现行为（`await runtime.ready` 后匹配路由）；健康视图追加 `phase`、`detail`、`startup: { path, prevPath }`。

### 4. `src/app/runtime.ts`

- 构造函数增加可选的 `boot?: { mount: AdminMount; lock: StateLock }`：
  - 有 `boot`：不再 `mkdirSync`/`lockSync`，改用 `boot.lock.release`，并把 `compromised` 注册给 `boot.lock.onCompromised`；`initialize()` 改为 `boot.mount.attach(this.httpHost())`，不重复注册路由。
  - 无 `boot`：保持旧行为（自建路由），现有测试夹具零改动。
- `initialize()` 删除 `registerHttp` 分支之外的其它启动步骤不变；`httpHost()` 保持 private（仅在类内传给 mount）。

### 5. `src/index.ts`

顺序（关键）：

1. `machineOf(config)` 保持在最前（旧配置键仍在**注册任何东西之前** reject）。
2. 创建 `AdminMount` + `ctx.effect(() => () => mount.dispose())`，随即记录 `http-registered`。
3. `ctx.inject(['settings'], ...)` 保持现状。
4. `await acquireStateLock(...)`；等待期间 `mount.set({ phase: 'locked', detail })` 并写启动记录（**不逐秒打日志**）。
5. 取锁后 `new Runtime(ctx, machine, restart, { mount, lock })`，记录 `store-open`。
6. `await runtime.ready` → 记录 `ready`（含 `setupProblem` 摘要）；`runtime.startSources(ADAPTERS)`。
7. 上述任一步失败：`mount.detach()`（其它路由转为 503 诊断）、记录 `failed` + 错误栈、`logger.error`，**resolve 而不是 reject**；仅在取锁超时时 phase 保持 `locked`。

`ctx.effect` 注册顺序：先 mount、后 runtime.stop，Cordis 逆序清理，保证先停 runtime、再卸载路由。

### 6. 面板诊断

- `src/client/api.ts`：解析 `code === 'startupPending'` 与 `phase`/`detail`/`stateDir`；空体 404 仍走 `notRunning`，并追加静态诊断提示（指向 `startup.json` 与 `/orchestrator/api/health`）。
- `src/client/provider.tsx`：`ApiMessages` 增加 `startup(phase, detail)`。
- `src/client/locales.ts`：新增 `startupPending`、`startupHint`（中英），并调整 `hostNotRunning` 文案以包含诊断入口。

## 测试

| 文件 | 断言要点 |
| --- | --- |
| `tests/index.spec.ts` | ctx 补 `webServer.register` 与可执行的 `effect`；**先注册后构造**；Runtime 构造抛 `ELOCKED` 时 `apply` resolve、前缀仍在、`GET health` 返回 200 且 `phase === 'locked'|'failed'`、其它路由 503 带 `stateDir`；`runtime.ready` reject 时同样保持挂载；成功路径写 `startup.json` 且第二次写产生 `startup.prev.json`；保留"非法旧配置在注册前 reject"的断言 |
| `tests/http.spec.ts` | 原有 `serve(runtime)` 用例不变；新增：无运行时 health 200 / state 503；`Host: [::1]:3082` 通过、非回环 403；注册路径为 `/orchestrator/api`；听端口在请求期读取 |
| `tests/startup.spec.ts`（新） | `startup.json` 字段与 UTF-8 无 BOM、`startup.prev.json` 轮转、目录自动创建；`acquireStateLock` 在锁新鲜时重试并在超时后抛 `ELOCKED`，释放后可获取 |
| `tests/client.spec.tsx` | 空体 404 文案含诊断提示；503 `{ code: 'startupPending', phase, detail }` 命中新文案 |

现有 `tests/fixtures/host.ts`、`tests/fixtures/panel-server.ts`、`tests/model-surface.spec.ts`、`tests/runtime.spec.ts` 依赖"Runtime 自挂载"，默认路径保持，应零改动；若断言受新增字段影响，用 `toMatchObject` 校验既有字段。

## 桌面验证（如实记录）

1. **复现（加固前构建）**：结束当前运行实例（pid 25676，端口 52618）→ **30 秒内**启动 → `curl -s -o - -w "%{http_code}" -H "x-orchestrator-request: 1" http://127.0.0.1:<port>/orchestrator/api/state` 预期 `404` 且响应体为空；记录 `superagent.lock` 的 mtime 与启动时间差。作为对照，再等 ≥30 秒启动，预期 `200`。
2. **加固后**：同样在强杀后 30 秒内启动，预期 health 立即 `200`（`phase` 为 `locked`/`starting`），锁过期后转为 `ready`；再用脚本创建一个新鲜 `superagent.lock` 后启动，预期 health `200` 且 `phase: 'locked'`，删除锁后自动转为 `ready`（自愈证明）。
3. **连续启动 ≥5 次**：每次记录端口、`/orchestrator/api/health` 状态码与 `phase`、`/orchestrator/api/state` 状态码、`stateDir/startup.json` 与 `startup.prev.json`、侧栏是否可见。结果写入 `verification/2026-11-10-desktop-404.md`，包括"未复现时如何证明加固有效"的说明。

## 文档

- `docs/007-architecture.md`：模块表新增 `src/app/admin-mount.ts`、`src/app/startup.ts`，更新 `index.ts`/`runtime.ts`/`http.ts` 行；测试表新增 `tests/startup.spec.ts`。
- `docs/009-source-records.md` L134-143：把阶段名改为实际值，补取锁重试、200/503 契约。
- `docs/006-deployment.md` 故障排查：空体 404 / 503 / `startup.json` 三条排查路径。
- `.trae/documents/来源记录化与404加固实施方案.md`：U7 条目标记"已完成并验证"，附根因与观测结论。

## 命令与提交

```
pnpm typecheck
pnpm vitest run tests/index.spec.ts tests/http.spec.ts tests/startup.spec.ts tests/client.spec.tsx
pnpm test
pnpm build
```

按具体文件 `git add`（不提交 `.artifacts/`、`.trae/`），中文提交信息：

```
fix: 加固 /orchestrator 管理路由的挂载与启动诊断

把管理 HTTP 前缀改为在插件入口先挂载，初始化失败不再卸载；
状态目录锁竞争时有限重试，失败写入 startup.json 并由健康接口报告；
前缀收窄为 /orchestrator/api，请求期校验回环 Host。
```

## 风险与边界

- `ctx.webServer.port` 在注册时可能尚未赋值：一律请求期读取并允许 `undefined` 回退为 `0`。
- 前缀收窄后 `/orchestrator` 自身交给 SPA fallback；已确认无脚本依赖该路径（脚本只用 `/orchestrator/api/state`）。
- `startup.json` 多进程并发写为 last-wins，记录中带 `pid`，文档写明。
- `registerHttp` 的 duplicate route 冲突无法自愈，只能记录并保留日志。
- 锁重试最长 35 秒；若锁被另一个活动实例持有，保持 `locked` 阶段与 503 诊断，不伪装成就绪。

## 完成情况（2026-11-10）

- **实现**：`src/app/startup.ts`、`src/app/admin-mount.ts` 新增；`src/index.ts` 先挂载后初始化、失败不 reject；`src/app/http.ts` 请求期回环校验、200/503 诊断、前缀收窄；`src/app/runtime.ts` 接受外部 `boot.lock`/`boot.mount`；客户端 503 本地化诊断与空体 404 提示。
- **根因（两条，均有现场证据）**：
  1. 强杀后 30 秒内重启时 `superagent.lock` 仍新鲜 → `ELOCKED` → `Runtime` 构造失败 → `apply` reject → 前缀未注册 → 空体 404。加固前实测：强杀 16:52:09.500，锁 mtime 16:51:57.224，0.86 秒后启动，health/state 均 404 且 body 0 字节。
  2. Windows 桌面版 DSH 的全局工具为 `pwsh`（无 `bash`），而主会话限制固定命名 `bash`，`tools.restrict` 抛 `names unknown global tool "bash"` → 主会话恢复失败 → 同样空体 404。用新增的 `startup.json` 定位；已改为只限制宿主实际提供的 shell，`noWait` 对 `bash`/`pwsh` 同口径（`src/app/sessions.ts`）。
- **桌面观测**：构建 `887D0F30D5A082A6`；连续强杀并立即启动 5 次，全部 health 200 / state 200 / `startup.json` ready / `prev` store-open，其中 4 次等待 15.9–29.9 秒后自愈，等待时间与 `锁 mtime + 30 秒` 误差 < 1 秒；人为新鲜锁 8 秒后删除，`locked` → `ready` 用时 1.2 秒。详见 `verification/2026-11-10-desktop-404.md`。
- **测试**：`pnpm typecheck`、`pnpm test`（1253 passed，0 skipped）、`pnpm build` 均通过。
- **范围说明**：第 2 条根因不属于"只加日志"，但不修则桌面永远到不了 ready，故在本单元一并修正；未进入 U8。
