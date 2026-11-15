# -*- coding: utf-8 -*-
"""第 7 轮：C3 完成（回写聚合 + CAS），R2 批次全部收官，更新 optimization-plan.xlsx。"""
from openpyxl import load_workbook
from openpyxl.styles import PatternFill, Font, Border, Side, Alignment

PATH = r'D:/dsh-superagent/docs/optimization-plan.xlsx'
THIN = Border(*[Side(style='thin', color='BFBFBF') for _ in range(4)])
WRAP = Alignment(wrap_text=True, vertical='top')
DONE_FILL = PatternFill('solid', fgColor='70AD47')

wb = load_workbook(PATH)
ws = wb['02 发现总表']
for r in range(2, ws.max_row + 1):
    if str(ws.cell(r, 1).value) == 'C3':
        ws.cell(r, 10, 'done')
        ws.cell(r, 10).fill = DONE_FILL
        ws.cell(r, 11, 7)
        old = str(ws.cell(r, 12).value or '')
        note = ('R2已修（第7轮）：①聚合——writeBack 只在该任务的全部工作项条目都终态时入队一次回写，'
                '最终状态由全部条目聚合（全成功→doneStatus，任一最终失败→failedStatus），多工作项任务不再由最后结算的项决定清单状态'
                '（scheduler-writeback.ts:33-56）；②CAS——WritebackPayload/WriteTarget 增加 expectedStatus，'
                'CSV/TSV/xlsx 与飞书 bitable 四条写入路径写前校验当前状态，不匹配拒绝并提示人工仲裁'
                '（writeback.ts:66-68、table.ts:478-486、feishu-wiki.ts:139-150）。回归用例×2：queue.spec「多工作项任务的回写按任务聚合…」（聚合恰一次+失败聚合）'
                '与 writeback.spec「rejects the write when the current status no longer matches…」（拒绝覆盖人工修改+宽容空白匹配）')
        ws.cell(r, 12, (old + '；' if old else '') + note)
        ws.cell(r, 12).alignment = WRAP

ws3 = wb['03 重构路线图']
for r in range(2, ws3.max_row + 1):
    if str(ws3.cell(r, 1).value or '').startswith('R2'):
        ws3.cell(r, 7, 'done')
        ws3.cell(r, 7).fill = DONE_FILL
        old = str(ws3.cell(r, 5).value or '')
        ws3.cell(r, 5, old + '』验收记录（第7轮收官）：C3 完成——回写聚合 + expectedStatus CAS 全链路（CSV/TSV/xlsx/bitable）。R2 六项全部落地，1372 例全绿（新增 2 条 C3 回归用例）。')

ws0 = wb['00 说明']
ws0.append(['第 7 轮（2026-11-15）',
  'R2 批次收官：C3 完成——①回写按任务聚合（全部工作项终态才写一次，状态由全部结果决定）；②expectedStatus CAS 贯通四条写入路径（CSV/TSV/xlsx/飞书 bitable），人工修改不再被无提示覆盖。pnpm check 全绿（1372 例）。累计 done：C1/C2/C3/C4/E1/E2/E3/S2/S3/S4/S9 共 11 项（13 条 P1 已修 9 条，余 E1 外全部 P1 已修——实际剩余 P1：U1/U2，均在 R4/R5 批次）。下一批：R3 镜像与派生资源生命周期（S1/E11/E4/E6/C6/S6，8 人日）。'])
ws0.cell(ws0.max_row, 1).font = Font(bold=True)
for c in (ws0.cell(ws0.max_row, 1), ws0.cell(ws0.max_row, 2)):
    c.fill = PatternFill('solid', fgColor='DDEBF7')
    c.border = THIN
    c.alignment = WRAP
ws0.cell(ws0.max_row, 1).font = Font(bold=True)

wb.save(PATH)

wb2 = load_workbook(PATH)
w2 = wb2['02 发现总表']
done = [str(w2.cell(r, 1).value) for r in range(2, w2.max_row + 1) if str(w2.cell(r, 10).value) == 'done']
print('done total:', len(done), done)
