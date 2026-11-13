# 统一直连 SDK 直连实测（2026-11-13）

用 [../direct-connect.ts](../direct-connect.ts) 的 \`DirectConnect\` 客户端直连正在运行的桌面版
DeepSeek Harness 里已加载的 dsh-superagent，验证端口发现、健康/状态、同源门禁、只读端点与
\`waitReady\`。本脚本**不修改任何设置**（唯一写操作是 DELETE 一个保证不存在的记录，期望 404）。

## 运行

\`\`\`sh
node --experimental-transform-types verification/2026-11-13-direct-connect/run-direct-connect.ts
\`\`\`

前置：桌面版已加载 dsh-superagent 且 \`stateDir/startup.json\` 为 ready。

## 断言

| 步骤 | 断言 |
| --- | --- |
| 1. 端口发现 | \`startup.json\` 有监听端口；健康探针 \`ok: true\` |
| 2. 状态 | \`state\` 返回 \`masterId\` |
| 3. 只读端点 | \`sources\` / \`git-credentials\` / \`queue\` 返回合同形状 |
| 4. waitReady | 已就绪时短超时（5s）内立即返回且端口一致 |
| 5. 只读安全 | DELETE 一个不存在记录得到 404（无副作用） |
| 6. 同源门禁 | 缺 \`x-orchestrator-request\` 或 Host 不符的请求被拒（≥400） |

成功打印 \`DIRECT_CONNECT_LIVE_OK\`，证据写入本目录 \`result.json\`。
