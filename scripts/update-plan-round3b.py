# -*- coding: utf-8 -*-
"""第 3 轮收尾：C3/E3 复核落表，实现 P1 级复核全覆盖（13/13）。"""
from openpyxl import load_workbook
from openpyxl.styles import PatternFill, Border, Side, Alignment, Font

PATH = r'D:\dsh-superagent\docs\optimization-plan.xlsx'
THIN = Border(*[Side(style='thin', color='BFBFBF') for _ in range(4)])
WRAP = Alignment(wrap_text=True, vertical='top')
CHECKED_FILL = PatternFill('solid', fgColor='C6EFCE')

round3b = {
 'C3': ('主代理 grep+复读 scheduler-writeback.ts:10-15', '属实。WritebackPayload 只有 project/task/taskTitle/status 四字段，无 item/itemKey/expectedStatus——任务级回写且无 CAS 确认'),
 'E3': ('主代理 grep commands.ts', '属实。L209 JSON.parse(output) 直接解析整段 stdout；L48（gh 的 stderr 解析）与探测路径（deployment.ts firstParsed）有容错而主路径没有——同一 CLI 家族两种口径'),
}

wb = load_workbook(PATH)
ws = wb['02 发现总表']
for r in range(2, ws.max_row + 1):
    fid = str(ws.cell(r, 1).value or '')
    if fid in round3b:
        how, verdict = round3b[fid]
        ws.cell(r, 13, f'已复核（{how}）：{verdict}')
        ws.cell(r, 13).fill = CHECKED_FILL
        ws.cell(r, 13).alignment = WRAP
        ws.cell(r, 13).border = THIN

# 00 说明追加记录
ws0 = wb['00 说明']
ws0.append(['第 3 轮（补充）', 'P1 级复核全覆盖：C3/E3 补验属实（WritebackPayload 无 expectedStatus；commands.ts:209 主路径直接 JSON.parse）。至此 13/13 条 P1 全部由主代理亲自核验源码确认，P2 复核 6/23。累计复核 19/36，均未发现误报。'])
ws0.cell(ws0.max_row, 1).font = Font(bold=True)
ws0.cell(ws0.max_row, 1).fill = PatternFill('solid', fgColor='DDEBF7')
for c in (ws0.cell(ws0.max_row, 1), ws0.cell(ws0.max_row, 2)):
    c.border = THIN
    c.alignment = WRAP
    c.fill = PatternFill('solid', fgColor='DDEBF7')
ws0.cell(ws0.max_row, 1).font = Font(bold=True)

wb.save(PATH)

wb2 = load_workbook(PATH)
w2 = wb2['02 发现总表']
green = [str(w2.cell(r, 1).value) for r in range(2, w2.max_row + 1)
         if str(w2.cell(r, 13).fill.fgColor.rgb).endswith('C6EFCE')]
p1 = [str(w2.cell(r, 1).value) for r in range(2, w2.max_row + 1) if str(w2.cell(r, 2).value) == 'P1']
print('total_green:', len(green))
print('p1_all_green:', all(x in green for x in p1), f'({len([x for x in p1 if x in green])}/{len(p1)})')
