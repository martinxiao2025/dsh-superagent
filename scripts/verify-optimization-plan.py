# -*- coding: utf-8 -*-
"""校验 docs/optimization-plan.xlsx：sheet 名、行数、关键单元格、级别着色。"""
import json
from openpyxl import load_workbook

wb = load_workbook(r'D:\dsh-superagent\docs\optimization-plan.xlsx', data_only=False)
report = {}
report['sheets'] = wb.sheetnames

ws = wb['02 发现总表']
ids, levels, statuses = [], [], []
for row in ws.iter_rows(min_row=2, values_only=True):
    if row[0]:
        ids.append(row[0])
        levels.append(row[1])
        statuses.append(row[9])
report['finding_count'] = len(ids)
report['ids'] = ids
report['level_counts'] = {lv: levels.count(lv) for lv in set(levels)}
report['status_counts'] = {st: statuses.count(st) for st in set(statuses)}

# 校验全部 36 条与汇总一致（C1-C7, E1-E11, S1-S10, U1-U8）
expected = [f'C{i}' for i in range(1, 8)] + [f'E{i}' for i in range(1, 12)] + \
           [f'S{i}' for i in range(1, 11)] + [f'U{i}' for i in range(1, 9)]
report['missing'] = [e for e in expected if e not in ids]
report['extra'] = [i for i in ids if i not in expected]

# 校验关键单元格内容完整（证据列含 file:line 格式）
bad_evidence = []
for row in ws.iter_rows(min_row=2, values_only=True):
    if row[0] and (not row[4] or '.ts' not in str(row[4])):
        bad_evidence.append(row[0])
report['bad_evidence'] = bad_evidence

# 校验路线图批次
ws3 = wb['03 重构路线图']
report['roadmap'] = [row[0] for row in ws3.iter_rows(min_row=2, values_only=True) if row[0]]
# 校验着色
fills = {}
for r in range(2, ws.max_row + 1):
    lv = ws.cell(r, 2).value
    fg = ws.cell(r, 2).fill.fgColor.rgb
    fills.setdefault(lv, set()).add(str(fg))
report['level_fills'] = {k: sorted(v) for k, v in fills.items()}

# 校验 00/01/04 非空
for name, minrows in [('00 说明', 10), ('01 架构画像', 4), ('04 与011对照', 4)]:
    w = wb[name]
    report[name] = {'rows': w.max_row, 'ok': w.max_row >= minrows}

print(json.dumps(report, ensure_ascii=False, indent=1))
