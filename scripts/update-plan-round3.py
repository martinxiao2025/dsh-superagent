# -*- coding: utf-8 -*-
"""第 3 轮：扩大证据复核覆盖（16/36），更新 optimization-plan.xlsx 的「证据复核」列。"""
from openpyxl import load_workbook
from openpyxl.styles import PatternFill, Border, Side, Alignment

PATH = r'D:\dsh-superagent\docs\optimization-plan.xlsx'
THIN = Border(*[Side(style='thin', color='BFBFBF')] * 4)
WRAP = Alignment(wrap_text=True, vertical='top')
CHECKED_FILL = PatternFill('solid', fgColor='C6EFCE')

# 第 3 轮新增复核：编号 -> (方式, 结论)
round3 = {
 'C4': ('主代理全文复读 scheduler.ts（pollNow L194-199 不经 runExclusive；scan 自持 POLL_CONCURRENCY 池）+ sync.ts（无互斥原语）', '属实。两条通路各自持池，同项目不互斥；011 §9.2-1 的关闭论证只对齐了数值'),
 'C5': ('主代理全文复读 scheduler.ts L328（reportHealth 每 tick store.queue.list() 全表解析）、L85（errors/nextPoll/deferred 内存 Map）', '属实'),
 'C6': ('主代理全文复读 effects.ts L163-164', '属实。退避上限 60s（writeback retry=[?]）仅是延迟上限，attempts 无终态'),
 'C7': ('主代理全文复读 store.ts L381-384（queueValues 每行 parse 抛错即整查询失败）', '属实。对比 L386-403 entityValues 已有单行跳过模式'),
 'S9': ('主代理全文复读 scheduler.ts busy() L430-434 与 writeback Later 推迟', '属实。writeback 忙时推迟但 poll 不感知 writeback 在跑'),
 'S1': ('主代理复读 excel.ts L65/L133（commitWorkCopy 本地提交）+ sync.ts 全文（L154-156 merge --ff-only；L131-141 仅远端 URL 变化时重建）', '属实。回写提交使镜像脱离 origin/<branch>，远端前进后 ff-only 永久失败；push 无实现'),
 'S4': ('主代理 grep feishu-im.ts', '属实。L107 flatMap 直接映射，全文件无 senderType 过滤'),
 'U2': ('主代理 grep src/client 全目录 ErrorBoundary|componentDidCatch|getDerivedStateFromError', '属实。零匹配'),
 'U6': ('主代理复读 http/server.ts L82-107', '属实。L84 sameOrigin 在路由匹配前对全部路径生效；health 200 豁免仅存在于 runtime 未就绪分支（L92），正常运行时标准探针拿 403'),
 'E4': ('主代理 grep workspace-gc.ts', '属实。L92 默认删除为 rm recursive force，全文件无 worktree 操作'),
}

wb = load_workbook(PATH)
ws = wb['02 发现总表']
updated = 0
for r in range(2, ws.max_row + 1):
    fid = str(ws.cell(r, 1).value or '')
    if fid in round3:
        how, verdict = round3[fid]
        ws.cell(r, 13, f'已复核（{how}）：{verdict}')
        ws.cell(r, 13).fill = CHECKED_FILL
        ws.cell(r, 13).alignment = WRAP
        ws.cell(r, 13).border = THIN
        updated += 1

ws0 = wb['00 说明']
ws0.append(['第 3 轮（2026-11-15）', f'证据复核扩面：新增 10 条复核（C4/C5/C6/C7/S9 来自会话内全文复读 scheduler.ts/effects.ts/store.ts/sync.ts；S1/S4/U2/U6/E4 来自定点 grep 与复读），复核覆盖达 16/36（P1 级 13 条中已复核 12 条）。全部属实，未发现误报。'])
ws0.cell(ws0.max_row, 1).font = Font(bold=True) if (Font := __import__('openpyxl').styles.Font) else None
for c in (ws0.cell(ws0.max_row, 1), ws0.cell(ws0.max_row, 2)):
    c.fill = PatternFill('solid', fgColor='DDEBF7')
    c.border = THIN
    c.alignment = WRAP
from openpyxl.styles import Font
ws0.cell(ws0.max_row, 1).font = Font(bold=True)

wb.save(PATH)

# 自验
wb2 = load_workbook(PATH)
w2 = wb2['02 发现总表']
green = [str(w2.cell(r, 1).value) for r in range(2, w2.max_row + 1)
         if str(w2.cell(r, 13).fill.fgColor.rgb).endswith('C6EFCE')]
print('updated_this_round:', updated)
print('total_green:', len(green), green)
