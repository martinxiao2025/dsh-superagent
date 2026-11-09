# Desktop run on Windows: what was observed

Date: 2026-11-09, Asia/Shanghai. Repository `D:\dsh-superagent`, commit before this record: `fb54430`
(`fix: run the bundle on Windows`). Nothing here was pushed at the time of writing.

This record separates **observed on the desktop app** from **not verified**. Every observed value can be
rechecked from the command or file named next to it.

## Clean start

Record: `cleanup-20261109-223303.json` (kept outside git, with the run artifacts).

- Renamed `C:\Users\61054\.dsh\sessions` to `sessions.cleared-20261109-223303`; `state\superagent` did not
  exist yet.
- Deleted `Cache`, `Code Cache`, `GPUCache`, `GPUPersistentCache`, `GrShaderCache`, `Dawn*`, `ShaderCache`,
  `Shared Dictionary` under `%APPDATA%\@deepseek-ai\dsh-desktop`.
- Configuration and credentials were not touched.

## Start-up

- Main process `DeepSeek Harness.exe` pid 11716, start time 22:37:39; four child processes at 22:37:40
  (pids 16224, 18608, 44148, 52576). Observed with `Get-Process`.
- Log `.artifacts\desktop-20261109-224200.out.log` line 4: `dsh web: http://127.0.0.1:51056/?token=…`.

## Configuration and the deployment check

Desktop profile `C:\Users\61054\.dsh\profiles\desktop` (originals kept in `.artifacts\desktop-profile-backup`):

- `dependencies` gained `"dsh-superagent": "link:D:\\dsh-superagent"` and `bundles` gained `"dsh-superagent"`.
  pnpm cannot resolve a cross-drive `link:` (it produced `…\desktop\D:\dsh-superagent`), so `node_modules\dsh-superagent`
  is a directory junction to `D:\dsh-superagent`.
- `cordis.patch.yml` gained the plugin with `stateDir: C:/Users/61054/.dsh/state/superagent`.

Settings › 来源 (GitHub card) was filled with repository `martinxiao2025/dsh-superagent` and CLI
`C:\Users\61054\AppData\Local\Programs\GitHub CLI\gh.exe`. Saving ran the deployment check and the card showed
this text verbatim:

```
智能体的 GitHub CLI 读不到它的账号。 gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.
```

That message is `gh`'s own text, so the check resolved `gh.exe`, ran it through the worker subprocess and read
its output — the Windows code path of step 1 exercised in the real app.

Policy: `martinxiao2025` added under 设置 › 评估 › 能发起工作的 GitHub 账号, saved. Policy version changed
`9fbbf9a0` → `1895d28f`, and the overview count went from "系统问题 2" to "系统问题 1" ("没有人能发起工作…" disappeared).
The remaining problem is the deployment check above; the executor shows 执行器等待部署检查.

## A real turn, its tool call, and the artifact

A new session in the desktop app, model DeepSeek-V4.1-Flash (reasoning High), prompt: create
`ok.txt` under `C:\Users\61054\AppData\Local\Temp\dsh-harness-probe` with content `harness-ok` and report the path.

- Session `738a4b6d-6961-4766-826d-2fe8d5599bd9`; turn finished in 3 s, "1 轮 3 步 · 278 tok/s", 34.4K tokens.
- 轨迹 tab: `工具，write {"file_path": "C:\Users\61054\AppData\Local\Temp\dsh-harness-probe\ok.txt", "content": "harness-ok\n"}`.
- Filesystem check: `Length=11`, `CreationTime=2026/11/9 22:41:45`, content `harness-ok`.

This proves the harness layer on the desktop (model connectivity, one turn, a tool call, a product on disk). It is
not a bundle turn: no source trigger, ticket or executor worker was involved.

## Not verified

- Deployment check passing; executor leaving 执行器等待部署检查.
- A real GitHub trigger → admission → ticket → executor worker session.
- The executor's product location under `C:\Users\61054\.dsh\state\superagent`.

Blocked at the interactive `gh auth login` of the agent account. `docs/006-deployment.md` says setup removes
environment variables whose names contain TOKEN, so `GH_TOKEN` cannot stand in for the login either.
