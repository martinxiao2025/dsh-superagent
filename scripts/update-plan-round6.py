# -*- coding: utf-8 -*-
"""第 6 轮：R2 批次部分完成（S3/S4/C4/S9/C2 五项修复 + 4 条回归用例），更新 optimization-plan.xlsx。"""
from openpyxl import load_workbook
from openpyxl.styles import PatternFill, Font, Border, Side, Alignment

PATH = r'D:/dsh-superagent/docs/optimization-plan.xlsx'
THIN = Border(*[Side(style='thin', color='BFBFBF') for _ in range(4)])
WRAP = Alignment(wrap_text=True, vertical='top')
DONE_FILL = PatternFill('solid', fgColor='70AD47')

fixes = {
 'S3': ('done', 'splitTask 的 item 路径 contentHash 改为「标题+描述非列表行(正文)+本项文本」作用域（tasks.ts:120-128）：标题/验收标准变化→所有项换代执行新内容；兄弟列表行增删不取消无关项。比原建议的「完整 compose 文本」更精确——实施中经 queue.spec 既有用例纠正了作用域（完整文本会因兄弟行删除而误换代）。回归用例：task-sources.spec「changes the content hash when the task title or prose changes...」'),
 'S4': ('done', 'feishu-im 驱动新增 includeBotMessages 配置（默认 false）：senderType !== user 的消息默认跳过（feishu-im.ts:107-117），阻断「消息→任务→执行→新消息」自我放大循环。回归用例：task-sources.spec「skips bot messages by default and includes them only when asked」'),
 'C4': ('done', 'SchedulerReconcile 增加 per-project inFlight 集合（scheduler-reconcile.ts:44-62）：手动 scan、tick 投递的 poll 副作用与 pollNow 三条通路共用同一资源级互斥，重复调用直接落空。回归用例：queue.spec「轮询进行中时另一条通路的轮询落空，互斥落在项目上」'),
 'S9': ('done', 'WritebackContext 新增 polling() 查询，writeBackNow 在项目被轮询时抛 Later 推迟（scheduler-writeback.ts:45-55）——回写与轮询共享同一把互斥，写回提交不再落在 checkout 覆盖后的内容上'),
 'C2': ('done', 'settleOutcome 的 person 接管改为动作白名单（scheduler-dispatch.ts:207-214）：只有 blocked/failed 才 stop-then-retry；answer（提问）、review（待审阅）、delivery（投递失败）不再被 15 秒强停。回归用例×2：scheduler-runtime.spec「worker 向人提问时队列不接管工单」（progress+human_action 后工单存活、attention 保留）与「worker 报告 blocked 时项目按既有语义接管」（反向验证白名单不扩大）'),
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
        ws.cell(r, 11, 6)
        old_note = str(ws.cell(r, 12).value or '')
        ws.cell(r, 12, (old_note + '；' if old_note else '') + f'R2已修（第6轮）：{note}')
        ws.cell(r, 12).alignment = WRAP
        changed.append(fid)

ws3 = wb['03 重构路线图']
for r in range(2, ws3.max_row + 1):
    if str(ws3.cell(r, 1).value or '').startswith('R2'):
        ws3.cell(r, 7, 'partial')
        ws3.cell(r, 7).fill = PatternFill('solid', fgColor='FFC000')
        old = str(ws3.cell(r, 5).value or '')
        ws3.cell(r, 5, old + '』进度记录（第6轮）：S3/S4/C4/S9/C2 已修并验收（1370 例全绿，4 条新回归用例）；C3（回写聚合+CAS）待下一轮专项实施。')

ws0 = wb['00 说明']
ws0.append(['第 6 轮（2026-11-15）',
  'R2 批次主体完成：S3（内容哈希作用域精确化——实施中依既有测试纠正为「标题+正文+本项」，兄弟行增删不误换代）、S4（机器人消息默认过滤）、C4+S9（poll/writeback 共享 per-project 资源互斥）、C2（person 接管白名单：只接管 blocked/failed）。pnpm check 全绿（86 文件 1370 例，新增 4 条回归）。剩余：C3（回写按任务聚合+expectedStatus CAS）→ 第 7 轮专项。'])
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
print('done total:', done)
