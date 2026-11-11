# 设置信息架构复盘与目标方案（定稿建议）

> **已废弃：本文已合并进 docs/013-authoritative-project-design.md，冲突时以 013 为准。**
> **保留原因：保留设置分区复盘、方案比较与双凭据独立设计的完整推导过程。**
> 状态：设计稿（含 2026-11-11 知识库项目专属、Git/飞书双凭据修订），本轮未改代码、未提交。
> 范围：设置面板中的「来源」「代码仓库」「任务来源」「项目」四个分区，以及项目配置的目标形态。
> 关系：本文修订并取代 [011-projects-and-scheduling.md](011-projects-and-scheduling.md) 中的 D4（任务来源作为独立记录被项目引用）与 D7（设置页拆出「代码仓库」「任务来源」两组）。D1（项目与仓库一对一）、D2（同项目串行）、D3（全局 worker 上限）继续有效。
> 主线：项目是唯一的配置与运行单元；一个项目表单内完成项目名称、启停、执行目录、仓库地址与分支、任务来源、轮询时间的设定；凭据页面中的敏感字段（SSH 私钥、HTTPS 令牌、飞书 App Secret）必须带「测试」按钮，能真实发起校验并就地反馈。
> 关键约束：**每个项目一个知识库（飞书知识空间）**，知识库（空间）、节点链接、字段映射都属于项目，且一个知识库只能绑定一个项目；**Git 凭据与飞书凭据各自独立**，分别有独立的 schema、存储、掩码、测试、轮换与删除保护，不合并为通用「凭据」类型。项目只保存 Git 凭据与飞书凭据的引用，不直接存密钥/令牌；仓库地址与分支、知识库绑定仍在项目里。

## 0. 结论摘要

1. 现在四个分区不是四类并列对象，而是「一条配置链被拆成四段」：消息来源（飞书）→ 代码仓库 → 任务来源 → 项目。拆开后又用记录 ID 互相引用，于是同一个概念在 2–3 个地方各存一份，靠保存时的一致性校验兜底；认证材料则完全埋在代码仓库或飞书来源记录里，无法独立管理。
2. 「来源」现在只剩飞书一种记录（[adapters.ts:1-5](../src/sources/adapters.ts#L1-L5)），GitHub / GitLab 已并入 `codeRepos`（当前只保留这一基线，旧库需 `reset`）。继续把「来源」作为与「代码仓库」「任务来源」并列的一级分区，语义已经名不副实。
3. 布局问题的根因是「设置」同时承担了导航、配置、运行状态三种职责：顶部已有「来源」「项目」页签，设置里又各有一份；列表与编辑是同一张卡片的内联展开；保存、验证、启停、删除四种动作分散在卡片的不同位置；任务来源甚至没有编辑入口。
4. 推荐 **方案 B：项目内联为主 + 双凭据独立 + 高级复用库**。
   - 代码仓库与任务来源默认内联进项目表单，不再作为主设置分区。
   - 新增两个互不影响的凭据分区：**Git 凭据**（SSH 私钥 / HTTPS 令牌）与**飞书凭据**（应用 ID / Secret / 身份模式）。两者独立存储、独立掩码、独立测试与轮换，不抽象成通用凭据。
   - 项目只选择 Git 凭据与飞书凭据（各一个引用）；仓库地址与分支、知识库（空间）与节点仍在项目里。
   - 知识库（空间）项目专属，每个项目必须且只能绑定一个，同一知识库不能绑定到两个项目；飞书凭据可以跨项目复用。
   - 任务来源在项目内二选一：Excel 或飞书知识库，不能同时存在。
   - 飞书消息接入归入飞书凭据详情，不再单独维护一套应用凭据；设置中保留一个只读的「高级 / 复用库」。
   - 队列与运行状态放在「项目详情」和「工单」页，不放设置。

## 1. 现状盘点

### 1.1 入口拓扑

顶栏页签（[route.ts:7](../src/client/route.ts#L7)）：概览、来源、项目、线程、评估、工单、设置。

设置内导航（[settings.tsx:15](../src/client/settings.tsx#L15)、[settings.tsx:32-43](../src/client/settings.tsx#L32-L43)）：来源、代码仓库、任务来源、项目、评估、执行、提示词、部署。前六项带 `data-stage`，只靠 CSS 的上边距与后两项分开（[client.css:315-333](../src/client/client.css#L315-L333)），没有分组标题或二级导航。

同一份设置数据由 `settingsView` 一次性下发（[settings.ts:26-66](../src/app/views/settings.ts#L26-L66)）：`kinds`、`sources`、`codeRepoKinds`、`codeRepos`、`taskSourceKinds`、`taskSources`、`projects`，以及 `blocks` 与执行环境。

### 1.2 四个分区各自承载什么

| 分区 | 入口与组件 | 数据与保存 | 当前字段 | 当前操作 |
| --- | --- | --- | --- | --- |
| 来源 | 顶部「来源」页签是运行状态（[app.tsx:151](../src/client/app.tsx#L151)、[source.tsx:264-278](../src/client/source.tsx#L264-L278)）；设置 →「来源」是配置卡片（[source.tsx:183-191](../src/client/source.tsx#L183-L191)） | `settings.sources`，块 `source:<id>`，新建会重启插件 | 飞书：名称、启用、实例地址、机器人 `lark-cli`、接收的群、其他群、私聊；高级：每页消息数、链接超时；策略：可发起工作的用户、同步群、候选机器人（[feishu.ts:36-90](../src/sources/feishu.ts#L36-L90)） | 新增、编辑、删除、启停、逐字段验证、全部验证、刷新群名、策略同步、丢弃消息查看 |
| 代码仓库 | 设置 →「代码仓库」 | `settings.codeRepos`，块 `codeRepo:<id>` | 名称、启用、类型；配置：实例地址、认证方式、仓库、自定义远端（高级）、SSH 私钥路径（高级）、CLI（[github.ts:15-31](../src/sources/github.ts#L15-L31)） | 新增、编辑、删除、启停、逐字段验证、全部验证 |
| 任务来源 | 设置 →「项目」内嵌编辑（[projects.tsx](../src/client/projects.tsx)） | `settings.projects[].taskSource`，类型与配置随项目保存 | Excel：清单文件、工作表、编号/标题/描述/状态/优先级列（[excel.ts:26-38](../src/task-sources/excel.ts#L26-L38)）；飞书知识库：知识库链接、五个列字段（[feishu-wiki.ts:18-27](../src/task-sources/feishu-wiki.ts#L18-L27)） | 新建/编辑项目时逐字段验证；仓库位置与飞书凭据由项目注入 |
| 项目 | 顶部「项目」页签是运行时列表与详情（[projects.tsx:14-89](../src/client/projects.tsx#L14-L89)）；设置 →「项目」是配置卡片（[projects.tsx:92-257](../src/client/projects.tsx#L92-L257)） | `settings.projects`，块 `project:<id>`，`.strict()`（[kind.ts:8-34](../src/projects/kind.ts#L8-L34)） | 名称、启用、`codeRepo` ID、`taskSource` ID、执行目录、分支、轮询分钟、启动即跑、最大重试、退避秒数、待处理状态、完成状态、失败状态 | 新增（只填名称 + 选两个已有记录）、编辑、删除；启停要进编辑表单才能改 |

### 1.3 重复与概念重叠

| 概念 | 出现位置 | 重复方式与后果 |
| --- | --- | --- |
| 记录的名称 / 启用 / 删除 / 保存 | 四个分区各一套卡片与 `SaveBar` | 四套几乎相同的交互各自实现；启用开关的位置还不一致（来源在卡片头，代码仓库与项目在表单内）。 |
| 仓库 | `codeRepos` 记录、`project.codeRepo`、`taskSources.excel.config.repo` | 同一个仓库被引用三次；保存项目或任务来源时用 `checkRepoBinding` 强制「任务来源的仓库必须等于项目的仓库」（[settings.ts:355-370](../src/app/settings.ts#L355-L370)）。这是用校验弥补模型重复。 |
| 仓库地址与分支 | 地址在代码仓库配置（`repository` / `remote`），分支在 `project.execution.branch` | 一个「仓库 + 分支」的完整概念被拆到两个分区，新建项目时必须先建仓库记录、再回项目里填分支。 |
| 执行目录 | 全局 `executor.directory` 与 `project.execution.directory` | 全局默认值与项目覆盖值分处「执行」和「项目」两个分区，项目表单只显示覆盖值，用户看不到最终生效值。 |
| Git 认证材料 | `codeRepos.config` 的 `auth` / `sshKey` / `cli`，项目只引用 `codeRepo` | 认证材料藏在代码仓库记录里，无法跨仓库复用；SSH 路径与 HTTPS 智能体凭据没有统一的独立管理，也没有轮换、引用保护与独立测试。 |
| 飞书应用凭据 | `sources` 的飞书记录、`taskSources.feishu-wiki.config.source` | 飞书记录同时是「消息来源」和「读文档的应用身份」；任务来源只存一个字符串引用，界面上没有说明这层耦合。凭据应独立管理，读哪个知识库由项目决定。 |
| 知识库 | `taskSources.feishu-wiki.config.url` 与可复用的任务来源记录 | 任务来源是一条可复用记录，两个项目引用同一条记录就隐式共享同一个知识库；新约束要求知识库（空间）为项目专属，且一个知识库只能属于一个项目。 |
| 「来源」这个词 | 消息来源、任务来源、代码仓库在代码里都叫 source | 界面用「来源 / 任务来源 / 代码仓库」三个词区分，但三者都是「外部输入配置」，用户难以判断该去哪个分区。 |
| 队列与运行状态 | 顶部项目列表、项目详情、工单页、概览 | 没有独立队列页；状态分散在多处，设置中的项目启停又会直接影响队列，但设置页不显示任何队列后果。 |

### 1.4 迁移留下的历史痕迹

- 历史上 GitHub / GitLab 已从 `sources` 搬到 `codeRepos`，pipeline 记录直接删除（该迁移随基线收敛移除，旧库需 `reset`）。所以「来源」分区的类型目录现在只剩飞书，但导航名称仍是宽泛的「来源」。
- `CodeRepoRecordSchema` 只约束外壳，配置由类型 schema 决定（[code-repos/kind.ts:8-18](../src/code-repos/kind.ts#L8-L18)）；代码仓库没有分支字段，分支只能落在项目上。
- 任务来源记录有 `enabled`，但面板既不显示也不能改，只有新增与删除。

## 2. 布局问题的具体表现

1. **同名双层入口**：顶部「来源」是状态，设置「来源」是配置；顶部「项目」是运行时，设置「项目」是配置。用户点两个同名入口看到完全不同的内容，且没有面包屑说明「你在哪一层」。
2. **导航没有层级**：八个设置项平铺，前六项与「提示词」「部署」只差 10px 上边距，没有「Git 凭据 / 飞书凭据 / 项目 / 系统」这类分组标题，也没有二级导航。移动端直接换成换行按钮，层级信息完全丢失。
3. **列表与详情关系混乱**：项目有独立的详情页（任务队列），但项目配置只能在内联卡片里展开；代码仓库与任务来源没有详情页，只有卡片；任务来源连编辑都没有。用户无法在一个页面同时看到「配置」与「它现在跑成什么样」。
4. **保存与验证位置不统一**：`SaveBar` 在每个卡片底部（[source.tsx:179](../src/client/source.tsx#L179)、[projects.tsx](../src/client/projects.tsx)），「全部验证」在表单中部，逐字段验证按钮贴在输入框右侧；`VerifyRow` 在多个文件里各写了一遍（[source.tsx:20-31](../src/client/source.tsx#L20-L31)、`code-repos.tsx`、`task-sources.tsx`，后两者已删除）。同一动作在不同分区的视觉位置与反馈方式不一致。
5. **动作位置不一致**：来源的启停与删除在卡片头（[source.tsx:154-163](../src/client/source.tsx#L154-L163)），代码仓库的启停与删除原先在 `code-repos.tsx` 内（已删除，并入项目卡片），项目的启停也在表单里（[projects.tsx](../src/client/projects.tsx)）。停用项目要「编辑 → 关开关 → 保存」三步。
6. **危险操作确认不足**：删除都有 `ConfirmButton`，但停用项目的后果没有任何提示；来源停用会结束未完成工单，只有来源卡片有这段说明（[source.tsx:129-144](../src/client/source.tsx#L129-L144)）。项目停用后队列里已有任务如何处理，界面完全没写。
7. **空状态无下一步**：没有项目时只有一句提示；新增项目表单检测到没有仓库或任务来源时只显示两行文字（[projects.tsx:124-125](../src/client/projects.tsx#L124-L125)），没有跳转去创建或「在项目内直接创建」的入口。
8. **验证结果没有汇总**：逐字段结果就地显示，但「全部验证」只把结果合并进同一个字典，没有任何「几项失败、是否阻止保存」的汇总；保存也不要求验证通过。
9. **敏感字段没有保护**：`settingsView` 直接下发 `config`（[settings.ts:44-66](../src/app/views/settings.ts#L44-L66)），面板原样渲染。现在 SSH 只存路径，问题不大；一旦允许粘贴私钥或令牌，这种下发方式会直接把秘密送到前端与日志。
10. **启停语义与界面不一致**：项目卡片只显示一个「停用」标签（[projects.tsx:158](../src/client/projects.tsx#L158)），但运行实测发现停用并不能阻止已排队任务被领取（见附录 A）。界面表达的是「停了」，运行时表达的是「不再生成新任务，但队列照跑」。
11. **队列缺少操作面**：项目详情只有一张只读表格，没有停止、重试、取消排队；全局只有工单页的暂停/恢复（[execution.tsx:20-37](../src/client/execution.tsx#L20-L37)）。队列异常时只能在设置外绕路。
12. **深链不完整**：来源有 `?source=` 定位（[source.tsx:183-185](../src/client/source.tsx#L183-L185)），代码仓库、任务来源、项目没有对应深链；从工单或队列发现配置问题后无法直接跳到对应字段。

## 3. 目标形态（硬约束）

项目表单必须能一站式设定以下内容，不需要先去别的分区建记录：

| 组 | 字段 | 说明 |
| --- | --- | --- |
| 基本信息 | 项目名称、状态（启用/停用） | 名称即项目 ID 的显示名；状态可直接切换并保存。 |
| 代码仓库 | 类型（GitHub/GitLab）、仓库地址、分支、Git 凭据 | 仓库地址与分支在项目内；Git 凭据只选择引用，不填私钥/令牌。 |
| 任务来源 | 类型二选一（Excel / 飞书知识库）、位置、字段映射、飞书凭据（仅知识库） | Excel 的仓库固定为本项目仓库，只填相对路径；飞书知识库选择飞书凭据，并绑定项目专属知识库（空间）与节点。两种类型不能同时存在。 |
| 执行 | 执行目录、轮询分钟、启动即跑 | 执行目录留空表示 `<stateDir>/work` 下的默认目录。 |
| 高级 | 最大重试、退避秒数、任务状态策略 | 默认折叠，保留现有语义。 |

任务来源与凭据约束：

- **二选一**：每个项目只能有一种任务来源，`kind` 为 `excel` 或 `feishu-wiki`，不提供「两者同时轮询」的第三种状态。
- **知识库必填且唯一**：选择飞书知识库时，必须绑定一个知识库（飞书知识空间）和一个属于该空间的节点链接；同一知识库不能被两个项目绑定。
- **凭据只存引用**：项目保存 `gitCredential` 与 `feishuCredential` 两个独立引用；Git 凭据指向 `git-credentials` 记录，飞书凭据指向 `feishu-credentials` 记录，项目负载里没有密钥或令牌。
- **各自匹配**：Git 凭据的协议必须与仓库地址一致（SSH 私钥配 SSH 地址，HTTPS 令牌配 HTTPS 地址）；飞书凭据只用于飞书知识库任务来源，Excel 项目不选飞书凭据。
- **互不替代**：Git 凭据与飞书凭据是两套独立功能，不能用一个代替另一个，也不存在通用的「凭据」记录。

凭据字段规则（只作用于两个凭据页面，不进入项目表单）：

- SSH 私钥、HTTPS 令牌、飞书 App Secret 只存在于 Git 凭据或飞书凭据的编辑表单；保存后只显示掩码与指纹。
- 每个凭据有自己的「测试」按钮；项目里只对「已选凭据」发起测试，不在项目内输入或回显秘密。
- 测试使用已保存的凭据或凭据表单草稿；测试过程不得把秘密写入项目负载、设置快照或日志。

## 4. 方案比较与推荐

### 4.1 方案 A：全部内联，删除独立记录

**信息架构**：设置只剩「项目、Git 凭据、飞书凭据、系统」。`codeRepos` 与 `taskSources` 从设置与数据模型中删除，项目内直接持有 `repository` 与 `taskSource` 对象；Git 凭据与飞书凭据仍是两个独立分区。

**数据模型**：`ProjectSchema` 增加内联对象，删除 `codeRepo` / `taskSource` 两个 ID 字段；项目只保存 `repository.gitCredential` 与 `taskSource.feishuCredential` 两个引用；知识库（空间）、节点与字段映射作为任务来源的内联字段；`checkRepoBinding` 随之删除。

**迁移成本**：中等。一次性把每条项目的引用复制成内联对象，共享同一仓库的多个项目各存一份；飞书知识库项目不复制绑定，统一转为待重绑；面板与 API 需要同时改，但不需要兼容旧结构。

**优点**：概念最少，入口唯一，完全满足一站式目标；不会出现「改了仓库记录影响多个项目」的隐式耦合；凭据仍可独立复用与轮换。

**缺点**：失去仓库与任务来源的复用；同一仓库多项目时地址与分支重复填写；飞书消息接入仍需独立位置，方案 A 的「只剩项目」并不彻底。

### 4.2 方案 B：项目内联为主 + Git/飞书双凭据独立 + 高级复用库（推荐）

**信息架构**：

- 设置一级分组改为四段：
  - **Git 凭据**：独立页面、独立列表、独立表单，只管理 SSH 私钥与 HTTPS 令牌。
  - **飞书凭据**：独立页面、独立列表、独立表单，只管理应用 ID / Secret / 身份模式；飞书消息接入作为该凭据详情的第二个标签。
  - **项目**：唯一的业务配置入口，列表 + 详情；项目表单内联仓库与任务来源，只选择两个凭据引用。
  - **系统**：评估、执行、提示词、部署。
- 设置中不再出现「代码仓库」「任务来源」两个主入口，也不出现统一的「凭据」总入口。历史记录降级到「系统 → 高级 → 复用库」，只读展示，可执行「复制为项目草稿」或「删除」，不能直接被项目引用。
- 顶部页签中的「来源」改名为「飞书凭据」（或移除，状态并入飞书凭据页与概览）；「项目」保留，作为运行与配置的统一入口。

**数据模型**：

```ts
ProjectSchema = {
  name, enabled,
  repository: { kind: 'github'|'gitlab', repository, branch, remote?, gitCredential: string },
  taskSource:
    | { kind: 'excel', config: { file, sheet, columns }, fieldMap }
    | { kind: 'feishu-wiki', feishuCredential: string,
        knowledgeBase: { spaceId, name? }, node: { url, token }, fieldMap },
  execution: { directory },
  schedule: { intervalMinutes, runOnStart },
  retry: { maxRetries, retryBackoffSeconds },
  taskPolicy: { pendingStatuses, doneStatus, failedStatus },
}
```

- `gitCredential` 与 `feishuCredential` 分别引用两张独立表，互不感知；项目负载里没有秘密。
- `taskSource` 是判别联合，`kind` 只能二选一；同一项目不能同时配置 Excel 与知识库。
- `taskSource.config.repo` 删除：Excel 清单固定从项目仓库读取。
- 飞书知识库的 `knowledgeBase.spaceId` 是项目专属绑定，`node` 必须是该空间内的节点；知识库不随飞书凭据复用。
- 服务端维护 `spaceId → projectId` 的唯一索引（含停用项目），保存项目时校验；不依赖界面自觉。
- 复用库只是模板来源，运行时不再被引用；需要复用时复制成项目内联配置，并重新走知识库归属校验。

**迁移成本**：中等偏低。一次性把 `codeRepos` 的认证材料拆成 Git 凭据、把飞书来源拆成飞书凭据；项目内联仓库与 Excel 任务来源，飞书知识库统一转为待重绑；随后删除两个映射表与相关 API/面板。

**优点**：满足一站式目标；两套凭据各自独立演进，互不影响；凭据可跨项目复用，轮换与删除保护各自实现；知识库仍保持项目专属。

**缺点**：页面数量增加；需要一次数据迁移与两套凭据面板；高级复用库如果不做好说明，仍可能被误认为主入口。

### 4.3 方案 C：只整理导航，保留四个分区

**信息架构**：保留现有四类记录，只做分组标题、合并「来源」双层入口、给任务来源补编辑、把项目启停提到卡片头。

**数据模型**：不变；Git 认证材料仍藏在 `codeRepos.config`，飞书应用凭据仍藏在 `sources`。

**迁移成本**：最低。

**优点**：风险小，能快速缓解「看起来重复」和「找不到编辑」的问题。

**缺点**：不满足「项目表单一站式设定」的硬约束；仓库、任务来源、项目之间仍是三段式创建流程；`checkRepoBinding` 这类补偿性校验继续存在；Git 与飞书凭据仍无法独立轮换、独立测试和独立引用保护。

### 4.4 对比与推荐

| 维度 | A 全内联 | B 内联 + 双凭据 + 复用库 | C 仅整理 |
| --- | --- | --- | --- |
| 一站式项目表单 | 满足 | 满足 | 不满足 |
| 项目专属知识库（一个项目一个知识库） | 满足 | 满足 | 不满足 |
| Git / 飞书凭据独立 | 满足 | 满足 | 不满足 |
| 飞书消息接入归属 | 仍需独立位置，模型不彻底 | 飞书凭据详情内，边界清楚 | 维持现状 |
| 概念重复 | 最少 | 少 | 多 |
| 复用同一仓库/任务来源 | 不支持 | 以模板复制支持 | 支持但入口重复 |
| 数据迁移 | 中 | 中 | 无 |
| 面板改造量 | 大 | 大 | 小 |
| 主要风险 | 仓库/任务来源重复填写；飞书消息接入无处安放 | 页面数量增加；复用库被误当主入口 | 目标形态无法达成 |

**推荐方案 B**。理由：它同时满足「项目一站式」「两个凭据各自独立」「知识库项目专属」三个事实；用「复用库 + 复制」替代仓库/任务来源的运行时引用，既保留复用能力，又消除三处存同一仓库的重复；迁移路径清晰，且不需要向后兼容。

## 5. 推荐方案的信息架构

### 5.1 顶层与设置导航

- 顶层：概览、项目、线程、工单、评估、设置。移除独立的「来源」页签；飞书凭据健康与消息接入状态进入「设置 → 飞书凭据」与概览卡片。
- 设置：
  - **Git 凭据**：独立页面、独立列表、独立表单，只管理 SSH 私钥与 HTTPS 令牌。
  - **飞书凭据**：独立页面、独立列表、独立表单，只管理应用 ID / Secret / 身份模式；详情内分「应用身份」与「消息接入」两个标签。
  - **项目**：项目列表与详情。
  - **系统**：评估、执行、提示词、部署。
  - **高级**：复用库（只读历史记录）、配置历史。
- 不设统一的「凭据」总入口，不共用列表页或表单组件；两个凭据页面之间没有互相跳转，也没有「类型切换」。

导航使用带标题的分组，而不是靠间距暗示层级；每个分组内保持单层列表，避免出现第三级。

### 5.2 飞书消息接入放在哪里

放在「设置 → 飞书凭据 → 某个凭据详情 → 消息接入」。理由：

- 消息接收与读知识库使用同一个飞书应用身份，应用 ID / Secret / 身份模式属于飞书凭据本身。
- 一个飞书凭据可以被多个项目复用，也可以承载一个机器人的消息接入配置；项目只选择凭据引用。
- 知识库（空间）与节点仍归项目，不随飞书凭据或消息接入复用。

边界：

- 飞书凭据页保存应用 ID、Secret、身份模式（应用身份 / CLI 身份）以及可选的群、私聊、候选机器人、准入策略；不保存知识库、节点或字段映射。
- 项目绑定知识库时只选择「用哪个飞书凭据读」，读哪个空间、哪个节点由项目自己决定。
- 飞书凭据详情与 Git 凭据详情是两套独立实现，不共用字段、校验、测试路由或错误码。

飞书凭据页保留现有消息能力：接收群、其他群、私聊、允许的用户、候选机器人、同步群、健康与丢弃消息。

### 5.3 代码仓库与任务来源如何内联

项目表单内联，不再要求先建记录。分组顺序：

1. **基本信息**：项目名称、启用开关。
2. **代码仓库**：类型（GitHub / GitLab）、仓库地址、分支、**Git 凭据**（下拉，只选引用）；高级折叠：自定义远端。项目内没有私钥、令牌或 CLI 输入。
3. **任务来源**：类型分段选择（Excel / 飞书知识库），**二选一**。
   - Excel：清单文件（仓库内相对路径）、工作表（高级）、字段映射（编号/标题/描述/状态/优先级，折叠）。仓库固定为本项目仓库，只读显示，不允许另选。
   - 飞书知识库：**飞书凭据**（下拉，只选引用）、**知识库（空间）绑定**（必填、项目唯一）、知识库节点链接（必须是该空间内的节点）、字段映射（折叠）。
   - 切换类型时清空另一侧的配置，并提示「保存后将按新类型轮询」；如果项目已有排队或运行中的任务，先确认再切换。
4. **执行与调度**：执行目录、轮询分钟、启动即跑。
5. **高级**：最大重试、退避秒数、待处理状态、完成状态、失败状态。
6. **危险区**：删除项目。

仓库组与任务来源组的「测试」只针对已选凭据发起：Git 测试用所选 Git 凭据真实访问项目仓库；飞书测试用所选飞书凭据真实读取项目绑定的知识库。两者各自调用独立接口、返回独立错误码，不共用验证逻辑。Excel 的测试会先同步项目仓库工作副本，再读取清单并回报行数；字段映射的测试只校验列名非空。

#### 5.3.1 Git 凭据与飞书凭据：完全独立的两套功能

**总体边界**：Git 凭据与飞书凭据不共用实体、表、schema、路由、服务端模块、前端页面、表单组件、错误码或文案命名空间；唯一共用的只有底层加密存储与掩码工具。

| 维度 | Git 凭据 | 飞书凭据 |
| --- | --- | --- |
| 数据表 | `git_credentials` | `feishu_credentials` |
| schema | `GitCredentialSchema` | `FeishuCredentialSchema` |
| 服务端目录 | `src/git-credentials/` | `src/feishu-credentials/` |
| HTTP 路由 | `/git-credentials/*` | `/feishu-credentials/*` |
| 前端页面/组件 | `src/client/git-credentials.tsx` 及独立表单 | `src/client/feishu-credentials.tsx` 及独立表单 |
| 校验接口 | `POST git-credentials/verify` | `POST feishu-credentials/verify` |
| 错误码前缀 | `gitCredential*` / `gitRepository*` / `gitNetworkUnreachable` | `feishuCredential*` / `knowledgeBase*` |
| 文案命名空间 | `gitCredentials.*`（中英文各自维护） | `feishuCredentials.*`（中英文各自维护，与 Git 键不复用） |
| 引用保护 | 独立统计 `gitCredential` 引用 | 独立统计 `feishuCredential` 引用与消息接入使用 |

**Git 凭据**：

- 类型：SSH 私钥、HTTPS 令牌；另存 `provider`（GitHub / GitLab / 通用）用于身份探测。
- 字段：名称、类型、provider、作用域说明、私钥（粘贴或本机路径）/ 令牌、HTTPS 的用户名、可选口令。
- 一个 Git 凭据可被多个项目引用；项目只保存 `gitCredential` ID，不保存任何认证材料。
- 轮换：更新私钥/令牌，凭据 `revision` 递增；引用项目标记「Git 凭据待复验」，不自动改写项目。
- 删除：被任一项目引用（含停用项目）时不可删；返回引用项目列表，要求先改绑或解除引用。

**飞书凭据**：

- 身份模式：应用身份（App ID + App Secret）或 CLI 身份（lark-cli 配置）。
- 字段：名称、身份模式、App ID、App Secret、CLI 配置、作用域说明；可选的群、私聊、候选机器人、准入策略放在详情的「消息接入」标签。
- 一个飞书凭据可被多个项目引用，也可承载一个机器人的消息接入；项目只保存 `feishuCredential` ID。
- 轮换：更新 Secret 或切换身份模式，凭据 `revision` 递增；引用项目标记「飞书凭据待复验」，消息接入健康状态重置。
- 删除：被任一项目引用或被消息接入使用时不可删；分别列出「引用项目」与「消息接入」影响范围，要求先解除。

**项目选择规则**：

- 每个项目有且只有一个 `gitCredential`；类型必须与仓库协议一致。
- 飞书知识库项目有且只有一个 `feishuCredential`；Excel 项目不选择飞书凭据。
- 两者互不替代：Git 凭据不能用于读知识库，飞书凭据不能用于 Git 认证。
- 项目表单只提供下拉与「新建 / 管理」链接，不内嵌两个凭据页面的表单。

#### 5.3.2 知识库绑定：归属校验与唯一性

**绑定粒度**：知识库指飞书知识空间（`spaceId`）。项目绑定一个 `spaceId`，节点链接只决定读哪篇文档/哪个节点；同一空间内的不同节点仍视为同一个知识库，不能拆给两个项目。

**两道校验**，测试与保存都执行：

1. **归属校验**：用项目所选的飞书凭据调用 `wiki/v2/spaces/get_node?token=<nodeToken>`，取回节点的 `space_id`。
   - 节点不存在或无权限：`knowledgeBaseForbidden`
   - `space_id` 与项目绑定的 `spaceId` 不一致：`knowledgeBaseMismatch`
   - 链接无法解析出空间：`knowledgeBaseNoSpace`
2. **唯一性校验**：查询 `spaceId → projectId` 索引，包含停用项目，排除当前项目自身。
   - 已被其他项目占用：`knowledgeBaseTaken`
   - 并发保存由数据库唯一索引兜底，不能只靠前端或保存前查询。

**失败文案**：

| 错误码 | 中文文案 |
| --- | --- |
| `knowledgeBaseRequired` | 请绑定一个飞书知识库；每个项目必须且只能绑定一个。 |
| `knowledgeBaseInvalidUrl` | 请粘贴知识库节点链接（wiki 链接或节点 token），不要填空间首页或普通文档链接。 |
| `knowledgeBaseNoSpace` | 无法确定该链接所属的知识空间；请使用知识库节点链接。 |
| `knowledgeBaseForbidden` | 无法读取该知识库节点：{reason}。请确认所选飞书凭据已加入该知识空间并具备 wiki 读取权限。 |
| `knowledgeBaseMismatch` | 该节点属于知识库「{actual}」，与项目绑定的「{bound}」不一致；请更换节点，或改绑对应知识库。 |
| `knowledgeBaseTaken` | 知识库「{name}」已绑定到项目「{project}」；每个知识库只能属于一个项目。 |
| `knowledgeBaseUnreadable` | 知识库文档读取失败：{reason} |
| `knowledgeBaseColumns` | 字段映射与知识库表头不匹配：{columns} |

测试只校验并就地显示，不写设置；保存时再校验一次，失败则不保存并把焦点定位到知识库字段。项目已有排队或运行中的任务时更换知识库，必须先确认，避免同一项目先后读两个知识库。

### 5.4 「一个项目一个仓库」如何在界面表达

- 仓库组是单值表单，没有「添加另一个仓库」；任务来源里的 Excel 仓库是只读的「本项目仓库」。
- 仓库组只有一个 Git 凭据下拉，没有「凭据类型切换」；Git 凭据页面独立管理类型与材料。
- 分支与仓库地址在同一组，避免用户以为分支属于任务来源。
- 从复用库复制模板时，提示「将复制为项目专用配置，之后修改不会影响其他项目」。
- 保存时由 schema 保证一对一；不需要再跑 `checkRepoBinding`，因为任务来源已经没有独立的仓库字段。
- 修改已启用项目的仓库、分支或 Git 凭据时，如果存在排队或运行中的任务，先弹出确认，说明会重新同步工作副本、已有执行目录可能失效，并要求选择「停止队列后修改」或「取消」。

### 5.5 Git 凭据（独立功能）

**存放**：

- 只存于 `<stateDir>/secrets/git/` 下的独立加密文件；Windows ACL 仅当前用户，文件权限 0600 语义；值与元数据分离，密钥在 DSH 主机用户数据目录。
- Git 凭据记录与项目负载、`GET settings` 响应、配置版本快照完全隔离；项目只保存 `gitCredential` ID。
- 支持粘贴私钥/令牌（保存时加密）与「本机私钥路径」（只存路径）；默认粘贴，路径模式放在高级。

**回显**：

- `GET git-credentials` 只返回 `{ configured, hint: '••••abcd', fingerprint, updatedAt, revision, lastVerifiedAt }`，不返回明文。
- 编辑时秘密字段为空，占位「已保存（••••abcd），留空保持不变」；留空 = 保持，输入 = 覆盖，点「清除」= 删除该材料。
- 错误、日志、测试结果统一走 `redactCredentials`，禁止回显秘密。

**测试**：

- `POST git-credentials/verify`，请求体 `{ id?, authType, provider, material, repository?, branch? }`；`material` 可含草稿明文，只在本次请求使用，不持久化、不写日志。
- 带 `repository` 时：SSH 把私钥写入临时文件（0600），用 `git -c core.sshCommand=... ls-remote` 探测；HTTPS 用临时 `GIT_ASKPASS` 或令牌头探测；`finally` 删除临时材料。
- 不带 `repository` 时：只做材料可读性与身份校验（SSH 握手、令牌 `/user`），不判断仓库权限。
- 结果区分 `gitCredentialInvalid`（认证失败/密钥被拒/令牌过期）、`gitCredentialForbidden`（认证成功但无仓库权限）、`gitRepositoryNotFound`（仓库不存在或地址错误）、`gitRepositoryEmpty`（可访问但为空）、`gitCredentialKindMismatch`（SSH 凭据配 HTTPS 地址，或反之）、`gitNetworkUnreachable`。
- 权限与「仓库不存在」的区分优先用 provider API 复核；SSH 场景依据 `ls-remote` 错误流区分 `Permission denied (publickey)` 与 `Repository not found`，无法区分时提示「仓库不存在或当前凭据无权限」，不猜测。

| 错误码 | 中文文案 |
| --- | --- |
| `gitCredentialRequired` | 请选择 Git 凭据；每个项目必须且只能选择一个。 |
| `gitCredentialInvalid` | Git 凭据认证失败：{reason}。请检查私钥、令牌或口令是否正确、是否过期。 |
| `gitCredentialForbidden` | Git 凭据认证成功，但没有该仓库的访问权限。请确认账号或部署密钥已加入仓库。 |
| `gitCredentialKindMismatch` | 凭据类型与仓库地址不匹配：SSH 地址请选择 SSH 私钥，HTTPS 地址请选择 HTTPS 令牌。 |
| `gitCredentialUnreadable` | 无法读取 Git 凭据材料：{reason}。 |
| `gitRepositoryNotFound` | 仓库不存在或地址不正确：{repository}。 |
| `gitRepositoryEmpty` | 仓库可访问，但没有任何分支或提交。 |
| `gitNetworkUnreachable` | 无法连接 Git 服务：{reason}。 |

**轮换与删除**：

- `POST git-credentials/:id/rotate` 更新材料并递增 `revision`；引用项目标记「Git 凭据待复验」，下次项目测试或调度前复验，避免带旧材料继续领取任务。
- `GET git-credentials/:id/references` 返回引用项目（含停用）；页面展示引用数量与项目名单。
- `DELETE git-credentials/:id` 在有引用时返回 409 与引用列表，不提供静默级联删除；用户需先在项目中改绑或解除引用。

### 5.6 飞书凭据（独立功能）

**存放**：

- 只存于 `<stateDir>/secrets/feishu/` 下的独立加密文件，与 Git 凭据存储目录、记录、密钥用途分离。
- 飞书凭据记录与项目负载、设置快照隔离；项目只保存 `feishuCredential` ID。
- 应用身份保存 App ID / App Secret；CLI 身份只保存 CLI 配置引用，不复制 CLI 自身的令牌。

**回显**：

- `GET feishu-credentials` 只返回 `{ mode, appIdHint, configured, hint: '••••abcd', updatedAt, revision, lastVerifiedAt, ingressEnabled }`，不返回 Secret。
- 编辑时 Secret 留空保持原值；输入覆盖；点「清除」删除。App ID 可回显，Secret 永不明文。

**测试**：

- `POST feishu-credentials/verify`，请求体 `{ id?, mode, appId?, appSecret?, cli?, spaceId? }`；草稿 Secret 只在本次请求使用。
- 先验证应用身份：获取 tenant access token 或检查 CLI 登录状态；失败返回 `feishuCredentialInvalid` / `feishuCredentialExpired`。
- 带 `spaceId` 时再验证知识库权限：读取空间节点列表或目标节点；无权限返回 `feishuCredentialForbidden`。
- 结果至少包含 `identity`、`tokenValid`、`wikiAccess` 三项；不返回文档正文或用户列表。
- 错误码与 Git 完全独立：`feishuCredentialRequired`、`feishuCredentialInvalid`、`feishuCredentialExpired`、`feishuCredentialForbidden`、`feishuCredentialUnreadable`。知识库归属、唯一性与表头错误仍使用 `knowledgeBase*`，不混入 `feishuCredential*`。

| 错误码 | 中文文案 |
| --- | --- |
| `feishuCredentialRequired` | 请选择飞书凭据；飞书知识库项目必须且只能选择一个。 |
| `feishuCredentialInvalid` | 飞书应用身份无效：{reason}。请检查 App ID 与 App Secret。 |
| `feishuCredentialExpired` | 飞书应用凭据已过期：{reason}。请轮换 Secret 后重试。 |
| `feishuCredentialForbidden` | 飞书凭据有效，但没有读取该知识库的权限。请确认应用已加入知识空间并授予 wiki 读取权限。 |
| `feishuCredentialUnreadable` | 无法读取飞书凭据材料：{reason}。 |

知识库归属、唯一性与表头错误的文案见 5.3.2，使用独立的 `knowledgeBase*` 命名空间。

**轮换与删除**：

- `POST feishu-credentials/:id/rotate` 更新 Secret 或切换身份模式，递增 `revision`；引用项目标记「飞书凭据待复验」，消息接入健康状态重置。
- `GET feishu-credentials/:id/references` 分别返回引用项目（含停用）与消息接入使用方。
- `DELETE feishu-credentials/:id` 在有项目引用或消息接入使用时返回 409 与影响范围；不提供静默级联删除。

### 5.7 队列与运行状态放在哪里

- **项目列表**：每个项目显示启用状态、仓库、任务来源、运行中/排队数；顶部显示全局 `used / maxWorkers`。
- **项目详情**：概览（配置摘要 + 最终生效的执行目录）、任务队列（表格 + 每行停止/重试/取消排队）、最近工单。
- **工单页**：全局运行与暂停/恢复保持现状。
- **设置不出现队列**。设置只负责配置；启停按钮旁显示「当前有 N 个排队、M 个运行」的后果提示，并提供跳转到项目详情的链接。

### 5.8 动作位置与危险操作

| 动作 | 位置 | 规则 |
| --- | --- | --- |
| 保存项目 | 表单底部粘性操作条：[取消] [保存] | 保存前分别执行仓库与任务来源校验；任一失败整体拒绝。 |
| 测试 Git 凭据 | 项目仓库组「测试」 | 用所选 Git 凭据真实访问项目仓库；失败区分凭据无效、无权限、仓库不存在。 |
| 测试飞书凭据 | 项目任务来源组「测试」 | 用所选飞书凭据验证应用身份，并读取项目绑定的知识库；失败区分凭据无效、无权限、知识库不可读。 |
| 轮换 Git 凭据 | Git 凭据页面 → 详情 → 轮换 | 只更新 `git_credentials` 记录；引用项目标记「Git 凭据待复验」。 |
| 轮换飞书凭据 | 飞书凭据页面 → 详情 → 轮换 | 只更新 `feishu_credentials` 记录；引用项目与消息接入标记待复验。 |
| 删除 Git 凭据 | Git 凭据页面 → 危险区 | 有项目引用时不可删，返回引用项目列表。 |
| 删除飞书凭据 | 飞书凭据页面 → 危险区 | 有项目引用或消息接入使用时不可删，分别列出影响范围。 |
| 启停 | 项目详情页头部的开关，立即生效 | 停用前若存在排队/运行任务，弹出确认并说明：停止轮询、不再领取排队项、运行中的任务是否继续（默认继续）。 |
| 删除项目 | 表单最底部「危险区」 | 无历史时一次确认；有未结束工单或排队任务时，要求输入项目名称确认，并说明会停止的任务数。 |
| 更换仓库/分支/Git 凭据 | 仓库组内 | 有排队或运行任务时要求二次确认；提示会重新同步工作副本。 |
| 更换知识库/飞书凭据 | 任务来源组内 | 必须重新通过归属与唯一性校验；有排队或运行任务时二次确认。 |
| 复制模板 | 高级 → 复用库 | 生成一个未保存的项目草稿，不建立运行时引用；飞书知识库必须重新选择空间与节点，Git 与飞书凭据必须重新选择。 |

### 5.9 空状态与导航细节

- 没有项目时，空状态提供两个按钮：「新建项目」与「从复用库复制」。
- 没有 Git 凭据时，仓库组显示「去创建 Git 凭据」，不提供内嵌私钥输入。
- 没有飞书凭据、但项目选择了飞书知识库时，任务来源组就地显示「去创建飞书凭据」，而不是只报错。
- 项目尚未绑定知识库（迁移后待重绑）时，项目标记为「待绑定知识库」并保持停用；详情页直接定位到任务来源组。
- 项目详情提供「配置」与「队列」两个页内标签，URL 可深链到具体项目与标签。
- 所有设置项支持 `?group=...&id=...` 深链；从工单、队列、健康提示跳转时直接定位到项目与字段。

### 5.10 受影响的接口与界面分区

| 接口 | 变化 |
| --- | --- |
| `GET settings` / `GET projects` | 项目返回内联 `repository`（含 `gitCredential` ID）、`taskSource`（含 `feishuCredential` ID）与 `knowledgeBase` 摘要；不返回任何秘密，也不再返回可被项目引用的 `codeRepos` / `taskSources` 选择项。 |
| `POST projects` | 请求体包含仓库、任务来源与两个凭据 ID；保存前分别执行仓库校验与任务来源校验，失败整体拒绝。 |
| `PUT settings/project:<id>` | 同上；`id` 参与知识库唯一性校验以排除自身；更换已启用项目的知识库需带 `confirmReplace: true`。 |
| `POST projects/repository/verify` | 项目仓库校验：Git 凭据 × 仓库地址；返回 `gitCredential*` / `gitRepository*` 错误码。 |
| `POST projects/task-source/verify` | 项目任务来源校验：Excel 读取清单；飞书凭据 × 知识库归属与唯一性；返回 `feishuCredential*` / `knowledgeBase*` 错误码。 |
| `GET git-credentials` | Git 凭据独立列表；`settingsView` 不聚合该列表。 |
| `GET feishu-credentials` | 飞书凭据独立列表；`settingsView` 不聚合该列表。 |
| `GET/POST/PUT/DELETE git-credentials` | Git 凭据独立 CRUD；与飞书凭据无共用路由。 |
| `POST git-credentials/verify` | Git 凭据独立测试，支持可选的 `repository` / `branch` 上下文。 |
| `POST git-credentials/:id/rotate` | Git 凭据独立轮换，递增 revision。 |
| `GET git-credentials/:id/references` | Git 凭据独立引用统计。 |
| `GET/POST/PUT/DELETE feishu-credentials` | 飞书凭据独立 CRUD；与 Git 凭据无共用路由。 |
| `POST feishu-credentials/verify` | 飞书凭据独立测试，支持可选 `spaceId` 验证知识库权限。 |
| `POST feishu-credentials/:id/rotate` | 飞书凭据独立轮换，递增 revision。 |
| `GET feishu-credentials/:id/references` | 飞书凭据独立引用统计，包含项目与消息接入。 |
| `GET feishu-credentials/:id/wiki/spaces` | 新增，列出该凭据可见的知识空间，供项目选择。 |
| `GET feishu-credentials/:id/wiki/spaces/:spaceId/nodes` | 新增，列出空间内节点，供选择节点链接。 |
| `DELETE settings/project:<id>` | 删除项目时释放 `spaceId` 唯一索引；有未结束工单时沿用现有保护。 |

| 界面分区 | 变化 |
| --- | --- |
| 设置 → Git 凭据 | 独立列表与表单，只管理 SSH 私钥 / HTTPS 令牌、测试、轮换、引用保护。 |
| 设置 → 飞书凭据 | 独立列表与表单；详情分「应用身份」与「消息接入」两个标签，只管理 App ID / Secret / 身份模式与消息配置。 |
| 设置 → 项目 → 代码仓库 | 只选 Git 凭据引用；不出现私钥、令牌或 CLI 输入。 |
| 设置 → 项目 → 任务来源 | 只选飞书凭据引用；知识库空间绑定、节点链接、归属/唯一性测试；Excel 与知识库二选一。 |
| 设置 → 系统 → 高级 → 复用库 | 只读展示历史任务来源；复制为项目草稿时必须重新绑定知识库，并重新选择两个凭据。 |
| 项目详情 | 概览显示「Git 凭据 / 飞书凭据 / 知识库 / 节点」；待重绑或凭据待复验的项目显示醒目标记。 |

## 6. 数据模型与迁移

### 6.1 目标 schema（示意）

```ts
const GitCredentialSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1),
  authType: z.enum(['ssh-key', 'https-token']),
  provider: z.enum(['github', 'gitlab', 'generic']),
  description: z.string().trim().default(''),      // 作用域说明
  material: z.discriminatedUnion('source', [
    z.object({ source: z.literal('inline'), privateKey: SecretRefSchema, passphrase: SecretRefSchema.optional() }).strict(),
    z.object({ source: z.literal('path'), path: z.string().trim().min(1), passphrase: SecretRefSchema.optional() }).strict(),
    z.object({ source: z.literal('token'), username: z.string().trim().default('x-access-token'), token: SecretRefSchema }).strict(),
    z.object({ source: z.literal('agent') }).strict(),   // 复用智能体已有凭据
  ]),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastVerifiedAt: z.string().nullable(),
}).strict()

const FeishuCredentialSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1),
  mode: z.enum(['app', 'cli']),                    // 应用身份 / CLI 身份
  appId: z.string().trim().default(''),
  appSecret: SecretRefSchema.optional(),
  cli: z.string().trim().default(''),
  description: z.string().trim().default(''),
  ingress: z.object({                              // 可选：消息接入
    enabled: z.boolean(),
    chats: z.array(z.string()).default([]),
    otherChats: z.array(z.string()).default([]),
    directMessages: z.array(z.string()).default([]),
    allowedUsers: z.array(z.string()).default([]),
    bots: z.array(z.string()).default([]),
  }).strict().optional(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastVerifiedAt: z.string().nullable(),
}).strict()

const RepositorySchema = z.object({
  kind: z.enum(['github', 'gitlab']),
  repository: z.string().trim().min(1),
  branch: z.string().trim().default(''),
  remote: z.string().trim().default(''),
  gitCredential: z.string().trim().min(1),         // 只存引用
  gitCredentialRevision: z.number().int().optional(), // 上次校验通过的凭据版本
}).strict()

const FeishuWikiTaskSourceSchema = z.object({
  kind: z.literal('feishu-wiki'),
  feishuCredential: z.string().trim().min(1),      // 只存引用
  feishuCredentialRevision: z.number().int().optional(),
  knowledgeBase: z.object({
    spaceId: z.string().trim().min(1),
    name: z.string().trim().default(''),
  }).strict().nullable(),                          // 迁移后待重绑时为 null
  node: z.object({
    url: z.string().trim().min(1),
    token: z.string().trim().min(1),
  }).strict().nullable(),
  fieldMap: TaskFieldMapSchema,
}).strict()

const ProjectTaskSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('excel'), config: ExcelConfigWithoutRepo, fieldMap: TaskFieldMapSchema }).strict(),
  FeishuWikiTaskSourceSchema,
])
```

- `git_credentials` 与 `feishu_credentials` 是两张独立表，schema、revision、引用统计、轮换记录各自维护，不设通用凭据表或 `type` 判别字段。
- 项目只保存 `repository.gitCredential` 与 `taskSource.feishuCredential` 两个 ID；项目负载没有秘密。
- 项目同时保存上次校验通过的 `gitCredentialRevision` / `feishuCredentialRevision`；凭据轮换后 revision 不一致即显示「待复验」，不需要遍历改写项目。
- Git 凭据的 `authType` 必须与仓库地址协议一致；飞书凭据只用于飞书知识库任务来源。
- `knowledgeBase.spaceId` 建唯一索引（包含停用项目）；冲突返回 `knowledgeBaseTaken`。
- `node.token` 必须能解析出与 `knowledgeBase.spaceId` 相同的空间；否则保存失败。
- `enabled: true` 的前置条件：Git 凭据已通过当前仓库校验、飞书凭据已通过知识库校验、知识库已绑定且唯一；未满足时只能以停用状态存在。
- 项目 ID 仍按 `^[a-z][a-z0-9-]*$`，由名称首次保存时生成，之后不可改。
- 删除 `Project.codeRepo`、`Project.taskSource` 旧 ID 字段、`taskSource.config.repo`、`taskSource.config.source`、`checkRepoBinding`、`codeRepos`、`taskSources` 两个设置映射。
- 「高级复用库」使用独立的 `library.codeRepos` / `library.taskSources`，只读、不参与运行时解析；复制出来的知识库配置必须重新做归属与唯一性校验，凭据也必须重新选择。

### 6.2 迁移步骤（不考虑向后兼容）

1. 备份 `stateDir` 数据库与设置版本（迁移前必须）。
2. 新增 schema 版本 14；Git 凭据、飞书凭据、项目三部分分别迁移，不共用迁移函数：
   - **Git 凭据**：逐条扫描 `codeRepos`。`auth: 'ssh'` 的记录生成 `git_credentials` 行：`authType: 'ssh-key'`、`provider` 取仓库类型、`material: { source: 'path', path: sshKey }`；`auth: 'https'` 的记录生成 `authType: 'https-token'`、`material: { source: 'agent' }`。按 `(provider, authType, path/agent)` 去重，同一种材料只建一条。
   - **飞书凭据**：逐条扫描 `sources` 中的飞书记录，生成 `feishu_credentials` 行：`mode: 'cli'`、`cli` 取现有 CLI 配置、`ingress` 复制群/私聊/其他群/允许用户/候选机器人。每条来源各自生成一条，不跨来源去重，避免把两个机器人的消息接入混在一起。
   - **项目**：`repository` 取 `codeRepos[project.codeRepo]` 的 `kind/repository/remote`，`branch` 从 `project.execution.branch` 移入，`gitCredential` 指向上面生成的 Git 凭据；Excel 项目复制 `taskSources` 配置并删除 `config.repo`；飞书知识库项目只保留 `feishuCredential` 与字段映射，`knowledgeBase` / `node` 置 `null`，强制 `enabled=false` 并标记「待绑定知识库」。
   - 多个项目引用同一仓库时复用同一条 Git 凭据，但仓库地址与分支在各项目内各存一份；多个项目引用同一飞书知识库时不复制绑定，全部进入待重绑。
3. 建立 `spaceId → projectId` 唯一索引（迁移阶段为空索引）；唯一性由保存时校验与数据库索引共同保证。
4. 现有认证材料只有本机私钥路径与智能体凭据，没有明文秘密需要迁移；若历史数据里出现内联秘密，按 Git / 飞书各自的加密存储分别写入，不合并密钥用途。
5. 写回项目块，删除 `codeRepos` / `taskSources` 映射与对应设置块；清理引用这些块的旧 API。
6. 迁移后不自动启用项目。Git 凭据先通过当前仓库校验；飞书知识库项目还必须重新选择知识库空间与节点，通过归属与唯一性校验后才能启用。
7. 回滚：恢复备份即可；不保留双写。

### 6.3 现有数据的落点示例

`demo-tree` 项目迁移后：

- 项目名称 `DemoTree`，启用状态保持停用。
- 仓库：GitHub、`martinxiao2025/DemoTree`、分支 `main`，`gitCredential` 指向新建的 Git 凭据 `demo-tree-ssh`。
- Git 凭据 `demo-tree-ssh`：`authType: 'ssh-key'`、`provider: 'github'`、`material: { source: 'path', path: <原 sshKey> }`；可被其他项目复用。
- 任务来源：Excel，清单 `docs/backlog.csv`，字段映射沿用现有五列；不绑定飞书凭据。
- 轮询：30 分钟；执行目录保持空（默认 `<stateDir>/work`）。
- 原 `demo-tree` 代码仓库记录与 Excel 任务来源记录只在复用库中保留一份只读副本。

如果某项目原来使用飞书知识库：

- 新建或复用一条飞书凭据（`mode: 'cli'`），项目 `feishuCredential` 指向它。
- 迁移后任务来源类型仍是「飞书知识库」，但知识库与节点为空，项目显示「待绑定知识库」且保持停用。
- 原知识库链接只作为复用库中的参考信息，不允许直接恢复为绑定；必须在项目里重新选择空间与节点并通过归属、唯一性校验。

## 7. 需要拍板的点

1. **Git 凭据支持哪些类型**：推荐 SSH 私钥与 HTTPS 令牌，并保留「智能体已有凭据」模式用于迁移；若只允许 SSH，可以缩小实现范围。
2. **Git 凭据是否允许跨项目复用**：推荐允许，轮换一次影响所有引用项目，并在轮换后标记「待复验」；若要求每个项目独立凭据，需要在项目保存时强制复制。
3. **飞书消息接入放在哪里**：推荐放在飞书凭据详情的「消息接入」标签，与 Git 凭据页面完全独立；若希望消息接入独立成页，需要接受它与飞书凭据之间的引用关系。
4. **飞书凭据是否允许跨项目复用**：推荐允许；知识库仍为项目专属，复用凭据不会导致知识库共享。
5. **知识库的绑定粒度**：推荐按知识空间（`spaceId`）绑定，同一空间内的不同节点仍算同一个知识库，不能拆给两个项目。
6. **任务来源是否严格二选一**：推荐严格二选一（Excel 或飞书知识库）；若允许同时，需要新增多来源合并与去重规则。
7. **迁移时是否自动抽取凭据**：推荐自动抽取 Git 凭据与飞书凭据；若担心把共享材料错误合并，可改为全部手工重建。
8. **被引用凭据的删除策略**：推荐默认不可删、返回引用列表；若允许强制删除，必须二次确认并列出会失效的项目。
9. **轮换后的复验语义**：推荐标记「待复验」并在下次项目测试或调度前复验，不让旧凭据继续领取任务。
10. **项目列表与设置项目页是否合并**：推荐把配置收进项目详情的「配置」标签，设置中只保留项目列表入口，彻底消除同名双层入口。

## 附录 A：本轮运行验证发现的问题（与信息架构相关）

| 现象 | 证据 | 对设计的影响 |
| --- | --- | --- |
| 停用项目不阻止已排队任务被领取 | `demo-tree` 设为 `enabled=false` 后，T-003 仍在 11 秒后被领取（`used=1`） | 启停必须成为项目详情页头的即时动作，并明确「停用后不再领取排队项」；调度器需要按 `enabled` 过滤队列。 |
| 任务卡死 | T-003 队列项长期 `running`、`used=0`、ticket `open/idle`、assignment `running`，约 6 分钟无更新；人工停止后队列变 `cancelled` | 项目详情的队列表必须提供停止/重试/取消排队，不能只在工单页操作。 |
| 状态回写编码损坏 | `repos/demo-tree/docs/backlog.csv` 被写成 `T-002,...,???,P1`，工作副本出现 ` M docs/backlog.csv`，远端未变 | 任务来源内联后，字段映射与回写目标必须在同一组展示；保存前应做一次真实读写测试。 |
| 执行目录不是 git 仓库 | `work/DemoTree/<ticketId>` 均无 `.git`，T-002 自述从同级目录复制骨架、因 `gh` 不可用无法建 PR | 执行目录组需要显示「最终生效目录」与「是否已物化仓库」，并在仓库变更时提示重新同步。 |
| 仓库未被 push | `git ls-remote` 仍为 `aadc324…`，只有 `refs/heads/main` | 与信息架构无直接关系，但说明「仓库」与「执行目录」在界面上必须能一眼区分。 |

这些是运行时缺陷，本轮未修复；它们支持本文的两个结论：启停语义要写进项目表单，队列操作要放到项目详情。

## 附录 B：相关文件索引

- 设置外壳与导航：[settings.tsx](../src/client/settings.tsx)、[route.ts](../src/client/route.ts)、[client.css:315-333](../src/client/client.css#L315-L333)
- 设置视图聚合：[views/settings.ts](../src/app/views/settings.ts)
- 来源：[source.tsx](../src/client/source.tsx)、[feishu.ts](../src/sources/feishu.ts)、[adapters.ts](../src/sources/adapters.ts)
- 代码仓库：[code-repos/kind.ts](../src/code-repos/kind.ts)、[code-repos/types.ts](../src/code-repos/types.ts)、[sources/github.ts](../src/sources/github.ts)；编辑界面并入 [projects.tsx](../src/client/projects.tsx)
- 任务来源：[task-sources/excel.ts](../src/task-sources/excel.ts)、[task-sources/feishu-wiki.ts](../src/task-sources/feishu-wiki.ts)；编辑界面并入 [projects.tsx](../src/client/projects.tsx)
- 目标新增（未实现，仅设计）：`src/git-credentials/`、`src/feishu-credentials/`、`src/client/git-credentials.tsx`、`src/client/feishu-credentials.tsx`；`src/secrets/` 只放加密与掩码工具，两个凭据模块不共用业务代码。
- 项目：[projects.tsx](../src/client/projects.tsx)、[projects/kind.ts](../src/projects/kind.ts)
- 设置保存与一致性校验：[app/settings.ts](../src/app/settings.ts)
- 数据库基线：[app/store.ts](../src/app/store.ts)
- 预检与验证接口：[app/setup.ts](../src/app/setup.ts)、[app/http.ts:216-260](../src/app/http.ts#L216-L260)
