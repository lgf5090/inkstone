import type { DateRangeFilter } from '@shared/types'
import { dateKey, type WeekStartDay } from '../../lib/time'



/** Convert an inclusive month range (0-11 indices within a year) to inclusive day keys. */
export function monthRangeToKeys(year: number, startMonth: number, endMonth: number): DateRangeFilter {
  const start = Math.min(startMonth, endMonth)
  const end = Math.max(startMonth, endMonth)
  return { start: dateKey(new Date(year, start, 1)), end: dateKey(new Date(year, end + 1, 0)) }
}



export function alignWeekStart(date: Date, weekStart: WeekStartDay): Date {
  const out = new Date(date)
  out.setHours(0, 0, 0, 0)
  out.setDate(out.getDate() - ((out.getDay() - weekStart + 7) % 7))
  return out
}
