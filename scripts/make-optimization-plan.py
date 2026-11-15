# -*- coding: utf-8 -*-
"""生成 docs/optimization-plan.xlsx：dsh-superagent 优化与重构方案记录（第一轮全库评审）。

工作表：
- 00 说明        —— 评审方法、范围、口径
- 01 架构画像    —— 四个区域的实际架构综述与结构性弱点
- 02 发现总表    —— 36 条发现（编号/级别/区域/标题/证据/问题/最佳实践对照/建议/工作量/状态/轮次）
- 03 重构路线图  —— 按批次组织的重构方案与验收标准
- 04 与011对照   —— 本轮发现与既有评审文档 011 的关系（新发现/推翻关闭/重复补充）
"""
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

wb = Workbook()

# ---------- 样式 ----------
HEAD_FILL = PatternFill('solid', fgColor='1F4E79')
HEAD_FONT = Font(bold=True, color='FFFFFF', size=11)
P0_FILL = PatternFill('solid', fgColor='C00000')
P1_FILL = PatternFill('solid', fgColor='ED7D31')
P2_FILL = PatternFill('solid', fgColor='FFC000')
OK_FILL = PatternFill('solid', fgColor='70AD47')
NOTE_FILL = PatternFill('solid', fgColor='DDEBF7')
THIN = Border(*[Side(style='thin', color='BFBFBF')] * 4)
WRAP = Alignment(wrap_text=True, vertical='top')
TOP = Alignment(vertical='top')

def style_sheet(ws, widths, header_row=1, freeze='A2'):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for cell in ws[header_row]:
        if cell.value is not None:
            cell.fill = HEAD_FILL
            cell.font = HEAD_FONT
            cell.alignment = Alignment(wrap_text=True, vertical='center')
    for row in ws.iter_rows(min_row=header_row):
        for cell in row:
            cell.border = THIN
            if cell.row > header_row:
                cell.alignment = WRAP
    ws.freeze_panes = freeze
    ws.auto_filter.ref = ws.dimensions

def fill_by_level(ws, col, first_data_row):
    for r in range(first_data_row, ws.max_row + 1):
        v = str(ws.cell(r, col).value or '')
        f = P0_FILL if 'P0' in v else P1_FILL if 'P1' in v else P2_FILL if 'P2' in v else None
        if f:
            ws.cell(r, col).fill = f

# ---------- 00 说明 ----------
ws = wb.active
ws.title = '00 说明'
rows = [
    ['项目', 'dsh-superagent — 面向 GitHub 仓库的主动式编码智能体（DeepSeek Harness 插件包）'],
    ['记录文件', 'docs/optimization-plan.xlsx（本文件；每轮评审后追加/更新，不覆盖历史轮次行）'],
    ['第一轮评审日期', '2026-11-15'],
    ['评审方式', '只读静态分析。4 个并行子代理分区深读（核心调度层 / 执行器与基础设施层 / 任务来源与凭据层 / HTTP 面板与客户端），共 36 条发现；关键 P1 证据由主代理二次抽查核实（scheduler-dispatch、idle.ts、vault.ts、workspace.ts 的行号逐条比对）。'],
    ['代码规模', 'src 22,778 行（TS/TSX），19 个顶层模块；测试 86 个 spec 文件；文档 000-011 共 12 篇'],
    ['基线', 'v0.2.0（schema 14）；内部评审 docs/011-architecture-review.md §9.1 已关闭 17 项、§9.2 剩余 13 项'],
    ['级别口径', 'P0=上线阻塞/数据损坏；P1=影响可靠性或正确性，首个生产周期内必须解决；P2=工程质量/可维护性建议'],
    ['状态口径', 'open=未处理；planned=已纳入路线图批次；done=已修复并验证；wontfix=经讨论不做'],
    ['本轮核心结论', '011 的修复方向正确、整体工程质量高于典型插件项目（持久化 Outbox、六边形内核、静态架构守卫、双语 i18n 编译期守卫均为亮点）；但存在三类系统性问题：①「幂等键依赖可复位计数器」的设计模式缺陷（C1/E1 同源）；②「关闭记录与实现漂移」——011 宣称关闭的 P1-3（内容哈希）、P1-5（轮询互斥）、P0-3（回写 CAS）实际只修了一半（S3/C4/C3）；③派生资源（worktree/登记表/镜像）缺少对称的 release 通道（E4/E6/E11/S1 同源）。'],
    ['下轮评审建议', '1) 修复后复核 02 表状态列；2) 抽查 03 路线图各批次验收标准是否落地；3) 对 E1/C1/C2 三条流水线卡死类缺陷优先做故障注入测试；4) docs/011 §9.2 剩余清单与本表合并去重后作为唯一权威清单。'],
]
for r in rows:
    ws.append(r)
ws['A1'].fill = HEAD_FILL
ws.column_dimensions['A'].width = 18
ws.column_dimensions['B'].width = 120
for row in ws.iter_rows(min_row=1):
    for cell in row:
        cell.border = THIN
        cell.alignment = WRAP
for r in range(1, ws.max_row + 1):
    ws.cell(r, 1).font = Font(bold=True)
    ws.cell(r, 1).fill = NOTE_FILL

# ---------- 01 架构画像 ----------
ws = wb.create_sheet('01 架构画像')
ws.append(['区域', '实际架构综述（亮点 → 结构性弱点）'])
profile = [
    ['核心调度层（store/scheduler/effects/runtime/core/policy）',
     'SQLite 单库+行内 JSON 文档模式教科书式运用：领域聚合、队列、副作用、带版本设置全部存为一行 JSON，生成列+部分索引下推工作集查询，活动队列唯一性用部分唯一索引下沉到数据库层。core 是零依赖六边形内核，Engine 七部件单一事务入口，afterCommit 推迟外部副作用，Memory/SQLite 仓储有对拍测试。Effects 是全项目最成熟的通用持久化 Outbox（seq 保序、generation 防竞态、跨重启续 seq）。亮点：抖动防惊群、busy 推迟、终态 30 天保留、告警合并与恢复通知、DDL 漂移规范化比对。弱点：①状态锁在行内 JSON，跨行不变量靠应用层读改写，「重试预算」与「幂等键」共用一个 attempt 计数器（C1 根源）；②person 阶段接管、任务级回写等产品语义硬编码在状态推断上，缺显式策略层（C2/C3）；③运维状态（lastError/nextPoll/deferred）停留内存 Map，热路径每 15 秒全量 JSON 解析（C5）；④queue 读取 fail-fast 无隔离区，一行损坏即调度瘫痪（C7）。'],
    ['执行器与基础设施层（executor/infra/code-repos/deployment）',
     '以持久化副作用队列为中心的执行平面：DshExecutor 门面+四模块拆分经 WorkerContext 反向注入，WorkerSlots 并发闸（全局上限+同项目串行）统一三类预留；worktree 两级工作区（轮询镜像→每工单 worktree，prepare 失败即删区）；Commands scope 化执行 + 独立 git 超时；凭据经目录登记表+垫片在进程侧分发，worker 剥除令牌环境变量。Windows 兼容做到实现级（PATHEXT、批处理垫片、大小写归一）。弱点：①状态机真相分散在 Store/DSH agent/WorkerState 三处，靠字符串前缀与事件时序对齐，E1（重试键冲突致恢复消息被幂等去重）即对齐失效实例；②worktree 与登记表只创建不拆除，GC 直接 rm 不走 git 拆除协议（E4/E6/E11）；③launch 双次 assignmentStarted、两套目录名清洗、两套 lark 输出解析并存（E9/E7/E3）。'],
    ['任务来源与凭据层（task-sources/secrets/credentials/sources）',
     'TaskSourceDriver 防腐蚀层落实到位：CSV/TSV/自研 XLSX/飞书表格全部在驱动内归一化为 RawTask，调度器只见领域模型。回写两型：excel 走 BOM/CRLF 探测→原子替换→定点重写→本地 commit；feishu-wiki 走 bitable updateRecord。凭据侧 CredentialService 共享骨架+域差异注入、AES-256-GCM 分区加密、材料绝不进设置快照——区域内质量最高。传输层单点 feishu-transport 承载双身份+token 缓存+错误分类表。弱点：①回写本地提交打破镜像「纯只读」不变量，远端前进后 ff-only 永久失败且从不推送远端（S1）；②icacls verbatim 参数在含空格路径下整个凭据子系统不可用（S2）；③多工作项 contentHash 不含组合文本，改描述仍执行旧内容（S3）；④feishu-im 不过滤机器人消息，存在自我放大循环风险（S4）；⑤列匹配/行定位逻辑三处近似重复。'],
    ['HTTP 面板与客户端（http/views/tools/client）',
     '「纯类型契约→纯函数路由表→纯函数视图投影→无状态 React」四段式，边界感罕见地好：api.ts 只放类型、客户端视图从响应类型反向派生，契约漂移编译期暴露；http 四文件职责单一（R7 落地）；同源防护三重校验+完整拒绝矩阵；视图层惰性缓存与游标分页自觉；draft.tsx 三方合并草稿状态机是客户端最有含金量的部件；无障碍基础扎实。弱点：①读路径列化/下推只做了 queue，ticket/thread/search 仍整表 JSON 解析×轮询周期（U1）；②整棵组件树无 ErrorBoundary，渲染异常可能击穿宿主工作区（U2）；③默认值/校验/枚举三类事实客户端与服务端各有第二份（U4/U5/U7）；④健康探针被同源 CSRF 拦截，标准监控工具不可用（U6）；⑤时间线补洞无迭代上限、每次轮询全量 stringify 比对（U8）。'],
]
for r in profile:
    ws.append(r)
style_sheet(ws, [26, 150])
ws['B2'].alignment = WRAP
for r in range(2, ws.max_row + 1):
    ws.row_dimensions[r].height = 210

# ---------- 02 发现总表 ----------
ws = wb.create_sheet('02 发现总表')
headers = ['编号', '级别', '区域', '标题', '证据（file:line）', '问题描述', '业界最佳实践对照', '建议修复', '工作量(人日)', '状态', '轮次', '备注']
ws.append(headers)

findings = [
 # ---- 核心调度层 C1-C7 ----
 ['C1', 'P1', '核心调度', '手动重试重放陈旧 attempt 触发器：面板「重试」不会真正重新执行，还会把外部清单再次回写为失败',
  'src/app/scheduler.ts:397 (attempt 归零); src/app/scheduler-dispatch.ts:123 (triggerId 仅含 attempt); src/core/engine.ts:82-84 (幂等返回已结束工单); src/app/store.ts:328-337 (工单永久保留无删除)',
  'retryEntry 把 attempt 重置为 0 后，派工依次命中 attempt 0/1/2 的历史触发器，engine.schedule 幂等拿回三张已结束的旧工单：每张结算为 retry 带退避，最终 attempt 3 > maxRetries 再次「最终失败」并回写 failedStatus。整个过程没有执行任何新工单——重试按钮对耗尽重试的条目完全失效；若旧工单终态是 completed，甚至会未执行就回写成功。',
  '幂等键应包含「尝试代次(epoch/nonce)」而非可复位业务计数器；人工重试属于新生命周期，必须生成新幂等键（Outbox/任务队列通行做法）',
  '把「重试预算」与「触发器代次」拆成两个字段：attempt（退避/预算，可归零）与单调递增 epoch（或直接用 entry.tickets.length）参与 triggerId；settleOutcome 对「created:false 且工单已结束」显式报错；补「耗尽重试→手动重试→产生新工单」真实引擎用例（现有测试从未复用 attempt 号，掩盖此缺陷）',
  1.5, 'planned', 1, '与 E1 同为「幂等键依赖可复位计数器」模式缺陷'],
 ['C2', 'P1', '核心调度', 'person 阶段被立即 stop-then-retry：worker 提问/待审阅/投递失败 15 秒内被强停重建，烧掉重试预算',
  'src/app/scheduler-dispatch.ts:195-198 (person 一律 stop-then-retry); src/core/stage.ts:9-21 (person 含 delivery/answer/review/blocked/failed); src/app/scheduler.ts:275 (每 tick 结算所有在途条目)',
  'worker 通过 attention 提了澄清问题→下一 tick 调度器 stopTicket（by:human 结束，人无法再恢复）并从零重建新工单重试；worker 再次提问则 attempt 逐次递增直至最终失败并回写清单。投递类瞬时失败被双重惩罚。011 §7 已明确建议「person 阶段改为超时重试」但未落地，§9.2 亦未列入。',
  '自动接管人与机器的协作状态前应有时间窗与状态白名单；对「等待人」的实体做破坏性操作是工作流引擎典型反模式',
  '仅对 blocked/failed 且 waitsForPerson 的工单在超过可配置超时（项目级）后接管；answer/review 不接管（或仅告警）；delivery 交给执行器自身瞬态重试，超时后才接管',
  1, 'planned', 1, '011 §7 修订建议未落地的实例'],
 ['C3', 'P1', '核心调度', '回写粒度是任务级：多工作项任务的最终状态由最后结算的工作项决定；CAS（期望旧状态）未实现',
  'src/app/scheduler-writeback.ts:10-15 (payload 无 item/expectedStatus); src/app/scheduler-dispatch.ts:151-166 (每个工作项成功/失败都回写整任务); src/task-sources/tasks.ts:101-122 (splitTask 拆多工作项)',
  '含 3 个复选框的任务：第 1 项成功→清单写已完成；第 2 项重试耗尽→覆盖为失败；第 3 项还在排队。清单最终状态取决于结算顺序而非真实进度。且写入前不校验清单当前值——人工在结算间隙改状态会被无提示覆盖。011 P0-3 关闭记录只落了 Effects 化，原始建议中的 CAS 未实现也未列入 §9.2。',
  '外部系统写入用 CAS/If-Match 防覆盖（乐观并发）；状态投影应与状态机最小单元对齐（item 级）或显式聚合后写最终值',
  '①回写前按「任务的全部条目均已终态」聚合最终状态再写（或驱动层支持 item 级定位）；②payload 增加 expectedStatus，driver 写入时校验旧值，不匹配报可恢复错误并告警，人工仲裁',
  2.5, 'planned', 1, '推翻 011 §9.1「P0-3 已关闭」的部分结论'],
 ['C4', 'P1', '核心调度', '手动 scan 与 poll 副作用缺同项目互斥：同一工作副本可能被并发 git fetch/merge',
  'src/app/scheduler.ts:194-199 (pollNow 不经 runExclusive); src/app/scheduler.ts:143-161+294-308 (scan 自持并发池); src/code-repos/sync.ts (无互斥原语); src/app/scheduler-reconcile.ts:54-59 (busy 只看执行)',
  'tick 投递的 poll 副作用正在慢速 clone 时，用户点手动扫描→两个 syncRepoWorkCopy 并发作用于同一镜像目录：index.lock 冲突、重复 fetch、清单并发读取。011 §9.2 第 1 条宣称「已于 2026-11-15 关闭」，但其论证只对齐了并发上限数值（两个池各 4，总数可达 8 且同项目不互斥）——关闭结论不成立。',
  '共享可变资源必须单写者；互斥应落在资源上而非调用方池子上',
  'pollNow 并入 runExclusive（与 scan/tick 共用 cycle），或在 reconcile.poll 入口维护 per-project in-flight Set，重复调用返回/Later；补「poll 副作用进行中+scan 并发」用例',
  1, 'planned', 1, '推翻 011 §9.2-1「已关闭」结论'],
 ['C5', 'P2', '核心调度', '可观测性与性能：每 15 秒全量 JSON 解析队列多次；调度错误与轮询计划是内存态重启即丢；trigger/outbox 无保留期',
  'src/app/scheduler.ts:328 (reportHealth 每 tick 全表解析); scheduler-dispatch.ts:70+scheduler.ts:275+433 (同 tick 内 active() 全量解析 3-4 次); scheduler.ts:85 (errors/nextPoll/deferred 内存 Map); store.ts:120-139 (trigger/disposition/decision/ticket/outbox 无保留路径)',
  'health 统计、pump、settle、busy 各自全量解析队列 JSON（含 30 天终态行）；进程重启后 lastError/deferred 清空，面板排障线索丢失；trigger/outbox 等日志型实体随时间无限增长拖慢 search/triggerStats/备份。',
  '健康指标走 SQL 聚合（COUNT+json_extract）；运维状态持久化；日志型实体设保留策略（对比 queue 的 30 天窗口）',
  '①健康统计与 busy() 改 SQL 计数（生成列索引已就绪）；②lastError/deferred 落 KV 重启恢复；③trigger/outbox 增加类似 queue 的保留窗口',
  1.5, 'planned', 1, '与 011 §9.2-5 可观测性部分同向但未列出'],
 ['C6', 'P2', '核心调度', 'Effects 失败行无最大尝试与死信：永久性故障以 10 分钟间隔无限重试',
  'src/app/effects.ts:163-164 (attempts 无上限无终态); src/app/scheduler.ts:357-364 (积压告警只在数量变化时注入一次)',
  '驱动配置损坏、来源被删或外部清单格式变更后，writeback 行永远在退避里空转；积压不清零时用户只收到一次告警，之后静默无限重试，掩盖真实故障。',
  'Outbox/重试队列通行设计：指数退避+最大尝试+死信(dead-letter)+人工重放入口；项目已具备人工重放通道，只缺终态',
  'attempts > N（如 10）后标记 dead 并入健康/告警，面板展示且可一键重放（复用 effects enqueue 语义）',
  1, 'planned', 1, ''],
 ['C7', 'P2', '核心调度', 'queue 读取 fail-fast：一行损坏即令整个调度器瘫痪，无隔离区',
  'src/app/store.ts:381-384 (queueValues 每行 parse 抛错即整查询失败); src/app/store.ts:346-349; 后果链 snapshot/pump/recover/forget 全抛错; 对比 store.ts:386-403 (tickets/threads 列表已实现单行损坏跳过上报); tests/queue.spec.ts:487-488 (把整表抛错断言为预期)',
  '最关键路径上最脆弱：SQLite 文件级损坏或磁盘故障时一行损坏即调度完全停摆，需手工改库。011 P1-1 原始建议「失败行进 quarantine 并让健康度可见」，关闭时实现为 fail-fast。',
  '对只读列表路径，隔离优于瘫痪；fail-fast 仅保留给按 id 直读',
  'list/active/ready/terminal 等扫描路径改为跳过损坏行+上报（复用 entityValues 模式+quarantine 记录）；仅 get 保持 fail-fast',
  1, 'planned', 1, ''],
 # ---- 执行器层 E1-E11 ----
 ['E1', 'P1', '执行器', '瞬态重试 requestId 在计数清零后冲突：恢复消息被幂等去重静默丢弃，工单与整个项目流水线永久卡死',
  'src/executor/idle.ts:58 (requestId=retry:<assignmentId>:<tries>); idle.ts:96 (回合成功后 tries=0); src/app/delivery.ts:75 (重复 id 跳过投递); delivery.ts:44-59 (持久化历史重启后仍去重)',
  '同一 assignment 内「瞬态失败→重试成功(计数清零)」之后，后续回合再瞬态失败时 tries 又从 0 递增，生成的 requestId 与早先已入历史的重试消息完全相同→第二次恢复消息被静默丢弃→无回合启动也无 idle 事件收尾→工单永久 running。对调度工单后果放大：条目永久 running，pump 的 busy 检查令该项目整体停止派工，只能人工停止工单解锁。',
  '幂等键必须覆盖「语义上的一次尝试」——用单调递增序号或时间戳参与键构造（outbox pattern 的 delivery id）',
  'requestId 改为含每 assignment 单调投递序号或毫秒时间戳（如 WorkerState 维护 retrySeq）；补「同一 assignment 两次瞬态失败各自产生一次恢复投递」回归用例',
  0.5, 'planned', 1, '证据已主代理复核；最高优先级——可致整项目卡死'],
 ['E2', 'P1', '执行器', 'materializeWorkspace 对请求分支缺失时静默回退检出 HEAD：worker 可能在错误/陈旧基线上执行',
  'src/code-repos/workspace.ts:56-59 (refs/heads/<branch> 查不到→ref=HEAD); 对照 docs/009 派工校验要求; launch.ts:138 只检查目录存在',
  '分支检查针对镜像本地分支而非远端引用：项目刚切换 execution.branch 或上轮轮询失败时镜像无新分支引用→静默退回 HEAD（旧分支顶端）。worker 在错误基线开工并可能提交/发 PR，无错误码无警告——违反「显式失败优于隐式回退」。',
  'fail fast；配置漂移（期望分支 vs 实际检出）应作为可观测错误而非静默降级',
  'branch 指定但镜像缺失时抛带错误码异常（提示镜像陈旧，等待轮询或触发同步）；或 prepareDirectory 先校验同步结果分支与 execution.branch 一致；补「请求分支不存在→拒绝」用例',
  1, 'planned', 1, '证据已主代理复核'],
 ['E3', 'P1', '执行器', 'Commands.lark 直接 JSON.parse 整个 stdout：CLI 横幅一旦出现全部飞书调用失败且丢失错误码分类',
  'src/infra/commands.ts:209 (JSON.parse(output)); 对照 deployment.ts:328-330 (探测路径自认「CLI 可能在 NDJSON 前打印横幅」)+179-185 (firstParsed 逐行找 JSON)',
  '代码库自己承认该 CLI 会打印横幅，探测路径做了容错，业务主路径（全部飞书消息收发/群列表）却直接 parse 整段输出：横幅出现时抛 SyntaxError 而非 CliError，脱离 commandError 转换链——健康看到无结构解析错误；outbox 依赖 CliError.code 的「撤回→gone、超时→保留重试」分类全部失效，本应丢弃的撤回消息无限重试。',
  '对同一外部依赖的输出解析收敛到单一防御性入口（tolerant reader 模式），探测与业务路径共享',
  'lark() 复用 firstParsed 风格提取；commands.spec 补「横幅+JSON」「NDJSON」用例',
  0.5, 'planned', 1, ''],
 ['E4', 'P2', '执行器', 'worktree 只创建不拆除：GC 直接 rm-rf 工单目录，镜像 worktree 元数据残留，GC 与工单复活存在删除竞态',
  'src/app/workspace-gc.ts:92 (rm recursive force); workspace-gc.ts:103-121 (删除循环无 git 操作); workspace-gc.ts:89 (tickets.list() 循环前取一次快照); src/code-repos/workspace.ts:55 (worktree prune 只在下一次 materialize 时顺带); src/core/tickets.ts:81-98 (wake 可复活已结束工单)',
  '①每工单 worktree 的 gitdir 元数据残留至同仓库新工单恰好触发 prune；②GC 的「未结束工单不删」基于开始时一次快照：已结束工单在删除循环中被人的消息 wake 复活并重建目录后，目录仍会被本次 pass 删掉，运行中回合产物丢失；③worktree remove --force 只在 prepare 失败路径使用，正常结束与 GC 都不走 git 拆除协议。',
  'worktree 是镜像仓库拥有的资源，生命周期应与创建方对称（acquire/release 成对）；GC 删除前 liveness 二次确认（mark-sweep 两阶段）',
  'GC 删除前重查工单状态；删除改为先 git worktree remove --force（按 ticket.execution 推导 repo 归属）再兜底 rm；最低成本在 GC pass 末尾对涉及镜像批量 prune',
  1, 'planned', 1, ''],
 ['E5', 'P2', '执行器', 'DSH_SUPERAGENT_SOURCE 环境变量可从任意目录钉定任意来源记录，绕过目录绑定的凭据最小授权',
  'src/infra/worker-sources.ts:109-110 (declared=process.env); :121 (pinned 命中即用不校验 cwd); src/app/execution-environment.ts:36 (合法注入点)',
  '目录→记录登记+祖先查找本意把凭据授权限定在工单/镜像目录内；但 declared 分支允许任何目录下任何进程用环境变量选中任意记录的 CLI 与 git 凭据（多记录安装下可跨项目取凭据）。使 011 §9.2-2「worker 默认不继承凭据」的验收存在漏洞——不继承不等于不能自取。',
  '授权 substrate 与便利通道分离；环境变量钉定应绑定 cwd 校验或一次性 token',
  '随 011 §9.2-2 收尾一并处理：declared 路径增加 cwd 必须命中登记目录的校验，或改为仅 prepare 进程可用的独立通道',
  1, 'planned', 1, '与011重复(§9.2-2)的补充面'],
 ['E6', 'P2', '执行器', 'recordTicketSource 登记只增不减：worker-sources.json 随工单数单调膨胀且残留陈旧映射',
  'src/infra/worker-sources.ts:68-74 (只有写入无删除); :59-65 (writeWorkerRecords 仅按记录 ID 过滤); GC 不清理登记',
  '每张工单启动写一条目录→记录映射，工单结束、目录 GC 后条目永久留存：文件无界增长；目录键 Windows 小写化，若 executor.directory 日后改到旧路径之下，陈旧映射参与祖先匹配把已删除工单的记录选择交给新会话。',
  '运行时登记表应有 TTL 或显式注销（与资源生命周期绑定）；journal 只增不减是存储腐化模式',
  '工单结束或 GC 删除目录时同步删除登记键；writeWorkerRecords 顺带按目录仍存在过滤',
  0.5, 'planned', 1, ''],
 ['E7', 'P2', '执行器', '项目目录名清洗双口径：launch 的 projectFolderName 未处理 Windows 保留设备名与首尾点空格',
  'src/executor/launch.ts:32 (trim+非法字符替换，保留.不查保留名); 对照 src/execution-paths.ts:13-24 (projectDirectoryName 完整处理 WINDOWS_RESERVED 与首尾[. ])',
  '项目名为 con/aux/nul（或「报告.」「x 」）时，来源推导路径正确清洗而项目调度路径得到未清洗名→mkdir 在 Windows 失败或产生不可访问目录，启动以晦涩 ENOENT/EINVAL 失败且非 PrepareFailed。两套洗名函数并存是 011 §9.2-13-C2「边界靠命名约定」的延续。',
  '同一不变量（safe directory name）应有单一事实来源',
  'projectFolderName 改为复用 projectDirectoryName（execution-paths 已是零依赖叶子可直接导入）；补保留名用例',
  0.5, 'planned', 1, ''],
 ['E8', 'P2', '执行器', 'Setup.resolve 串行探测所有来源与项目仓库：最坏 N×60 秒阻塞启动与设置保存',
  'src/app/setup.ts:398-408 (来源 for-await 逐条 await); setup.ts:410-420 (项目仓库同样逐条); deployment.ts:166 (每次 probe 60 秒硬超时); runtime 启动链路 await setup.run 后才 ready',
  '每条 GitHub/GitLab 记录与每个项目仓库的解析都是真实 CLI 网络探测；10 项目+2 来源、网络不佳时启动可拖数分钟，期间编排完全不可用。轮询侧已为同样问题做了副作用化+并发 limit，启动路径没有同等待遇。',
  '健康检查/预检应并行化并设整体预算（fan-out with bounded concurrency + deadline）',
  'resolveRecord/projectSource 用 POLL_CONCURRENCY 同值有限并发收集；错误归集逻辑不变',
  0.5, 'planned', 1, ''],
 ['E9', 'P2', '执行器', 'launch 成功路径 assignmentStarted 被调用两次：重复 defer deliver 与重复 emit 依赖下游幂等而非契约',
  'src/executor/launch.ts:169-172 (accepted 回调内调用后又显式调用); src/core/assignments.ts:42-43 (每次 started 都 defer deliver+emit); src/app/delivery.ts:83 (accepted 投递后同步回调)',
  '每次成功启动必然产生两次 started：defer 的 deliver 因 Effects 同键 upsert 侥幸合并无害，emit 的重复事件把「恰好一次」语义交给订阅者自觉——隐式时序耦合，依赖巧合幂等而非设计幂等。',
  '事件语义「恰好一次」应是契约而非巧合；副作用触发点唯一化',
  '二选一：删除 launch.ts:172 显式调用（accepted 即权威确认点），或 accepted 只做授权校验、提交事实统一在 prompt 返回后；补断言每次启动只 emit 一次',
  0.25, 'planned', 1, ''],
 ['E10', 'P2', '执行器', 'transient() 文本兜底正则过宽：错误文本中任意出现的 408/429/50x 数字都判为瞬态',
  'src/executor/idle.ts:23 (\\b(?:408|429|50[0-4])\\b); idle.ts:30-35 (无 status 时整体文本匹配)',
  '不要求 HTTP 上下文：错误消息里 issue #429、v1.503、timeout after 500ms 等数字片段（. # 均为非词字符，\\b 成立）即判可重试。影响有界（最多 3 次额外重试+退避≈105 秒）但拉长确定性失败并产生 retry 健康噪音。',
  '错误分类优先结构化信号（status/code）；文本兜底绑定上下文锚点（HTTP 429、status: 503）',
  '数字类匹配收紧为 (?:HTTP|status)\\s*[:=]?\\s*(408|429|50[0-4])\\b 形态；runtime-concurrency.spec 补负例',
  0.25, 'planned', 1, ''],
 ['E11', 'P2', '执行器', 'syncCode 远端变更时 rm-rf 镜像不清理 per-ticket worktree：被复活工单的目录将永久无法通过校验',
  'src/code-repos/sync.ts:133-138 (previous!==remote → rm 镜像后重新 init); workspace.ts:47-53 (残破目录 rev-parse 失败且非空→抛拒绝覆盖); src/core/tickets.ts:81-98 (wake 复活); deployment.ts:42-44 (worktree 保留 14 天)',
  '镜像重建使所有未回收 worktree 的 .git 文件指向不存在的 gitdir。结束工单被 wake 复活时 materializeWorkspace 在残破目录上抛「拒绝覆盖」→启动失败且无自愈路径（只有人工删目录）。SSH↔HTTPS 切换、实例地址修改都会改变派生远端，触发并不罕见。',
  '资源级联失效应有级联清理；重建引用而非删除对象库',
  '重建前先 worktree remove --force/prune 清存活元数据；或改 remote set-url+fetch+重置引用（不删对象库）；对 rev-parse 失败且带 .git 文件的目录主动走 removeWorkspace 自愈',
  1.5, 'planned', 1, '011 §7 部分点名，代码侧无防护'],
 # ---- 来源与凭据层 S1-S10 ----
 ['S1', 'P1', '来源与凭据', 'Excel 回写把本地提交写进「纯镜像」：远端前进后轮询永久失败，且任务清单永不推送远端',
  'src/task-sources/excel.ts:128-135 (回写后 commitWorkCopy 本地提交); excel.ts:59-66 (清单缺失自动建模板同样提交); src/code-repos/work.ts:36-38 (注释明示不推送); task-sources/kind.ts:137-141 (push 接口无实现); src/code-repos/sync.ts:154-156 (merge --ff-only); sync.ts:131-141 (镜像重建只在远端 URL 变化时)',
  '回写产生本地提交后镜像不再是纯镜像：队友往任务清单加任务（010 清单的正常用法）→远端前进→分叉→merge --ff-only 报错→syncRepo 抛错→此后每轮轮询失败，无自愈路径，只能手工删除镜像目录。同时因从不推送，回写结果与自动创建的清单只存在于本机，远端协作者看不到「已完成」——「清单在仓库里共享」的产品承诺实际不成立。',
  '幂等回写目标应是远端事实源收敛（write-behind），或状态写到不被 git 跟踪的 sidecar；本地提交不入远端又污染镜像是两头不占的反模式',
  '短期：syncCode 显式处理「本地领先/分叉」——实现 push（凭据已具备）或检测分叉时重建镜像并重放 writeback 副作用（Effects 幂等键保证安全）；中期把任务状态改写独立分支或 sidecar，镜像保持只读。补「回写提交→远端前进→下轮轮询」用例',
  4, 'planned', 1, '011 P0-2 修复的未预见后果；建议与 E5/E11 联动设计'],
 ['S2', 'P1', '来源与凭据', 'icacls 以 verbatim 参数调用且未加引号：用户路径/用户名含空格时整个凭据子系统不可用',
  'src/secrets/vault.ts:62-69 (spawnSync icacls windowsVerbatimArguments:true, 参数不引号); vault.ts:65-68 (非零退出码 throw secretUnreadable); save()/temporary() 都调用 restrict; git-credentials/probe.ts:14 依赖',
  'Node 在 windowsVerbatimArguments:true 下把参数原样空格拼接不加引号：用户目录如 C:\\Users\\John Smith\\... 会被 icacls 拆成两个参数而报错→创建/轮换任何凭据、SSH 探测全部失败，错误信息无法指向根因。非 verbatim 模式（默认）会自动为含空格参数加引号，恰是这里需要的。',
  'Secret 管理的可用性与安全性同等重要；ACL 收紧方向正确但参数构造必须适配 Windows 命令行规则',
  '去掉 windowsVerbatimArguments（或对 file/username 显式加引号）；补含空格临时目录的 Windows 用例（现有 ACL 测试用无空格 tmpdir 测不出）',
  0.5, 'planned', 1, '证据已主代理复核；0.5 人日修 4 处功能失效，性价比极高'],
 ['S3', 'P1', '来源与凭据', '多工作项任务的 contentHash 不含组合文本：任务描述/标题被修改后队列仍执行旧内容',
  'src/task-sources/tasks.ts:120 (item 路径 identity(item\\0part)); tasks.ts:112 (hash 输入只有工作项文本+任务 id); tasks.ts:125-128 (compose 拼标题与完整描述才是派工内容); tasks.ts:22-23 (注释与实现矛盾); src/app/scheduler-reconcile.ts:115-122 (未变化保留旧条目)',
  '单工作项任务的 hash 覆盖标题+正文是对的；但含复选框/编号列表的任务 hash 只覆盖列表项文本：用户修正验收标准或改标题后 contentHash 不变，已排队条目继续携带旧 compose 文本被派工。这正是 011 P1-3 要消灭的「改了描述系统仍执行旧内容」，§9.1 宣称已关闭但只修了一半。',
  '内容指纹应覆盖最终生效内容（派工文本），而非仅身份键',
  'item 路径改为用 compose(task, part) 的结果算 hash（itemKey 仍取工作项文本保持身份稳定）；补「改描述→条目换代」回归用例',
  1, 'planned', 1, '推翻 011 §9.1「P1-3 已关闭」的部分结论'],
 ['S4', 'P1', '来源与凭据', 'feishu-im 驱动不过滤机器人消息：senderType 已采集却未使用，机器人/系统消息全部变成任务',
  'src/task-sources/feishu-im.ts:107-113 (flatMap 直接映射无发送者过滤); feishu-im-api.ts:8-14+78-89 (ImMessage 已带 senderId/senderType); 对照 sources/feishu-trigger.ts:34 与 feishu.ts:86-89 (消息来源侧明确丢弃机器人)',
  '群里任何集成机器人（CI 通知/审批/公告）的每条消息都成为待办任务并建单执行；若群里存在会自动回复的机器人，形成「消息→任务→执行→新消息」自我放大循环，唯一上限是每轮 limit 窗口。排队去重只对同一条消息有效，对新产生的机器人回复无效。',
  '机器人消息来源必须显式区分人类与机器发送者（self-origin 过滤是反馈环防护基本功）；「谁能产生工作」适用最小权限',
  '默认跳过 senderType===bot 的消息（或可配置发送者白/黑名单）并在预检提示；补机器人消息被过滤的驱动级用例',
  0.5, 'planned', 1, ''],
 ['S5', 'P2', '来源与凭据', '每次凭据调用新建 TokenManager：tenant_access_token 无跨调用缓存；限流分类了但无退避',
  'src/app/runtime.ts:236-245 (每次 feishuWikiReader/feishuImReader 调用都新建 httpWikiApi/httpImApi); src/feishu-transport.ts:27-46 (token 缓存生命周期=单实例); feishu-transport.ts:114-118 (99991400→rateLimited 仅归因); feishu-api.ts:38-48 (paged 无退避)',
  '每个 feishu-wiki/im 项目每轮轮询、每次预检都重新换取 tenant token；多项目共享凭据时 token 端点被重复调用。429/99991400 时驱动直接把该轮判失败（靠下轮重试），无按 Retry-After/指数退避的针对性处理。',
  'Token 复用与限流退避是 API 客户端基本功',
  'Runtime 按 credential ID 缓存 TokenManager（凭据轮换/删除时失效）；paged 对 rateLimited 做一次短退避重试',
  1, 'planned', 1, '与011重复(§9.2-8 速率限制)的可先行子项'],
 ['S6', 'P2', '来源与凭据', '回写定位行用 ID 或标题 OR 匹配且不校验唯一性、不 trim 单元格：重名或带空格时写错行或永久失败',
  'src/task-sources/writeback.ts:56-62 (比较不 trim 单元格；find 取第一个命中无唯一性断言); src/task-sources/table.ts:468-473 (xlsx 同样 OR 匹配); writeback.spec.ts:40-45 (把标题兜底当特性测试); src/app/effects.ts:163 (Effects 无最大尝试)',
  'importTasks 只约束编号唯一，标题可重复；ID 列缺失时按标题定位，重名标题写到第一行。表格软件常见前后空格（如「 T-1 」）让精确比较失败→找不到任务→writeback 副作用按退避无限重试。',
  '外部键匹配应规范化（trim）且对歧义显式失败；写路径应有终止条件',
  '匹配时对单元格 trim；ID 与标题都可用时优先 ID 且命中多于一行报错拒绝（与导入「整批拒绝」哲学一致）；Effects 对 writeback 增加最大尝试/放弃标记并告警（与 C6 联动）',
  1, 'planned', 1, ''],
 ['S7', 'P2', '来源与凭据', 'CredentialService.update/rotate 缺 create 式回滚：vault 材料已替换而记录保存失败时留下不一致状态',
  'src/secrets/credential-service.ts:68-83 (create 失败回滚 vault.remove); :84-97 (update: vault.save 后直接 records.save 无回滚); :99-109 (rotate 同)',
  '「材料先落盘再写元数据，任一步失败都不留半条记录」的不变量只在 create 成立。update/rotate 中 records.save（SQLite 写）失败时新材料已覆盖旧材料而记录 revision 未递增——乐观并发保护被绕过，旧材料不可恢复（save 是整份覆盖）。',
  '编排式写操作应有补偿路径（saga 补偿事务）；两步写的不变量必须全程成立',
  'update/rotate 先读旧材料暂存，records.save 失败时写回旧材料；或材料替换+记录更新统一进同一失败补偿路径',
  0.5, 'planned', 1, ''],
 ['S8', 'P2', '来源与凭据', '目录级 git-credential 垫片仍在用 + 主密钥未 DPAPI 包裹（与011 §9.2-2 重复，补充观察）',
  'src/code-repos/sync.ts:124 (仍调用 recordTicketSource); src/infra/worker-sources.ts:106-127 (垫片按目录祖先发放); src/secrets/vault.ts:40-50 (AES 主密钥 base64 明文与密文同树存放)',
  '偷走整个 stateDir 即可解密全部凭据（主密钥与密文同目录）；镜像目录已登记使镜像内任何 git 都能取到仓库凭据。DPAPI（当前用户作用域）包裹主密钥是剩余项中性价比最高的一步；垫片移除需先解决 worker 会话内 git push 凭据来源（与 S1 联动）。',
  '密钥分层（KMS/DPAPI/TPM）；凭据发放与调用方身份绑定',
  '按 011 §9.2-2 原计划执行 DPAPI/ACL 收紧，并与 S1 的 push 设计、E5 的 declared 校验联动',
  2.5, 'planned', 1, '与011重复(§9.2-2)'],
 ['S9', 'P2', '来源与凭据', '同一项目的 poll 副作用与 writeback 副作用无共享互斥：镜像目录上的 git 操作可能并发',
  'src/app/scheduler.ts:430-434 (busy 只看执行器占用与队列在途); scheduler-writeback.ts:46-47 (writeback 忙时 Later 推迟但反向不成立); scheduler.ts:273+runtime.ts:329 (poll/writeback 两类 handler 独立注册); effects.ts:129-143 (per-key 去重只在同类内生效)',
  'writeback 运行中（syncRepo+写文件+commit）时到期的 poll 副作用照常启动并对同一镜像 fetch/checkout/merge：轻则 index.lock 冲突重试，重则 commit 落在 checkout 覆盖后的内容上或制造 S1 的分叉提交。',
  '共享可变资源的单写者约束应跨越所有写入通路',
  '给「项目镜像的 git 操作」加 per-project 进程内互斥（poll 与 writeback 共享）；或 busy() 扩展为「该项目存在运行中的 poll/writeback 副作用」（与 C4 同一修复的两个切面）',
  1, 'planned', 1, '与 C4 合并实施'],
 ['S10', 'P2', '来源与凭据', 'feishu-im 的 taskStatus 与项目 pendingStatuses 无交叉校验：不匹配时静默零任务',
  'src/task-sources/feishu-im.ts:22-24 (默认「待处理」，注释自述必须与项目准入状态一致); :78-79 (verify 对 taskStatus 恒 checkPassed); src/app/scheduler-reconcile.ts:88-90 (pending 过滤静默)',
  '用户把项目 pendingStatuses 改成 todo 而来源仍是默认「待处理」时，每轮轮询正常成功但永远零入队，面板与健康度都看不出异常——最易踩且最难排查的配置陷阱。',
  '配置间不变量应在预检期交叉验证；「零产出」与「全部被过滤」是两种健康状态',
  '项目预检（checkTaskSource 有项目上下文）对飞书类驱动增加 taskStatus∈pendingStatuses 交叉检查；或 reconcile 统计「被准入过滤掉的任务数」写入项目健康',
  0.5, 'planned', 1, ''],
 # ---- 面板与客户端 U1-U8 ----
 ['U1', 'P1', '面板与客户端', '工单/线程列表与搜索仍整表 JSON 解析+内存分页：分页下推只做了一半（只做了 queue）',
  'src/app/store.ts:332 (tickets.list() 全表解析+逐行 schema 校验); views/tickets.ts:40 (已结束页每次全表 filter/sort/slice); views/threads.ts:19-21 (recent/all 走全表); views/threads.ts:76 (搜索对全表 matches); store-read.ts:56 (search 是未索引 LIKE 扫描); resources.ts:135; 对照 store.ts:366-368 (queue 已下推)',
  'ticket/thread 随时间单调增长（无保留期），GET tickets?state=ended、GET threads?filter=all、GET search 成本 O(全表)×轮询周期（5 秒一次），且每行跑 schema 校验。这是 011 §9.2-1 对 queue 修掉的同一种模式，ticket/thread/search 三条路径没有跟进（011 R6 只对 queue 执行）。',
  'REST 列表端点过滤/排序/分页全部下推存储层（SQL WHERE/ORDER BY/LIMIT），视图层只做投影',
  'ticket 表补 open/ended 生成列与索引（DDL 漂移机制可复用），ended 分页改 SQL LIMIT/OFFSET；threadList recent/all 按 lastAt 列化排序下推；GET search 限 term 数量、工单标题匹配 LIKE 下推或 FTS',
  2.5, 'planned', 1, ''],
 ['U2', 'P1', '面板与客户端', '客户端整棵组件树无 ErrorBoundary：渲染异常直接击穿插件（可能波及宿主工作区）',
  '全 src/client/ 无 ErrorBoundary|componentDidCatch 匹配; src/client/app.tsx:187-188 与 index.tsx:53-54 均无边界; 脆弱点 projects.tsx:323 (new Date(item.dueAt).toISOString() 绕过 text.ts:52-55 的 NaN 守卫); records.ts:89 / threads.ts:80 / app.tsx:93 (threads[0]! 非空断言，被过滤触发器无线程记录)',
  '数据获取错误已被 usePoll/useAction 兜住，但渲染期异常没有任何防线：轮询每 3-5 秒喂新数据，服务端字段漂移就是最现实触发源；一行脏数据可能白屏整个 DSH 工作区而不只本插件页签。',
  'React 官方实践：至少根级 ErrorBoundary+路由级兜底+异常上报；嵌入宿主的插件面板更应隔离故障域+降级 UI+重试入口',
  'App 外层与 Pages 的 page 分支各加边界（fallback 本地化文案+重载按钮复用 restart）；audit threads[0]! 断言；修 projects.tsx:323 的时间守卫；补「脏数据不白屏」回归测试',
  1, 'planned', 1, ''],
 ['U3', 'P2', '面板与客户端', '向导创建的项目 ID 固定为 project/project-2…，不派生自项目名',
  'src/client/projects.tsx:449-457 (向导 POST 无 id); routes.ts:203-204 (透传 undefined); settings.ts:325+354-362 (recordId 按 project、project-2 递增)',
  '用户填的名字不进标识，第 N 个项目永远是 project-N；该 ID 出现在设置块名、队列条目、worktree 目录（repo-<id>）与告警文本里，排查时无法从目录名/队列记录对应到项目。',
  '资源创建从标题派生 slug（去重后缀），或显式 id 作为高级选项',
  'recordId 增加从名称派生的回退（非法字符替换+冲突递增），或向导提交时前端生成',
  0.5, 'planned', 1, ''],
 ['U4', 'P2', '面板与客户端', '向导默认值客户端硬编码且显式提交：与服务端 schema 双份维护，服务端默认值失效',
  'src/client/projects.tsx:360-363 (PROJECT_DEFAULTS 硬编码); 对照 projects/kind.ts:53-65 (服务端默认值); projects.tsx:452-456 (预填值解析后显式提交使 .default() 永不生效); projects.tsx:364+389 (注释「由服务端补默认值」与实际不符)',
  '两处事实来源：服务端调整默认重试/轮询参数后，新向导仍预填旧值并落库；pendingStatuses 默认四同义词与 010 固定枚举的张力在这个复制点再次松动。',
  '表单默认值单一来源——服务端元数据下发，客户端只渲染（类型目录已走这条路）',
  'GET settings 的项目分区下发 ProjectSchema 默认值（或新增 projectDefaults），emptyWizard 从响应构造；删除 PROJECT_DEFAULTS',
  0.75, 'planned', 1, ''],
 ['U5', 'P2', '面板与客户端', '校验层一致性缺口：GET search 无 schema、查询参数 .catch() 静默兜底、500 响应泄漏原始错误消息',
  'src/app/http/routes.ts:169 (query.q 直接消费无 schema 无长度上限); schemas.ts:8-10+15-16 (state/window .catch() 静默改默认值); server.ts:45 (500 返回 error.message 原文)',
  '客户端拼错 state=runing 会看到 open 列表且毫无提示（客户端 bug 被服务端兜底掩盖）；内部异常消息（可能含绝对路径/SQL 片段）原样回给客户端，无结构化 code。',
  '严格校验的 API 对非法枚举返回 400+issues（项目对 body 已是这么做的）；错误响应区分用户可读消息与内部诊断（后者进日志+请求 ID）',
  '补 SearchQuery schema（q trim+长度上限）；.catch() 收窄到 offset/limit 这类确需兜底的分页参数，枚举改 400；500 改 {error:Internal error, code, requestId} 并记日志',
  1, 'planned', 1, ''],
 ['U6', 'P2', '面板与客户端', '健康探针被同源 CSRF 拦截：标准监控工具无法探测',
  'src/app/http/server.ts:82-84 (sameOrigin 在路由匹配前对所有路径生效含 GET health); server.ts:28-33 (三重校验); routes.ts:260-261+126 (health 设计意图是对外探针，scripts/dsh-superagent status 依赖)',
  '任何不带自定义头的标准探针（curl、uptime 工具、容器健康检查）都拿 403 而非健康状态。CSRF 防护本身实现正确，但不该覆盖只读 liveness 探针。',
  '健康端点（/healthz /readyz）按惯例不做 CSRF/认证；CSRF 保护应用于状态变更端点',
  'sameOrigin 之前放行 GET health（保留 Host 回环校验），或 403 分支对 GET health 返回最小化 {ok, stage}',
  0.5, 'planned', 1, ''],
 ['U7', 'P2', '面板与客户端', 'i18n 动态键绕过编译期穷举守卫：queueState.* 等服务端演进枚举无覆盖保障',
  'src/client/locales.ts:34-46 (编译期守卫只覆盖 reason/stage/setup/userError/healthCode 五组); projects.tsx:321 (t(`queueState.${item.state}`) 模板拼接); text.ts:18-23 (valueLabel 缺键把键名原样显示); locales.spec.ts:10-26 (无 queueState/report/assignment/outcome 码表覆盖)',
  '调度器新增队列状态（如 011 曾建议的 superseded）时，面板状态列显示 queueState.superseded 原文且无测试变红。',
  'i18n 键覆盖应在类型层或测试层穷举「所有可能枚举值×所有语言」；运行时回退是最后防线且应上报',
  'queueState.* 加入编译期守卫（服务端状态是 TS 联合类型可直接引用）；其余 valueLabel 组在 locales.spec 增加与领域枚举双向 diff；valueLabel 缺键回退时接 notify/console.warn',
  0.75, 'planned', 1, ''],
 ['U8', 'P2', '面板与客户端', '前端轮询与时间线合并存在失控与开销风险',
  'src/client/thread.tsx:91-99 (补洞 while 循环无迭代上限，深链旧触发器连续几十次请求); api.ts:71+91 (每次轮询两次全量 JSON.stringify 比对); projects.tsx:245-246 (列表页同时轮询全量 GET settings 5s 与 GET queue 3s)',
  '深链+大间隙时补洞循环连续请求无上限；全量 stringify 比对面板最大响应之一（settingsView 聚合下发）浪费明显；列表页只需要摘要却拉全量设置。',
  '数据比对用哈希/版本号（服务端已有 revision/policyVersion 可直接利用）；无限回溯必须有最大页数保护；列表页用摘要端点',
  'useThreadTimeline 补洞循环加 maxPages（如 10）并给「在此中断」提示；usePoll 对带 revision 的响应直接比较版本号；ProjectsPage 改轻量摘要或支持批量 id',
  1, 'planned', 1, ''],
]
for row in findings:
    ws.append(row)
style_sheet(ws, [7, 6, 11, 34, 46, 52, 40, 52, 9, 9, 6, 30])
fill_by_level(ws, 2, 2)
for r in range(2, ws.max_row + 1):
    ws.cell(r, 1).font = Font(bold=True)
    ws.row_dimensions[r].height = 150

# ---------- 03 重构路线图 ----------
ws = wb.create_sheet('03 重构路线图')
headers = ['批次', '主题', '包含发现', '重构动作（按序）', '验收标准', '预估工作量(人日)', '状态', '轮次']
ws.append(headers)
roadmap = [
 ['R1 正确性速修', '幂等键与重试语义修复（最高优先级：两条可致流水线卡死的缺陷）',
  'C1; E1; S2; E2; E3',
  '① E1：WorkerState 增加单调 retrySeq 参与 requestId，补双失败回归用例；② C1：attempt 与触发器代次拆分（epoch=entry.tickets.length 参与 triggerId），settleOutcome 对已结束工单显式报错，补耗尽重试→手动重试用例；③ S2：去掉 windowsVerbatimArguments，补含空格路径用例；④ E2：分支缺失改为显式报错；⑤ E3：lark 输出解析复用 firstParsed 容错',
  'pnpm check 通过；新增 5 条回归用例全部变绿；耗尽重试的条目在面板点重试后产生新工单并真实执行；含空格用户目录下可创建凭据；切换分支后 worker 不在旧基线执行',
  4.5, 'planned', 1],
 ['R2 调度语义修复', 'person 接管、回写聚合与互斥（产品语义层）',
  'C2; C3; C4+S9; S3; S4',
  '① C2：person 接管改为白名单（blocked/failed）+项目级超时；answer/review 不接管；② C3：回写按「全部工作项终态」聚合，payload 增 expectedStatus 做 CAS，不匹配告警人工仲裁；③ C4/S9：reconcile.poll 入口 per-project in-flight Set（scan/tick/pollNow/writeback 四通路共享互斥）；④ S3：contentHash 改用 compose 后文本计算；⑤ S4：feishu-im 默认过滤 senderType=bot',
  'worker 提问不再被 15 秒强停；多工作项任务的清单状态只写一次且与队列真实进度一致；并发 scan+poll 无 index.lock；改任务描述后队列条目换代；机器人消息不再建单',
  6, 'planned', 1],
 ['R3 镜像与派生资源生命周期', '回写-镜像-登记表-worktree 的资源闭环（与凭据收尾联动）',
  'S1; E11; E4; E6; C6; S6',
  '① S1：实现驱动 push（回写提交后推送远端）或「分叉检测→重建镜像→重放 writeback」；镜像本地提交策略二选一定案；② E11：远端变更重建前清 worktree 元数据或改 set-url+fetch；③ E4：GC 改两阶段（先 worktree remove 再 rm），删除前 liveness 复查；④ E6：工单结束/GC 时删登记键；⑤ C6：Effects 死信终态+面板重放；⑥ S6：回写行定位 trim+唯一性断言（复用 C6 死信防无限重试）',
  '队友前进远端后轮询自愈且清单推送成功；远端切换后复活工单可自愈；GC 后镜像无 worktree 元数据残留；writeback 失败 10 次进入死信并告警',
  8, 'planned', 1],
 ['R4 运维与可观测性', '读路径下推、保留期、死信与配置陷阱（性能+排障）',
  'U1; C5; C7; E8; S5; S7; S10',
  '① U1：ticket/thread 列化+分页下推，search 限流；② C5：健康统计 SQL 化，lastError/deferred 落 KV，trigger/outbox 保留窗口；③ C7：queue 扫描路径隔离损坏行；④ E8：Setup 探测有限并发；⑤ S5：TokenManager 按 credential ID 缓存；⑥ S7：update/rotate 补偿回滚；⑦ S10：taskStatus 与 pendingStatuses 交叉预检',
  '已结束工单页响应时间与终态行数解耦；重启后面板保留 lastError；单行损坏不瘫痪调度；10 项目启动时间可预期；同凭据多项目不再重复换 token',
  8, 'planned', 1],
 ['R5 面板与前端健壮性', '故障域隔离与事实单一来源',
  'U2; U4; U5; U6; U7; U8; U3; E9; E10; E7',
  '① U2：根级+页面级 ErrorBoundary+脏数据回归测试；② U4：默认值改服务端下发；③ U5：search schema+枚举 400+500 脱敏；④ U6：health 放行 CSRF；⑤ U7：queueState 编译期守卫+码表双向 diff；⑥ U8：补洞 maxPages+revision 比对；⑦ 其余小项（U3/E9/E10/E7）随手修',
  '注入脏数据面板不白屏；标准探针可探测健康；新增队列状态不再显示原始键；补洞有上限',
  6, 'planned', 1],
 ['R6 安全收尾（并入011剩余项）', '凭据最小授权与密钥分层',
  'E5; S8; S7(验证)',
  '① 按 011 §9.2-2：确认 worker 默认不继承凭据、目录级垫片移除（依赖 R3 的 push 设计）；② DPAPI 包裹主密钥+icacls ACL（S2 修复后复验）；③ E5：DSH_SUPERAGENT_SOURCE 绑定 cwd 校验',
  '011 §9.2-2 的验收项全部通过；worker 会话内无法自取跨项目凭据；偷取 stateDir 无法单独解密密文',
  3, 'planned', 1],
]
for row in roadmap:
    ws.append(row)
style_sheet(ws, [14, 34, 14, 60, 55, 13, 9, 6])
fill_by_level(ws, 7, 2)
for r in range(2, ws.max_row + 1):
    ws.cell(r, 1).font = Font(bold=True)
    ws.row_dimensions[r].height = 120

# ---------- 04 与011对照 ----------
ws = wb.create_sheet('04 与011对照')
headers = ['关系', '条目', '说明']
ws.append(headers)
cross = [
 ['新发现（011 未覆盖）', 'E1 E3 E4 E6 E7 E8 E9 E10 E11 S1 S2 S3 S4 S5 S6 S7 S9 S10 U1 U2 U3 U4 U5 U6 U7 U8 C2 C3 C5 C6 C7',
  '011 §9.1/§9.2 均未列出；其中 S1 是 011 P0-2 修复的未预见后果，需回写 011 §9.2。'],
 ['推翻已关闭结论（需回写 011）', 'C4 → §9.2-1「轮询并发已关闭」；S3 → §9.1「P1-3 已关闭」；C3 → §9.1「P0-3 已关闭」（CAS 未实现）',
  '三处的关闭论证不完整：C4 只对齐了并发上限数值、未对齐资源互斥；S3 的内容哈希未覆盖组合文本；C3 的回写只落了 Effects 化、原建议的 CAS 未做。'],
 ['重复/补充（与011 §9.2 剩余清单同向）', 'S5→§9.2-8（速率限制先行子项）；S8/E5→§9.2-2（凭据收尾，E5 的 env 钉定面为补充）；C5 部分→§9.2-5（可观测性）；C1 与 P0-1 同源但针对手动重试路径（新场景）',
  '实施时与 011 剩余清单合并排期，避免两处跟踪。'],
 ['路线图合并建议', '011 §9.2 剩余 13 项中：第2/4/5/6/8 项已被本表 R1-R6 批次覆盖或部分覆盖；第9项（测试策略）分散在各批次验收标准；第7/10/11/12 项（飞书回写目标/发布/备份/群列表实测）仍以 011 为准',
  '建议以本表 02/03 为主跟踪表，011 §9.2 引用本表行号，保持单一事实来源。'],
]
for row in cross:
    ws.append(row)
style_sheet(ws, [26, 62, 70])
for r in range(2, ws.max_row + 1):
    ws.cell(r, 1).font = Font(bold=True)
    ws.row_dimensions[r].height = 90

wb.save(r'D:\dsh-superagent\docs\optimization-plan.xlsx')
print('saved:', r'D:\dsh-superagent\docs\optimization-plan.xlsx')
print('sheets:', wb.sheetnames)
print('findings rows:', len(findings))
