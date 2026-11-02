// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CACHE_LIMIT, trimCache } from '../src/client/features/nav/NavChecker'

type CacheRows = Parameters<typeof trimCache>[0]

function rows(count: number, startedAt = 1_700_000_000_000, step = 1_000): CacheRows {
  const out: Record<string, { status: number; ok: boolean; level: string; durationMs: number; checkedAt: number }> = {}
  for (let index = 0; index < count; index += 1) {
    out[`link-${index}`] = { status: 200, ok: true, level: 'ok', durationMs: 5, checkedAt: startedAt + index * step }
  }
  return out as unknown as CacheRows
}

const START = 1_700_000_000_000
const STEP = 1_000
const NOW = START + (CACHE_LIMIT + 500) * STEP

describe('what the link checker keeps on this machine', () => {
  it('keeps the newest rows and cuts the collection at the bound', () => {
    const kept = trimCache(rows(CACHE_LIMIT + 500, START, STEP), NOW)
    expect(kept).toHaveLength(CACHE_LIMIT)
    // The rows that survive are the most recent ones, so a cut is not a random sample of the last scan.
    const stamps = kept.map(([, row]) => row.checkedAt)
    expect(Math.min(...stamps)).toBe(START + 500 * STEP)
    expect(Math.max(...stamps)).toBe(START + (CACHE_LIMIT + 499) * STEP)
    expect(kept.some(([id]) => id === 'link-0')).toBe(false)
    expect(kept.some(([id]) => id === `link-${CACHE_LIMIT + 499}`)).toBe(true)
  })

  it('drops what a day old already is instead of carrying it forward', () => {
    const stale = rows(3, NOW - 25 * 60 * 60 * 1000)
    expect(trimCache(stale, NOW)).toHaveLength(0)
    expect(trimCache(stale, NOW + 25 * 60 * 60 * 1000)).toHaveLength(0)
  })

  it('holds the retention bound agreed in the round-3 audit', () => {
    // The audit's complaint was that the cache held a copy of the whole bookmark list on a shared
    // machine. Raising this number past the agreed ceiling re-opens exactly that, so it is pinned.
    expect(CACHE_LIMIT).toBeLessThanOrEqual(2_000)
    expect(CACHE_LIMIT).toBeGreaterThan(0)
  })
})
