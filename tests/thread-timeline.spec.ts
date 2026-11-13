// @vitest-environment jsdom
/** 线程时间线的客户端合并纯函数：更早分页与新页之间的间隙检测、按时间去重合并与游标推进。 */
import { describe, expect, it } from 'vitest'
import type { ThreadPageView, TriggerRow } from '../src/client/api.ts'
import { gapBetween, mergeTimeline } from '../src/client/thread.tsx'

/** 时间线行只取合并逻辑读取的字段（id 与 at）。 */
const row = (id: string, at: string): TriggerRow => ({ id, at }) as unknown as TriggerRow
const page = (timeline: TriggerRow[], earlier: string | null): ThreadPageView => ({ timeline, earlier }) as unknown as ThreadPageView
const older = (triggers: TriggerRow[], cursor: string | null) => ({ triggers, cursor })

describe('thread timeline merge', () => {
  it('detects a gap only when a loaded earlier page exists, has more pages and shares no trigger', () => {
    const newest = page([row('b', '2026-10-01T00:00:02.000Z')], 'cursor-1')
    expect(gapBetween(newest, undefined)).toBe(false)
    // 已加载到最早一页（新页仍有游标）但没有交集仍是间隙。
    expect(gapBetween(newest, older([row('a', '2026-10-01T00:00:01.000Z')], null))).toBe(true)
    // 新页已无更早分页时无所谓间隙。
    expect(gapBetween(page([row('b', '2026-10-01T00:00:02.000Z')], null), older([row('a', '2026-10-01T00:00:01.000Z')], null))).toBe(false)
    // 有交集即连续。
    expect(gapBetween(newest, older([row('b', '2026-10-01T00:00:02.000Z')], 'cursor-0'))).toBe(false)
  })
  it('returns the newest page unchanged when there is nothing to merge', () => {
    const newest = page([row('b', '2026-10-01T00:00:02.000Z')], 'cursor-1')
    expect(mergeTimeline(newest, undefined)).toBe(newest)
    // 没有更早的页可合并。
    const last = page([row('b', '2026-10-01T00:00:02.000Z')], null)
    expect(mergeTimeline(last, older([row('a', '2026-10-01T00:00:01.000Z')], null))).toBe(last)
    // 无交集即有间隙：不直接合并，等待间隙补齐把两页连起来。
    expect(mergeTimeline(newest, older([row('a', '2026-10-01T00:00:01.000Z')], 'cursor-0'))).toBe(newest)
  })
  it('merges an overlapping earlier page by time, deduplicating triggers with the newest copy winning', () => {
    const newest = page([row('c', '2026-10-01T00:00:03.000Z'), row('a', '2026-10-01T00:00:01.000Z')], 'cursor-1')
    const merged = mergeTimeline(newest, older([row('b', '2026-10-01T00:00:02.000Z'), row('a', '2026-10-01T00:00:01.000Z-stale')],
      'cursor-0'))
    // 按时间升序合并；同一时刻按更早页在前。
    expect(merged.timeline.map(item => item.id)).toEqual(['a', 'b', 'c'])
    // 重复的 id 只保留一份，值为新页中的版本（同键后写覆盖）。
    expect(merged.timeline.find(item => item.id === 'a')?.at).toBe('2026-10-01T00:00:01.000Z')
    expect(merged.earlier).toBe('cursor-0')
    expect(merged).not.toBe(newest)
  })
  it('merges an overlapping page and stops pagination when its cursor is null', () => {
    const merged = mergeTimeline(page([row('b', '2026-10-01T00:00:02.000Z')], 'cursor-1'),
      older([row('a', '2026-10-01T00:00:01.000Z'), row('b', '2026-10-01T00:00:02.000Z')], null))
    expect(merged.timeline.map(item => item.id)).toEqual(['a', 'b'])
    expect(merged.earlier).toBeNull()
  })
})
