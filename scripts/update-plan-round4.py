# -*- coding: utf-8 -*-
"""第 4 轮：完成全部 36 条发现的证据复核（全覆盖），更新 optimization-plan.xlsx。"""
from openpyxl import load_workbook
from openpyxl.styles import PatternFill, Border, Side, Alignment, Font

PATH = r'D:\dsh-superagent\docs\optimization-plan.xlsx'
THIN = Border(*[Side(style='thin', color='BFBFBF') for _ in range(4)])
WRAP = Alignment(wrap_text=True, vertical='top')
CHECKED_FILL = PatternFill('solid', fgColor='C6EFCE')

round4 = {
 'E5':  ('主代理 grep worker-sources.ts:109-110', '属实。declared 从 env 直取且 pinned 命中即用，无 cwd 登记目录校验'),
 'E6':  ('主代理 grep worker-sources.ts', '属实。recordTicketSource 只写不删（L68 起无删除 API），writeWorkerRecords 无目录存在性过滤'),
 'E7':  ('主代理 grep launch.ts:32 + execution-paths.ts:13-23', '属实。projectFolderName 无 WINDOWS_RESERVED 与首尾点空格处理，projectDirectoryName 完整处理——双口径确认'),
 'E8':  ('主代理复读 setup.ts:395-420', '属实。来源与项目仓库两段 for-await 逐条 await'),
 'E9':  ('主代理 grep launch.ts:171-172', '属实。accepted 回调内调用后又显式调用，必然双次'),
 'E10': ('主代理 grep idle.ts:23', '属实。\\b(?:408|429|50[0-4])\\b 加入 PASSING 文本兜底，无 HTTP 上下文锚点'),
 'E11': ('主代理复读 workspace.ts:44-61 + grep sync.ts:133-138', '属实。L47-53 残破目录 rev-parse 失败→非空即拒绝覆盖；L57-58 ref=HEAD 回退确认'),
 'S5':  ('主代理 grep runtime.ts:239/244', '属实。每次 feishuWikiReader/feishuImReader 调用都新建 httpWikiApi/httpImApi（TokenManager 随实例新建），无按凭据 ID 缓存'),
 'S6':  ('主代理 grep writeback.ts:56-60', '属实。表头 trim 但单元格比较不 trim（L60），find 取首个命中无唯一性断言'),
 'S7':  ('主代理 grep credential-service.ts:85-107', '属实。update（L94-95）与 rotate（L106-107）vault.save 后直接 records.save，无 create（L77-78）式回滚'),
 'S8':  ('主代理 grep vault.ts:42-46', '属实。主密钥 base64 明文落盘（L46）与密文同树'),
 'S10': ('主代理 grep feishu-im.ts:23/79', '属实。taskStatus 默认「待处理」，verify L79 恒 checkPassed，无 pendingStatuses 交叉校验'),
 'U3':  ('主代理 grep settings.ts:269-274 + 325', '属实。recordId 无 id 时按 `${base}-${suffix}` 递增（来源域）；项目域 L325 走同一路径，向导不传 id → project-2/3'),
 'U4':  ('主代理 grep projects.tsx:360-395', '属实。PROJECT_DEFAULTS 硬编码且预填值随创建显式提交'),
 'U5':  ('主代理 grep schemas.ts:8-15', '属实。state/filter/window 均 .catch() 静默兜底；search 无 schema'),
 'U7':  ('主代理 grep locales.ts:38-46', '属实。编译期穷举守卫仅 Reason/Setup/UserError/HealthCode 四组，无 queueState'),
 'U8':  ('主代理 grep thread.tsx:92-97', '属实。补洞 while 循环无迭代上限'),
}

wb = load_workbook(PATH)
ws = wb['02 发现总表']
for r in range(2, ws.max_row + 1):
    fid = str(ws.cell(r, 1).value or '')
    if fid in round4:
        how, verdict = round4[fid]
        ws.cell(r, 13, f'已复核（{how}）：{verdict}')
        ws.cell(r, 13).fill = CHECKED_FILL
        ws.cell(r, 13).alignment = WRAP
        ws.cell(r, 13).border = THIN

ws0 = wb['00 说明']
ws0.append(['第 4 轮（2026-11-15）',
  '证据复核全覆盖：36/36 条全部由主代理定点核验源码确认，零误报。其中 S5 复核时补充确认：CLI 身份路径（larkWikiApi/larkImApi）不受影响，仅 HTTP 身份路径每次新建 TokenManager——修复范围据此收窄。E11 复核确认 workspace.ts:47-53 的「残破目录拒绝覆盖」路径与镜像重建（sync.ts:133-138）构成 E11 完整证据链。评审阶段完成，后续轮次转入实施与状态跟踪。'])
ws0.cell(ws0.max_row, 1).font = Font(bold=True)
for c in (ws0.cell(ws0.max_row, 1), ws0.cell(ws0.max_row, 2)):
    c.fill = PatternFill('solid', fgColor='DDEBF7')
    c.border = THIN
    c.alignment = WRAP
ws0.cell(ws0.max_row, 1).font = Font(bold=True)

wb.save(PATH)

wb2 = load_workbook(PATH)
w2 = wb2['02 发现总表']
green = [str(w2.cell(r, 1).value) for r in range(2, w2.max_row + 1)
         if str(w2.cell(r, 13).fill.fgColor.rgb).endswith('C6EFCE')]
print('total_green:', len(green), '(expect 36)')
print('all rows green:', len(green) == 36)
