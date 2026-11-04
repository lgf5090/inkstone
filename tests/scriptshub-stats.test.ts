import { describe, expect, it } from 'vitest'
import {
  SCRIPT_STATS_DAYS,
  parseScriptStatsRange,
  publishedShare,
  scriptStatsDailyLimit,
  scriptStatsDayLabel,
  scriptStatsSince,
  scriptStatsSinceSeconds,
} from '../src/shared/scriptshub/stats'
import { searchTokens } from '../src/worker/scriptshub/store'

describe('statistics windows', () => {
  it('maps the three named ranges to their day counts and SQL cut-offs', () => {
    const now = 1_800_000_000_000
    for (const range of ['7d', '30d', '365d'] as const) {
      const days = SCRIPT_STATS_DAYS[range]
      expect(scriptStatsSince(range, now)).toBe(now - days * 24 * 60 * 60 * 1000)
      expect(scriptStatsSinceSeconds(range, now)).toBe(Math.floor((now - days * 24 * 60 * 60 * 1000) / 1000))
      expect(scriptStatsDailyLimit(range)).toBe(days)
    }
  })

  it('falls back to 30d for an unknown or missing range', () => {
    expect(parseScriptStatsRange('7d')).toBe('7d')
    expect(parseScriptStatsRange('365d')).toBe('365d')
    expect(parseScriptStatsRange('1y')).toBe('30d')
    expect(parseScriptStatsRange(undefined)).toBe('30d')
  })

  it('turns a SQL day column into a label and a zero denominator into zero percent', () => {
    expect(scriptStatsDayLabel('2026-11-04')).toBe('2026-11-04')
    expect(scriptStatsDayLabel(null)).toBe('1970-01-01')
    expect(publishedShare(0, 0)).toBe(0)
    expect(publishedShare(3, 12)).toBe(25)
  })
})

describe('search tokenization', () => {
  it('keeps the server pattern bounded when a reader pastes a long Chinese paragraph', () => {
    const long = '每天备份数据库并同步到远端存储然后再清理旧文件'.repeat(10)
    const tokens = searchTokens(long)
    expect(tokens.length).toBeLessThanOrEqual(5)
    expect(tokens.every((token) => token.length <= 28)).toBe(true)
    expect(tokens.join('').length).toBeLessThanOrEqual(140)
  })

  it('splits on whitespace and drops quotes rather than carrying a pattern', () => {
    expect(searchTokens('  backup   "nightly"  ')).toEqual(['backup', 'nightly'])
    expect(searchTokens('')).toEqual([])
  })
})
