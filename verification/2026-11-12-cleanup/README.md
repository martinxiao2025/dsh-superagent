# 卸载清理实测（2026-11-12）

验证 `scripts/dsh-superagent.mjs clean` 在真实桌面版 DeepSeek Harness 上的完整闭环：
卸载插件并清理全部残留 → 断言检出目录完好 → 从备份还原 profile 并重建目录连接 →
插件重新装载为 ready。全程直连管理 API（`startup.json` 读端口 + `x-orchestrator-request: 1`）。

## 运行

```sh
node --experimental-transform-types verification/2026-11-12-cleanup/run-cleanup.ts
```

前置：桌面版正在运行且加载了 dsh-superagent（`~/.dsh/state/superagent/startup.json` 为
ready）。默认 profile `desktop`（`DSH_PROFILE` 覆盖）、DSH home `~/.dsh`（`DSH_HOME` 覆盖）。

## 步骤与断言

| 步骤 | 断言 |
| --- | --- |
| 1. 前置 | 管理 API `GET health` 可达（宿主对配置变更反应有 30–90 秒延迟，先等回 ready）；profile patch 含 `id: dsh-superagent`；记录 node_modules 链接、状态目录条目与锁 |
| 2. 停止桌面版应用（taskkill 主进程树，等待全部退出）后执行 `clean --yes` | 退出码 0；应用停止后状态锁在 30 秒内成为过期锁，clean 直接完成全部清理（宿主对 patch 变更的监视有 30–90 秒延迟且不稳定，因此不依赖它） |
| 3. 清理结果 | 检出目录关键文件（package.json、src/index.ts、scripts、docs）完好；patch/package.json 无引用；node_modules 链接、状态目录与 `.lock` 均消失；旧端口不再应答；备份目录含 patch 原文 |
| 4. 还原 | 先重建 junction 与依赖清单，最后写回 patch（宿主读到完整一致的层）；随后**正式重装**（`DSH_CLI` 指向 dsh CLI 时运行 `dsh plugin --profile <p> add link:<检出>`——宿主的插件管理器记得 remove，仅还原文件不会重挂载）并重启 runtime 子进程（Windows 上杀死 `--expose-internals` 子进程，Electron 主进程自愈重拉）；300s 内插件恢复 ready（`GET state` 返回 masterId）；还原后 patch 与原文逐字一致 |

成功打印 `CLEANUP_LIVE_OK`，证据写入本目录 `result.json`（各步骤时间戳与 API 回答）。

## 证据

- `result.json`：`outcome=completed` + 每步细节（clean 的完整 stdout、备份路径、还原清单）。
- 人工核对：脚本运行后 `E:\TG_WorkSpace\dsh-superagent` 无任何改动；桌面版侧边栏 Superagent 面板可用。
