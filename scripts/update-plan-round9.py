# -*- coding: utf-8 -*-
"""第 9 轮：R3 批次收官——S1/E11/E6/C6/S6 全部落地（E4 第 8 轮已完成），更新 optimization-plan.xlsx。"""
from openpyxl import load_workbook
from openpyxl.styles import PatternFill, Font, Border, Side, Alignment

PATH = r'D:/dsh-superagent/docs/optimization-plan.xlsx'
THIN = Border(*[Side(style='thin', color='BFBFBF') for _ in range(4)])
WRAP = Alignment(wrap_text=True, vertical='top')
DONE_FILL = PatternFill('solid', fgColor='70AD47')

NOTE = {
    'S1': ('R3已修（第9轮，P1）：回写推送远端全链路——①excel 驱动实现 push（委托调度器装配的认证出口，'
           'TaskSourcePushContext.push 由 Runtime 注入凭据/SSH/git 超时，kind.ts/excel.ts:131-146）；'
           '②Runtime 新增 pushProjectRepo 与回写路径专用 syncRepoForWrite（runtime.ts:491-517、scheduler 装配）；'
           '③syncCode 新增 resetOnDivergence：回写路径分叉时重置到远端——本副作用仍在退避重试中，写入重放（CAS 期望值与重置后状态一致）'
           '后重推收敛；轮询路径保持无损失败（sync.ts:95-107、161-178）；④本地领先且远端未动→保留回写提交（第8轮三分支）。'
           '回归×5：code-repos「resets to the remote on divergence…」×1+pushCode×3、queue「回写成功后调用驱动 push…」×1、'
           'task-sources「push 委托…」×1。009 §设计原则5 与 §503 同步更新'),
    'E11': ('R3已修（第9轮）：远端变更重建镜像前先 detachWorktrees——worktree list --porcelain 枚举附属工单目录，'
            '逐个 git worktree remove --force（失败不阻塞），rm 镜像不再留下指向已消失 gitdir 的残破目录，'
            '复活工单的 materialize 校验可自愈（sync.ts:200-215、253-261）。回归×1：code-repos「detaches per-ticket worktrees…」'),
    'E6': ('R3已修（第9轮）：①GC 删除目录成功后 forgetTicketSource 注销登记（workspace-gc.ts:31-35、runtime 装配）；'
           '②writeWorkerRecords 自愈过滤目录已消失的悬空登记（worker-sources.ts:59-68）——worker-sources.json '
           '不再随工单数单调膨胀，陈旧映射不再参与祖先匹配。回归×1：worker-sources「forgets ticket registrations…」'),
    'C6': ('R3已修（第9轮）：副作用连续失败 MAX_EFFECT_ATTEMPTS=10 后退入死信——due 推到 2100 哨兵（分发永不出队）、'
           '行保留、健康条目点名「N dead-lettered after 10 attempts (replay required)」并转 error；'
           'Effects.replay 与同键 enqueue 均可重放（清零尝试立即到期）（effects.ts:8-21、157-163、174-186；store.ts replay/stats）。'
           '回归×1：effects「永久失败的副作用在第 MAX 次后退入死信…」。面板一键重放入口随 R5 面板批次接入'),
    'S6': ('R3已修（第9轮）：回写行定位规范化——①单元格 trim 后比较（表格软件前后空格不再让回写永久失败）；'
           '②ID 列可用且命中时优先按 ID（标题重复不产生歧义），否则按标题兜底；③选定键命中多于一行显式拒绝'
           '（「匹配到 N 行」）而不是写错第一行（writeback.ts:60-77、table.ts updateSheet）。'
           '无限重试由 C6 死信兜底。回归×2：writeback.spec「trims cell padding…」「rejects the write when the chosen key…」（xlsx 同路径 ×1）'),
}

wb = load_workbook(PATH)
ws = wb['02 发现总表']
for r in range(2, ws.max_row + 1):
    code = str(ws.cell(r, 1).value)
    if code in NOTE:
        ws.cell(r, 10, 'done')
        ws.cell(r, 10).fill = DONE_FILL
        ws.cell(r, 11, 9)
        old = str(ws.cell(r, 12).value or '')
        ws.cell(r, 12, (old + '；' if old else '') + NOTE[code])
        ws.cell(r, 12).alignment = WRAP

ws3 = wb['03 重构路线图']
for r in range(2, ws3.max_row + 1):
    if str(ws3.cell(r, 1).value or '').startswith('R3'):
        ws3.cell(r, 7, 'done')
        ws3.cell(r, 7).fill = DONE_FILL
        old = str(ws3.cell(r, 5).value or '')
        ws3.cell(r, 5, old + '』验收记录（第9轮收官）：S1 push 全链路 + resetOnDivergence 收敛；E11 重建前拆 worktree；E6 登记注销+自愈；C6 死信终态+replay；S6 行定位 trim+ID 优先+唯一性断言。R3 六项全部落地。')
        ws3.cell(r, 5).alignment = WRAP

ws0 = wb['00 说明']
ws0.append(['第 9 轮（2026-11-15）',
  'R3 批次收官（commit 310ba07+后续）：S1（P1）——回写推送远端全链路落地：excel 驱动声明 push 并委托调度器装配的认证出口，'
  '推送被拒随回写副作用退避重试，syncCode 新增 resetOnDivergence（回写路径分叉时重置+重放+重推，收敛到远端事实；轮询保持无损三分支）；'
  'E11 重建镜像前拆除附属 worktree；E6 登记表注销+自愈收缩；C6 副作用死信终态（10 次上限、健康点名、replay 重放；面板入口随 R5）；'
  'S6 回写行定位 trim+ID 优先+唯一性断言。R3 六项全部 done（累计 17/36）。下一批：R4 运维与可观测性（U1/C5/C7/E8/S5/S7/S10，8 人日）。'])
ws0.cell(ws0.max_row, 1).font = Font(bold=True)
for c in (ws0.cell(ws0.max_row, 1), ws0.cell(ws0.max_row, 2)):
    c.fill = PatternFill('solid', fgColor='DDEBF7')
    c.border = THIN
    c.alignment = WRAP

wb.save(PATH)

wb2 = load_workbook(PATH)
w2 = wb2['02 发现总表']
done = [str(w2.cell(r, 1).value) for r in range(2, w2.max_row + 1) if str(w2.cell(r, 10).value) == 'done']
print('done total:', len(done), done)
