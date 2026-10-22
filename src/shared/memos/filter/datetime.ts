export const MEMO_FILTER_DATE_PARTS = [
  'getFullYear',
  'getMonth',
  'getDate',
  'getDayOfWeek',
  'getHours',
  'getMinutes',
  'getSeconds',
] as const

export type MemoFilterDatePart = (typeof MEMO_FILTER_DATE_PARTS)[number]

export interface MemoFilterLocalDate {
  year: number
  monthIndex: number
  day: number
  dayOfWeek: number
  hours: number
  minutes: number
  seconds: number
}

export function isMemoFilterDatePart(name: string): name is MemoFilterDatePart {
  return (MEMO_FILTER_DATE_PARTS as readonly string[]).includes(name)
}

const DURATION_UNITS: Record<string, number> = {
  h: 3_600,
  m: 60,
  s: 1,
  ms: 0.001,
  us: 0.000_001,
  'µs': 0.000_001,
  ns: 0.000_000_001,
}

const DURATION_PART = /^(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/

export function parseDurationSeconds(value: string): number | null {
  if (value === '0') return 0
  if (!/^\d/.test(value)) return null
  let index = 0
  let total = 0
  while (index < value.length) {
    const match = DURATION_PART.exec(value.slice(index))
    if (!match) return null
    const amount = Number(match[1])
    const unit = DURATION_UNITS[match[2]!]
    if (!Number.isFinite(amount) || unit === undefined) return null
    total += amount * unit
    index += match[0].length
  }
  return Number.isFinite(total) ? total : null
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

export function parseTimestampSeconds(value: string): number | null {
  const dateOnly = DATE_ONLY.exec(value)
  if (dateOnly) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    if (!isCalendarDate(year, month, day)) return null
    const instant = new Date(0)
    instant.setUTCFullYear(year, month - 1, day)
    instant.setUTCHours(0, 0, 0, 0)
    return instant.getTime() / 1000
  }

  const dateTime = DATE_TIME.exec(value)
  if (!dateTime) return null
  const year = Number(dateTime[1])
  const month = Number(dateTime[2])
  const day = Number(dateTime[3])
  const hours = Number(dateTime[4])
  const minutes = Number(dateTime[5])
  const seconds = Number(dateTime[6])
  if (!isCalendarDate(year, month, day)) return null
  if (hours > 23 || minutes > 59 || seconds > 59) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  return Math.floor(milliseconds / 1000)
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const instant = new Date(0)
  instant.setUTCFullYear(year, month - 1, day)
  instant.setUTCHours(0, 0, 0, 0)
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  )
}

export function createLocalDatePartsReader(timeZone: string): (seconds: number) => MemoFilterLocalDate {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  } catch (error) {
    throw new Error(`memo filter: invalid time zone "${timeZone}"`, { cause: error })
  }

  return (seconds: number) => {
    if (!Number.isFinite(seconds)) {
      throw new Error(`memo filter: timestamp ${seconds} is not a valid instant`)
    }
    const parts = formatter.formatToParts(new Date(seconds * 1000))
    const read = (type: string): number => {
      const part = parts.find((entry) => entry.type === type)
      if (!part) throw new Error(`memo filter: formatted timestamp is missing "${type}"`)
      return Number(part.value)
    }
    const year = read('year')
    const monthIndex = read('month') - 1
    const day = read('day')
    return {
      year,
      monthIndex,
      day,
      dayOfWeek: new Date(Date.UTC(year, monthIndex, day)).getUTCDay(),
      hours: read('hour'),
      minutes: read('minute'),
      seconds: read('second'),
    }
  }
}

export function readMemoFilterDatePart(parts: MemoFilterLocalDate, part: MemoFilterDatePart): number {
  switch (part) {
    case 'getFullYear':
      return parts.year
    case 'getMonth':
      return parts.monthIndex
    case 'getDate':
      return parts.day
    case 'getDayOfWeek':
      return parts.dayOfWeek
    case 'getHours':
      return parts.hours
    case 'getMinutes':
      return parts.minutes
    case 'getSeconds':
      return parts.seconds
  }
}
