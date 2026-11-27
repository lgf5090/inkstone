import { Temporal } from 'temporal-polyfill'

export function calendarDayBounds(day: string, timeZone: string): { start: number; end: number } {
  const plain = Temporal.PlainDate.from(day)
  if (plain.toString() !== day) throw new Error('invalid_day')
  const start = plain.toZonedDateTime({ timeZone }).epochMilliseconds
  const end = plain.add({ days: 1 }).toZonedDateTime({ timeZone }).epochMilliseconds
  return { start, end }
}
