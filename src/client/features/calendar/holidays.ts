/**
 * Published holiday ranges expanded into one all-day event per day off.
 *
 * The shared notice table is the only source: locales translate its names but never choose different
 * dates, makeup workdays stay workdays, and a year without a published notice produces no events.
 */
import { Temporal } from 'temporal-polyfill'
import { holidayNoticeOf } from '@shared/calendar/holidays'
import { t } from '../../lib/i18n'

export interface HolidayPreset {
  date: string
  title: string
}

export function holidayPresets(year: number): HolidayPreset[] {
  const notice = holidayNoticeOf(year)
  if (!notice) return []

  const presets: HolidayPreset[] = []
  for (const range of notice.ranges) {
    const end = Temporal.PlainDate.from(range.to)
    for (let date = Temporal.PlainDate.from(range.from); Temporal.PlainDate.compare(date, end) <= 0; date = date.add({ days: 1 })) {
      presets.push({ date: date.toString(), title: t(range.name) })
    }
  }
  return presets
}
