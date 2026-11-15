# -*- coding: utf-8 -*-
"""第 2 轮：主代理交叉复核关键证据后更新 optimization-plan.xlsx。

动作：
1. 02 发现总表新增「证据复核」列（M），标注已复核条目及方式；
2. C1 备注强化（设计注释自证约束）；00 说明表更新轮次记录。
"""
from openpyxl import load_workbook
from openpyxl.styles import Font, PatternFill, Border, Side, Alignment

PATH = r'D:\dsh-superagent\docs\optimization-plan.xlsx'
THIN = Border(*[Side(style='thin', color='BFBFBF')] * 4)
WRAP = Alignment(wrap_text=True, vertical='top')
CHECKED_FILL = PatternFill('solid', fgColor='C6EFCE')

# 已由主代理亲自读取代码复核的条目：编号 -> (复核方式, 结论)
rechecked = {
 'C1': ('主代理复读 scheduler.ts:391-401 + scheduler-dispatch.ts:117-133', '属实。且发现强化证据：scheduler-dispatch.ts:122 注释自证「复用已结束工单的触发器只会拿回旧工单」——设计者知道约束，但 retryEntry 的 attempt 归零恰好违反它'),
 'C2': ('主代理复读 scheduler-dispatch.ts:187-200 + stage 枚举 grep', '属实。settleOutcome L196-198 对 person 阶段一律 stop-then-retry，覆盖 answer/review'),
 'E1': ('主代理 grep idle.ts:58/96 + delivery.ts:75', '属实。requestId=retry:<assignmentId>:<tries>，tries 在回合成功后清零'),
 'E2': ('主代理 grep workspace.ts:56-59', '属实。refs/heads/<branch> 查不到本地引用即回退 HEAD'),
 'S2': ('主代理 grep vault.ts:62-69', '属实。spawnSync icacls windowsVerbatimArguments:true 且参数不加引号'),
 'S3': ('主代理复读 tasks.ts:95-134', '属实。identity() 的 hash 输入只有 part+task.id（L112），不含 compose(task, part) 的完整派工文本（L119-120）；单工作项路径 L116 的 hash 覆盖标题+正文，对比明确'),
 'U1': ('主代理 grep views/tickets.ts:40 + views/threads.ts:19/76', '属实。ended 页与搜索均走 tickets.list() 全表解析'),
}

wb = load_workbook(PATH)
ws = wb['02 发现总表']

# 新增 M 列「证据复核」
ws.cell(1, 13, '证据复核')
ws.cell(1, 13).fill = PatternFill('solid', fgColor='1F4E79')
ws.cell(1, 13).font = Font(bold=True, color='FFFFFF', size=11)
ws.cell(1, 13).alignment = WRAP
ws.cell(1, 13).border = THIN
ws.column_dimensions['M'].width = 40

status_by_id = {}
for r in range(2, ws.max_row + 1):
    fid = str(ws.cell(r, 1).value or '')
    if fid in rechecked:
        how, verdict = rechecked[fid]
        ws.cell(r, 13, f'已复核（{how}）：{verdict}')
        ws.cell(r, 13).fill = CHECKED_FILL
    else:
        ws.cell(r, 13, '子代理报告（待主代理复核）')
    ws.cell(r, 13).alignment = WRAP
    ws.cell(r, 13).border = THIN

# C1 备注强化（追加到 L 列备注）
for r in range(2, ws.max_row + 1):
    if str(ws.cell(r, 1).value) == 'C1':
        note = str(ws.cell(r, 12).value or '')
        ws.cell(r, 12, note + '；第2轮复核追加：scheduler-dispatch.ts:122 的实现注释已自证该约束（「复用已结束工单的触发器只会拿回旧工单」），修复时可直接引用')

# 更新 00 说明：追加第 2 轮记录
ws0 = wb['00 说明']
ws0.append(['第 2 轮（2026-11-15）', '证据交叉复核：主代理亲自复读 7 条关键发现的源码（C1/C2/E1/E2/S2/S3/U1），全部属实；C1 获强化证据（设计注释自证约束）。复核结果已写入 02 表新增「证据复核」列（M 列，绿色=已复核）。其余 29 条为子代理报告，待后续轮次按批次实施时随修随验。'])
ws0.cell(ws0.max_row, 1).font = Font(bold=True)
ws0.cell(ws0.max_row, 1).fill = PatternFill('solid', fgColor='DDEBF7')
for c in (ws0.cell(ws0.max_row, 1), ws0.cell(ws0.max_row, 2)):
    c.border = THIN
    c.alignment = WRAP

wb.save(PATH)

# 自验
wb2 = load_workbook(PATH)
w2 = wb2['02 发现总表']
assert w2.cell(1, 13).value == '证据复核'
green = sum(1 for r in range(2, w2.max_row + 1) if str(w2.cell(r, 13).value or '').startswith('已复核'))
print('M列标题OK；已复核行数:', green, '；总行数:', w2.max_row - 1)
print('C1备注含追加:', '第2轮复核追加' in str(w2.cell(2, 12).value))
w0 = wb2['00 说明']
print('00表行数:', w0.max_row, '；第2轮记录:', str(w0.cell(w0.max_row, 1).value).startswith('第 2 轮'))
