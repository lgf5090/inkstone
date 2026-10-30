// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEVELOPMENT_XGET_SCHEMA_STATEMENTS } from '../src/worker/development/xget/schema'
import {
  readXgetOverrides,
  readXgetSettingsRow,
  readXgetTokenHash,
  writeXgetOverrides,
  writeXgetTokenHash,
} from '../src/worker/development/xget/settings'
import { readStatsSummary, recordProxyStat } from '../src/worker/development/xget/stats'
import { makeD1 } from './doubles/d1-sqlite'

const DAY_MS = 86_400_000

function makeStore(): D1Database {
  const sqlite = new DatabaseSync(':memory:')
  for (const statement of DEVELOPMENT_XGET_SCHEMA_STATEMENTS) sqlite.exec(statement)
  return makeD1(sqlite)
}

function utcDay(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function freezeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'))
}

async function insertStat(
  db: D1Database,
  day: string,
  platform: string,
  ok: number,
  count: number,
): Promise<void> {
  await db
    .prepare('INSERT INTO development_xget_stats (day, platform, ok, count) VALUES (?1, ?2, ?3, ?4)')
    .bind(day, platform, ok, count)
    .run()
}

async function seedStats(db: D1Database): Promise<{ twoDaysAgo: string; tenDaysAgo: string }> {
  await recordProxyStat(db, 'gh', 200)
  await recordProxyStat(db, 'gh', 302)
  await recordProxyStat(db, 'npm', 404)
  await recordProxyStat(db, null, 500)
  const twoDaysAgo = utcDay(Date.now() - 2 * DAY_MS)
  const tenDaysAgo = utcDay(Date.now() - 10 * DAY_MS)
  await insertStat(db, twoDaysAgo, 'gh', 1, 1)
  await insertStat(db, twoDaysAgo, 'cr-docker', 1, 4)
  await insertStat(db, twoDaysAgo, 'mystery', 1, 5)
  await insertStat(db, twoDaysAgo, 'npm', 0, 2)
  await insertStat(db, tenDaysAgo, 'gh', 1, 4)
  return { twoDaysAgo, tenDaysAgo }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the xget settings store', () => {
  it('reads empty defaults when no row exists', async () => {
    const db = makeStore()
    expect(await readXgetSettingsRow(db)).toEqual({ overrides: {}, tokenHash: '' })
    expect(await readXgetOverrides(db)).toEqual({})
    expect(await readXgetTokenHash(db)).toBe('')
  })

  it('round-trips overrides in a single row and records the write time', async () => {
    const db = makeStore()
    const overrides = {
      TIMEOUT_SECONDS: 45,
      RETRY_DELAY_MS: 0,
      SECURITY: {
        ALLOWED_METHODS: ['GET', 'POST'],
        ALLOWED_ORIGINS: ["https://example.com/'; DROP TABLE development_xget_settings; --"],
      },
    }
    await writeXgetOverrides(db, overrides, 111)
    expect(await readXgetOverrides(db)).toEqual(overrides)
    const row = await db
      .prepare('SELECT updated_at FROM development_xget_settings WHERE id = 1')
      .first<{ updated_at: number }>()
    expect(row?.updated_at).toBe(111)
    const count = await db
      .prepare('SELECT COUNT(*) AS count FROM development_xget_settings')
      .first<{ count: number }>()
    expect(count?.count).toBe(1)
  })

  it('preserves the untouched column and the single row on upserts', async () => {
    const db = makeStore()
    const hash = 'a'.repeat(64)
    await writeXgetTokenHash(db, hash, 100)
    await writeXgetOverrides(db, { TIMEOUT_SECONDS: 5 }, 200)
    expect(await readXgetSettingsRow(db)).toEqual({
      overrides: { TIMEOUT_SECONDS: 5 },
      tokenHash: hash,
    })
    await writeXgetTokenHash(db, '', 300)
    expect(await readXgetSettingsRow(db)).toEqual({
      overrides: { TIMEOUT_SECONDS: 5 },
      tokenHash: '',
    })
    const row = await db
      .prepare('SELECT updated_at FROM development_xget_settings WHERE id = 1')
      .first<{ updated_at: number }>()
    expect(row?.updated_at).toBe(300)
    const count = await db
      .prepare('SELECT COUNT(*) AS count FROM development_xget_settings')
      .first<{ count: number }>()
    expect(count?.count).toBe(1)
  })

  it('falls back to empty overrides when config_json is not a JSON object', async () => {
    const db = makeStore()
    const hash = 'b'.repeat(64)
    await db
      .prepare(
        `INSERT INTO development_xget_settings (id, config_json, proxy_token_hash, updated_at)
         VALUES (1, ?1, ?2, ?3)`,
      )
      .bind('{not json', hash, 7)
      .run()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await readXgetSettingsRow(db)).toEqual({ overrides: {}, tokenHash: hash })
    expect(warn).toHaveBeenCalledTimes(1)
    await db
      .prepare('UPDATE development_xget_settings SET config_json = ?1 WHERE id = 1')
      .bind('"text"')
      .run()
    expect(await readXgetSettingsRow(db)).toEqual({ overrides: {}, tokenHash: hash })
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('rejects token hashes that are not empty or 64 lowercase hex characters', async () => {
    const db = makeStore()
    const invalid = ['abc', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `${'a'.repeat(63)} `]
    for (const tokenHash of invalid) {
      await expect(writeXgetTokenHash(db, tokenHash, 1)).rejects.toThrow(Error)
    }
    expect(await readXgetSettingsRow(db)).toEqual({ overrides: {}, tokenHash: '' })
    const valid = '0123456789abcdef'.repeat(4)
    await writeXgetTokenHash(db, valid, 2)
    expect(await readXgetTokenHash(db)).toBe(valid)
    await writeXgetTokenHash(db, '', 3)
    expect(await readXgetTokenHash(db)).toBe('')
  })
})

describe('the xget stats store', () => {
  it('returns an empty summary when nothing has been recorded', async () => {
    const db = makeStore()
    expect(await readStatsSummary(db, null)).toEqual({
      total: 0,
      ok: 0,
      okRate: 0,
      today: 0,
      platformCount: 0,
      platforms: [],
      trend: [],
      trendByCategory: [],
    })
    const week = await readStatsSummary(db, 7)
    expect(week.trend).toEqual([])
    expect(week.trendByCategory).toEqual([])
  })

  it('aggregates totals, platform shares, the daily trend and categories', async () => {
    freezeClock()
    const db = makeStore()
    const { twoDaysAgo, tenDaysAgo } = await seedStats(db)
    const today = utcDay()
    const summary = await readStatsSummary(db, null)
    const allDays = Array.from({ length: 11 }, (_, index) =>
      utcDay(Date.now() - (10 - index) * DAY_MS),
    )

    expect(summary.total).toBe(20)
    expect(summary.ok).toBe(16)
    expect(summary.okRate).toBe(80)
    expect(summary.today).toBe(4)
    expect(summary.platformCount).toBe(5)
    expect(summary.platforms).toEqual([
      { platform: 'gh', count: 7, ok: 7, pct: 35 },
      { platform: 'mystery', count: 5, ok: 5, pct: 25 },
      { platform: 'cr-docker', count: 4, ok: 4, pct: 20 },
      { platform: 'npm', count: 3, ok: 0, pct: 15 },
      { platform: 'unknown', count: 1, ok: 0, pct: 5 },
    ])
    expect(summary.trend.map((point) => point.day)).toEqual(allDays)
    expect(summary.trend.find((point) => point.day === tenDaysAgo)).toEqual({
      day: tenDaysAgo,
      count: 4,
      ok: 4,
    })
    expect(summary.trend.find((point) => point.day === twoDaysAgo)).toEqual({
      day: twoDaysAgo,
      count: 12,
      ok: 10,
    })
    expect(summary.trend.find((point) => point.day === today)).toEqual({
      day: today,
      count: 4,
      ok: 2,
    })
    expect(summary.trendByCategory.map((point) => point.day)).toEqual(allDays)
    expect(summary.trendByCategory.find((point) => point.day === twoDaysAgo)).toEqual({
      day: twoDaysAgo,
      code: 1,
      package: 2,
      linux: 0,
      misc: 0,
      ai: 0,
      registry: 4,
    })
    expect(summary.trendByCategory.find((point) => point.day === today)).toEqual({
      day: today,
      code: 2,
      package: 1,
      linux: 0,
      misc: 0,
      ai: 0,
      registry: 0,
    })
  })

  it('limits the summary to the requested number of days', async () => {
    freezeClock()
    const db = makeStore()
    const { twoDaysAgo, tenDaysAgo } = await seedStats(db)
    const today = utcDay()
    const week = await readStatsSummary(db, 7)
    const weekDays = Array.from({ length: 7 }, (_, index) =>
      utcDay(Date.now() - (6 - index) * DAY_MS),
    )

    expect(week.total).toBe(16)
    expect(week.ok).toBe(12)
    expect(week.okRate).toBe(75)
    expect(week.today).toBe(4)
    expect(week.platformCount).toBe(5)
    expect(week.platforms.find((row) => row.platform === 'gh')).toEqual({
      platform: 'gh',
      count: 3,
      ok: 3,
      pct: 18.8,
    })
    expect(week.platforms.find((row) => row.platform === 'npm')).toEqual({
      platform: 'npm',
      count: 3,
      ok: 0,
      pct: 18.8,
    })
    expect(week.trend.map((point) => point.day)).toEqual(weekDays)
    expect(week.trend.find((point) => point.day === twoDaysAgo)).toEqual({
      day: twoDaysAgo,
      count: 12,
      ok: 10,
    })
    expect(week.trend.find((point) => point.day === today)).toEqual({
      day: today,
      count: 4,
      ok: 2,
    })
    expect(week.trend.some((point) => point.day === tenDaysAgo)).toBe(false)
    expect(week.trendByCategory.map((point) => point.day)).toEqual(weekDays)
    expect(week.trendByCategory.find((point) => point.day === twoDaysAgo)).toEqual({
      day: twoDaysAgo,
      code: 1,
      package: 2,
      linux: 0,
      misc: 0,
      ai: 0,
      registry: 4,
    })

    const month = await readStatsSummary(db, 30)
    expect(month.total).toBe(20)
    expect(month.trend).toHaveLength(30)
    expect(month.trend[0]?.day).toBe(utcDay(Date.now() - 29 * DAY_MS))
    expect(month.trendByCategory[0]?.day).toBe(utcDay(Date.now() - 29 * DAY_MS))
  })

  it('binds platform names instead of interpolating SQL', async () => {
    const db = makeStore()
    const platform = "gh'); DROP TABLE development_xget_stats; --"
    await recordProxyStat(db, platform, 200)
    const summary = await readStatsSummary(db, null)
    expect(summary.total).toBe(1)
    expect(summary.platforms).toEqual([{ platform, count: 1, ok: 1, pct: 100 }])
  })

  it('never throws when the statistics write fails', async () => {
    const db = {
      prepare() {
        throw new Error('d1 down')
      },
    } as unknown as D1Database
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(recordProxyStat(db, 'gh', 200)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
