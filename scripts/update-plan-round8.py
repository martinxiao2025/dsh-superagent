# -*- coding: utf-8 -*-
"""第 8 轮：E4 完成（GC 两阶段拆除 + 复活复查），S1 无损化三分支落地（push 留待 R3 续批）。"""
from openpyxl import load_workbook
from openpyxl.styles import PatternFill, Font, Border, Side, Alignment

PATH = r'D:/dsh-superagent/docs/optimization-plan.xlsx'
THIN = Border(*[Side(style='thin', color='BFBFBF') for _ in range(4)])
WRAP = Alignment(wrap_text=True, vertical='top')
DONE_FILL = PatternFill('solid', fgColor='70AD47')

wb = load_workbook(PATH)
ws = wb['02 发现总表']
for r in range(2, ws.max_row + 1):
    if str(ws.cell(r, 1).value) == 'E4':
        ws.cell(r, 10, 'done')
        ws.cell(r, 10).fill = DONE_FILL
        ws.cell(r, 11, 8)
        old = str(ws.cell(r, 12).value or '')
        note = ('R3已修（第8轮）：①GC 删除前按 stillOpen 复查工单是否被 wake 复活，复活则跳过本轮'
                '（workspace-gc.ts:118-128、runtime.ts reclaimWorkspaces 传入）；②工单 Execution 记录镜像 repo'
                '（core/model.ts Execution.repo、executor/launch.ts ticketExecution），GC 先按镜像执行'
                ' `git worktree remove --force` 注销 gitdir 元数据再兜底 rm，拆除失败退回 rm 不阻塞'
                '（workspace-gc.ts:129-136）；③endedDirectories 复用循环外一次快照并携带 repo 归属。'
                '回归用例×2：workspace-gc.spec「删除前复查复活…」与「先按镜像注销 worktree 再删目录，拆除失败退回 rm…」')
        ws.cell(r, 12, (old + '；' if old else '') + note)
        ws.cell(r, 12).alignment = WRAP
    if str(ws.cell(r, 1).value) == 'S1':
        old = str(ws.cell(r, 12).value or '')
        note = ('R3 无损化先行落地（第8轮，保持 planned）：syncCode 分叉语义三分支——'
                '①本地不领先：ff-only 快进；②本地领先且远端未动：保留本地回写提交，ff-only 为空操作'
                '（sync.ts:154-168）；③真分叉（双方都前进）：显式失败并给出处置指引，绝不 reset 丢写。'
                '同时修正第7轮遗留 WIP 的「ahead≠0 即 reset」缺陷——该方案在远端未动时也会立即抹掉回写提交，'
                '清单行回到待处理可触发重复执行。回归用例×2（code-repos.spec「keeps local writeback commits…」'
                '「fails loudly on divergence…」）。push 与「重建镜像+重放 writeback」仍未做，随 R3 续批落地后转 done')
        ws.cell(r, 12, (old + '；' if old else '') + note)
        ws.cell(r, 12).alignment = WRAP

ws3 = wb['03 重构路线图']
for r in range(2, ws3.max_row + 1):
    if str(ws3.cell(r, 1).value or '').startswith('R3'):
        old = str(ws3.cell(r, 5).value or '')
        ws3.cell(r, 5, old + '』进度（第8轮）：E4 完成（GC 两阶段拆除+复活复查，回归×2）；S1 无损三分支语义落地（回归×2），push/重放待续批。')
        ws3.cell(r, 5).alignment = WRAP

ws0 = wb['00 说明']
ws0.append(['第 8 轮（2026-11-15）',
  '收口与继续：第5-7轮实现此前未入库（工作树堆积），本轮修复遗留 4 个类型错误（runtime.ts removeWorktree 返回值、'
  'workspace-gc.ts ended 判空与变量遮蔽、sync.ts 多余实参）后连同 R3 先行项一并提交（commit 66e6bae，1376 例全绿）。'
  'E4 记 done；S1 修正为无损三分支语义——第7轮记录的「reset 自愈」方案实际会在远端未动时立即抹掉回写提交（已完成的回写副作用不会重放），'
  '改为保留+显式失败，push 留待 R3 续批（S1 保持 planned）。下一批：R3 续批（S1 push/E6/E11/C6/S6）。'])
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
