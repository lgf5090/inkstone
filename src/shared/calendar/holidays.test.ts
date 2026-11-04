import { describe, expect, it } from 'vitest'
import { holidayDay, holidayNoticeOf, holidayYearsListed } from './holidays'

describe('statutory holidays', () => {
  it('marks the 2026 Spring Festival range from the published notice', () => {
    expect(holidayDay('2026-02-15')).toMatchObject({ off: true, makeup: false, source: 'calendar.holidays.notice_2026' })
    expect(holidayDay('2026-02-23').off).toBe(true)
    expect(holidayDay('2026-02-24').off).toBe(false)
  })

  it('marks the makeup workdays the notice adds', () => {
    expect(holidayDay('2026-02-14')).toMatchObject({ off: false, makeup: true })
    expect(holidayDay('2026-02-28')).toMatchObject({ makeup: true })
    expect(holidayDay('2026-01-04')).toMatchObject({ makeup: true })
  })

  it('merges National Day and Mid-Autumn in 2025, where the notice says so', () => {
    expect(holidayDay('2025-10-08')).toMatchObject({ off: true, name: 'calendar.holidays.national_day_mid_autumn' })
    expect(holidayDay('2025-10-09').off).toBe(false)
  })

  it('leaves an ordinary day alone', () => {
    expect(holidayDay('2026-11-04')).toEqual({ off: false, makeup: false, name: null, source: null })
  })

  it('answers nothing for a year with no published notice', () => {
    expect(holidayNoticeOf(2027)).toBeNull()
    expect(holidayDay('2027-10-01').off).toBe(false)
    expect(holidayYearsListed()).toEqual([2025, 2026])
  })
})
