import { describe, expect, it } from 'vitest'
import { parseNavBackupState } from '../src/shared/nav/validation'
import { DEFAULT_NAV_BACKUP_STATE } from '../src/shared/nav/model'
import { isNavBackupDue } from '../src/worker/nav/backup-scheduler'

const NOW = 1_800_000_000_000

describe('navigation backup schedule', () => {
  it('runs an unstarted schedule and then waits out its interval', () => {
    expect(isNavBackupDue({ schedule: 'hourly', lastRunAt: null }, NOW)).toBe(true)
    expect(isNavBackupDue({ schedule: 'hourly', lastRunAt: NOW - 30 * 60_000 }, NOW)).toBe(false)
    expect(isNavBackupDue({ schedule: 'hourly', lastRunAt: NOW - 56 * 60_000 }, NOW)).toBe(true)
    expect(isNavBackupDue({ schedule: 'sixHourly', lastRunAt: NOW - 3 * 60 * 60_000 }, NOW)).toBe(false)
    expect(isNavBackupDue({ schedule: 'daily', lastRunAt: NOW - 25 * 60 * 60_000 }, NOW)).toBe(true)
    expect(isNavBackupDue({ schedule: 'weekly', lastRunAt: NOW - 2 * 24 * 60 * 60_000 }, NOW)).toBe(false)
    expect(isNavBackupDue({ schedule: 'off', lastRunAt: null }, NOW)).toBe(false)
  })

  it('parses stored state and falls back safely on invalid values', () => {
    expect(parseNavBackupState({
      schedule: 'daily',
      retention: 14,
      lastRunAt: NOW,
      lastStatus: 'success',
      lastError: null,
      lastFilename: 'inkstone-nav-backup_2026-01-01_00-00-00.json',
      history: ['inkstone-nav-backup_2026-01-01_00-00-00.json'],
    })).toMatchObject({
      schedule: 'daily',
      retention: 14,
      lastStatus: 'success',
      history: ['inkstone-nav-backup_2026-01-01_00-00-00.json'],
    })
    expect(parseNavBackupState({ schedule: 'sometimes', retention: -1 })).toEqual(DEFAULT_NAV_BACKUP_STATE)
    expect(parseNavBackupState(null)).toEqual(DEFAULT_NAV_BACKUP_STATE)
  })
})
