/** 字段级预检基座：单一 VerifyRow 展示与 useFieldChecks 状态管理，供来源、项目表单与新建向导共用。 */
import { useState, type ReactElement } from 'react'
import type { Api, ApiRequest } from '../app/api.ts'
import type { SourceCheck } from '../setup.ts'
import { Button } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { errorText, sourceCheckText } from './text.ts'

/** 支持字段级预检的端点：三个预检路由的响应同构（`checks` 清单）。 */
export type VerifyEndpoint = 'POST code-repos/verify' | 'POST task-sources/verify' | 'POST sources/verify'

/** 收集预检结果：同一字段的旧结果被新结果覆盖。 */
export function mergeChecks(current: Record<string, SourceCheck>, checks: readonly SourceCheck[]): Record<string, SourceCheck> {
  const next = { ...current }
  for (const check of checks) next[check.field] = check
  return next
}

/** 一行字段加一个独立的验证按钮，结果就地显示在字段下方。 */
export function VerifyRow({ label, busy, check, onVerify, children }: { label: string; busy: boolean; check?: SourceCheck
  onVerify: () => void; children: ReactElement<{ id?: string }> }) {
  const { t } = usePanel()
  return <div className="dt-verify-item">
    <div className="dt-verify-row">{children}
      <Button variant="outline" size="sm" disabled={busy} aria-busy={busy} aria-label={`${t('verify')} · ${label}`}
        onClick={onVerify}>{busy ? t('verifyBusy') : t('verify')}</Button>
    </div>
    {check && <p className={check.ok ? 'dt-hint dt-check' : 'dt-error dt-check'} role={check.ok ? 'status' : 'alert'}>
      {sourceCheckText(t, check)}
    </p>}
  </div>
}

/**
 * 字段级预检 Hook：管理 `checks` 与 `checking` 两组状态。
 * `verify(field)` 提交 `buildBody()` 与字段名，结果按字段合并，失败经面板提示；`reset` 清空结论，
 * 供草稿变更后逼着用户对新配置重新验证。
 */
export function useFieldChecks<K extends VerifyEndpoint>(endpoint: K, buildBody: (field: string) => Omit<NonNullable<Api[K]['body']>, 'field'>) {
  const { call, notify } = usePanel()
  const [checks, setChecks] = useState<Record<string, SourceCheck>>({})
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  /** 验证一个字段；`onChecks` 在结论写入后回调（例如仓库地址通过后自动拉取分支）。 */
  const verify = async (field: string, onChecks?: (checks: readonly SourceCheck[]) => void) => {
    setChecking(current => ({ ...current, [field]: true }))
    try {
      const result = await call(endpoint, { body: { ...buildBody(field), field } } as ApiRequest<K>)
      setChecks(current => mergeChecks(current, result.checks))
      onChecks?.(result.checks)
    } catch (failure) { notify(errorText(failure)) } finally { setChecking(current => ({ ...current, [field]: false })) }
  }
  return { checks, checking, verify, reset: () => setChecks({}) }
}
