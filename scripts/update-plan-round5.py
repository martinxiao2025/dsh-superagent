# -*- coding: utf-8 -*-
"""第 5 轮：R1 批次实施完成（E1/C1/S2/E2/E3 五项修复 + 2 条回归用例），更新 optimization-plan.xlsx。"""
from openpyxl import load_workbook
from openpyxl.styles import PatternFill, Font, Border, Side, Alignment

PATH = r'D:/dsh-superagent/docs/optimization-plan.xlsx'
THIN = Border(*[Side(style='thin', color='BFBFBF') for _ in range(4)])
WRAP = Alignment(wrap_text=True, vertical='top')
DONE_FILL = PatternFill('solid', fgColor='70AD47')
PLANNED_FILL = PatternFill('solid', fgColor='FFC000')

# R1 修复明细：编号 -> (状态, 修复说明)
fixes = {
 'E1': ('done', 'WorkerState 新增单调 retrySeq（dsh.ts:120-133），requestId 改为 retry:<assignmentId>:<retrySeq++>（idle.ts:58）。回归用例：runtime-concurrency.spec「delivers a fresh resume message for each transient failure...」（fake timers 推进 15s 退避，断言两次恢复消息 ID 不同且均真实投递）'),
 'C1': ('done', 'triggerIdOf() 纳入 tickets.length 代次（scheduler-dispatch.ts:54-62），手动重试 attempt 归零也生成全新触发器；dispatch 与 recover 的 scheduledTrigger 同步改用同一函数。回归用例：scheduler-runtime.spec「手动重试耗尽重试的条目会生成新触发器并真正重新执行」（耗尽 3 次 dropped → 手动重试 → 新工单 running）'),
 'S2': ('done', 'icacls 调用去掉 windowsVerbatimArguments（vault.ts:62-69），Node 默认参数模式为含空格路径/用户名自动加引号'),
 'E2': ('done', 'materializeWorkspace 对请求分支缺失改为显式抛错（workspace.ts:56-62），提示等待下次轮询；不再静默回退 HEAD'),
 'E3': ('done', 'Commands.lark 输出解析改逐行找 JSON（commands.ts:204-224），横幅/警告行不再致 SyntaxError；解析失败抛带输出的 CliError，保留错误码分类链路'),
}

wb = load_workbook(PATH)
ws = wb['02 发现总表']
changed = []
for r in range(2, ws.max_row + 1):
    fid = str(ws.cell(r, 1).value or '')
    if fid in fixes:
        state, note = fixes[fid]
        ws.cell(r, 10, state)
        ws.cell(r, 10).fill = DONE_FILL
        ws.cell(r, 11, 5)
        # 追加修复记录到备注列（L）
        old_note = str(ws.cell(r, 12).value or '')
        ws.cell(r, 12, (old_note + '；' if old_note else '') + f'R1已修（第5轮）：{note}')
        ws.cell(r, 12).alignment = WRAP
        changed.append(fid)

# 03 路线图：R1 批次标记 done
ws3 = wb['03 重构路线图']
for r in range(2, ws3.max_row + 1):
    if str(ws3.cell(r, 1).value or '').startswith('R1'):
        ws3.cell(r, 7, 'done')
        ws3.cell(r, 7).fill = DONE_FILL
        old = str(ws3.cell(r, 5).value or '')
        ws3.cell(r, 5, old + '』验收记录（第5轮）：pnpm check 全绿（typecheck + 86 文件 1365 例 + build）；新增 2 条回归用例通过；E1/C1 用例钉住幂等键契约，S2/E2/E3 行为变更由既有测试矩阵覆盖。')

# 00 说明追加第 5 轮
ws0 = wb['00 说明']
ws0.append(['第 5 轮（2026-11-15）',
  '实施阶段启动：R1 正确性速修批次完成——E1（retrySeq 单调幂等键，防恢复消息被去重致流水线卡死）、C1（triggerId 纳入工单历史代次，手动重试真正重跑）、S2（icacls 参数引号）、E2（分支缺失显式报错）、E3（lark 输出容错解析）。验证：pnpm check 全绿（1365 例），新增 2 条回归用例。02 表状态：E1/C1/S2/E2/E3 → done；03 表 R1 → done。剩余：R2-R6 待实施。'])
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
print('done findings:', done)
w3 = wb2['03 重构路线图']
print('R1 status:', w3.cell(2, 7).value)
