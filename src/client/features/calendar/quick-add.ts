import { Temporal } from 'temporal-polyfill'
import { ZH_QUICK_ADD_KEYWORDS as ZH } from '@shared/locales/zh-CN-quick-add-keywords'

export interface QuickAddResult {
  title: string
  start: Temporal.ZonedDateTime
  end: Temporal.ZonedDateTime
}

const WEEKDAYS: Record<string, number> = {
  ...ZH.weekdayNumbers,
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
}

function weekdayNumber(token: string): number | undefined {
  const key = token.toLowerCase()
  return WEEKDAYS[key] ?? WEEKDAYS[key.slice(0, 3)] ?? WEEKDAYS[key.replace(new RegExp(`^(${ZH.weekPrefixes})`), '')]
}

function durationMinutes(text: string): { minutes: number; token: string } | null {
  const hour = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${ZH.hourUnits})`).exec(text)
    ?? /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i.exec(text)
  if (hour) return { minutes: Math.round(Number(hour[1]) * 60), token: hour[0] }
  const minute = new RegExp(`(\\d+)\\s*${ZH.minuteUnit}`).exec(text)
    ?? /(\d+)\s*(?:minutes?|mins?|m)\b/i.exec(text)
  if (minute) return { minutes: Number(minute[1]), token: minute[0] }
  return null
}

function timeOfDay(text: string): { hour: number; minute: number; token: string } | null {
  const clock = /(\d{1,2})[:\uff1a](\d{2})\s*(am|pm)?/i.exec(text)
  if (clock) {
    let hour = Number(clock[1])
    const suffix = clock[3]?.toLowerCase()
    if (suffix === 'pm' && hour < 12) hour += 12
    if (suffix === 'am' && hour === 12) hour = 0
    return { hour, minute: Number(clock[2]), token: clock[0] }
  }
  const meridiem = /(\d{1,2})\s*(am|pm)\b/i.exec(text)
  if (meridiem) {
    let hour = Number(meridiem[1])
    if (meridiem[2].toLowerCase() === 'pm' && hour < 12) hour += 12
    if (meridiem[2].toLowerCase() === 'am' && hour === 12) hour = 0
    return { hour, minute: 0, token: meridiem[0] }
  }
  const chinese = new RegExp(`(\\d{1,2})\\s*[${ZH.timeUnits}](${ZH.half})?`).exec(text)
  if (chinese) {
    return { hour: Number(chinese[1]), minute: chinese[2] ? 30 : 0, token: chinese[0] }
  }
  return null
}

function dateOf(text: string, today: Temporal.ZonedDateTime): { date: Temporal.PlainDate | null; token: string | null } {
  const explicit = /(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (explicit) {
    try {
      return { date: Temporal.PlainDate.from(explicit[0]), token: explicit[0] }
    } catch {
      return { date: null, token: null }
    }
  }
  const chineseDate = new RegExp(`(\\d{1,2})\\s*${ZH.month}\\s*(\\d{1,2})\\s*[${ZH.daySuffixes}]`).exec(text)
  if (chineseDate) {
    const attempt = (year: number): Temporal.PlainDate | null => {
      try {
        return Temporal.PlainDate.from({ year, month: Number(chineseDate[1]), day: Number(chineseDate[2]) })
      } catch {
        return null
      }
    }
    const thisYear = attempt(today.year)
    const nextYear = thisYear && Temporal.PlainDate.compare(thisYear, today.toPlainDate()) < 0
      ? attempt(today.year + 1)
      : thisYear
    return { date: nextYear ?? thisYear, token: chineseDate[0] }
  }
  if (text.includes(ZH.afterTomorrow)) {
    return { date: today.toPlainDate().add({ days: 2 }), token: ZH.afterTomorrow }
  }
  const tomorrow = new RegExp(`${ZH.tomorrow}|tomorrow`, 'i').exec(text)
  if (tomorrow) return { date: today.toPlainDate().add({ days: 1 }), token: tomorrow[0] }
  const todayWord = new RegExp(`${ZH.today}|today`, 'i').exec(text)
  if (todayWord) return { date: today.toPlainDate(), token: todayWord[0] }

  const relative = new RegExp(`(${ZH.next}(?:${ZH.weekPrefixes})|next\\s+)([${ZH.weekdayChars}]|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)`, 'i').exec(text)
  if (relative) {
    const day = weekdayNumber(relative[2])
    if (day) {
      const current = today.dayOfWeek
      let delta = (day - current + 7) % 7
      if (new RegExp(`^(${ZH.next}|next)`, 'i').test(relative[1])) delta += 7
      return { date: today.toPlainDate().add({ days: delta }), token: relative[0] }
    }
  }
  const weekday = new RegExp(`(?:${ZH.weekPrefixes})([${ZH.weekdayChars}])`).exec(text)
    ?? /\b(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i.exec(text)
  if (weekday) {
    const day = weekdayNumber(weekday[1])
    if (day) {
      const delta = (day - today.dayOfWeek + 7) % 7
      return { date: today.toPlainDate().add({ days: delta }), token: weekday[0] }
    }
  }
  return { date: null, token: null }
}

/** Parse a small, predictable subset of Chinese/English quick-add text. */
export function parseQuickAdd(
  text: string,
  now: Date,
  timeZone: string,
  fallbackTitle: string,
  defaultDurationMinutes = 60,
): QuickAddResult | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone)
  const date = dateOf(trimmed, today)
  const time = timeOfDay(trimmed)
  const duration = durationMinutes(trimmed)
  const dateValue = date.date ?? today.toPlainDate()
  const start = Temporal.ZonedDateTime.from({
    timeZone,
    year: dateValue.year,
    month: dateValue.month,
    day: dateValue.day,
    hour: time?.hour ?? 9,
    minute: time?.minute ?? 0,
  })
  const end = start.add({ minutes: Math.max(5, duration?.minutes ?? defaultDurationMinutes) })

  let title = trimmed
  for (const token of [date.token, time?.token, duration?.token]) {
    if (token) title = title.replace(token, ' ')
  }
  title = title.replace(/\s+/g, ' ').replace(/^[-—:\uff1a,\uff0c\s]+|[-—:\uff1a,\uff0c\s]+$/g, '').trim()
  return { title: title || fallbackTitle, start, end }
}
