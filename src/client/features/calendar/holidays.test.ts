import { Temporal } from 'temporal-polyfill'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { holidayDay, holidayNoticeOf } from '@shared/calendar/holidays'
import { initI18n, setLocale, t } from '../../lib/i18n'
import { holidayPresets } from './holidays'

function publishedDates(year: number): string[] {
  const notice = holidayNoticeOf(year)
  if (!notice) throw new Error(`missing test notice for ${year}`)
  return notice.ranges.flatMap((range) => {
    const end = Temporal.PlainDate.from(range.to)
    const dates: string[] = []
    for (let date = Temporal.PlainDate.from(range.from); Temporal.PlainDate.compare(date, end) <= 0; date = date.add({ days: 1 }))
      dates.push(date.toString())
    return dates
  })
}

beforeAll(async () => {
  await initI18n()
  await setLocale('en-US', false)
})

afterEach(async () => {
  await setLocale('en-US', false)
})

describe('holidayPresets', () => {
  it.each([[2025, 28], [2026, 33]])('expands every published %i day off and counts %i events', (year, count) => {
    const presets = holidayPresets(year)
    const notice = holidayNoticeOf(year)!
    expect(presets).toHaveLength(count)
    expect(presets.map(preset => preset.date)).toEqual(publishedDates(year))
    expect(new Set(presets.map(preset => preset.date)).size).toBe(count)
    for (const preset of presets) {
      const holiday = holidayDay(preset.date)
      expect(holiday.off).toBe(true)
      expect(preset.title).toBe(t(holiday.name!))
    }
    for (const makeup of notice.makeup)
      expect(presets.some(preset => preset.date === makeup.date)).toBe(false)
    expect(presets.some(preset => ['07-04', '12-25'].some(suffix => preset.date.endsWith(suffix)))).toBe(false)
  })

  it('keeps the same published dates in Chinese and localizes every holiday name', async () => {
    for (const year of [2025, 2026]) {
      const english = holidayPresets(year)
      await setLocale('zh-CN', false)
      const chinese = holidayPresets(year)
      expect(chinese.map(preset => preset.date)).toEqual(english.map(preset => preset.date))
      for (let index = 0; index < english.length; index++) {
        const holiday = holidayDay(english[index]!.date)
        expect(chinese[index]!.title).toBe(t(holiday.name!))
      }
      const springFestivalDate = year === 2025 ? '2025-01-28' : '2026-02-15'
      expect(chinese.find(preset => preset.date === springFestivalDate)?.title)
        .toBe(t('calendar.holidays.spring_festival'))
      await setLocale('en-US', false)
    }
  })

  it('does not invent events for an unpublished year in either locale', async () => {
    expect(holidayPresets(2027)).toEqual([])
    await setLocale('zh-CN', false)
    expect(holidayPresets(2027)).toEqual([])
  })
})
