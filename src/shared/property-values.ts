export type PropertyValueKind = 'text' | 'number' | 'boolean' | 'tags' | 'array' | 'object'

export type DateShape = 'date' | 'datetime'

export type RelativeDate = 'past' | 'present' | 'future' | 'none'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/

const TAG_KEYS = new Set(['tags', 'tag'])


export function propertyValueKind(value: unknown, key: string): PropertyValueKind {
  if (typeof value === 'boolean')
    return 'boolean'
  if (typeof value === 'number')
    return 'number'
  if (Array.isArray(value))
    return TAG_KEYS.has(key.toLocaleLowerCase()) ? 'tags' : 'array'
  if (value === null || value === undefined || typeof value === 'string')
    return 'text'
  return 'object'
}


export function propertyValuesOf(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map((item) => item === null || item === undefined ? '' : String(item))
  if (value === null || value === undefined)
    return []
  if (typeof value === 'string')
    return value ? [value] : []
  return [String(value)]
}


export function propertyDisplayText(value: unknown): string {
  if (value === null || value === undefined)
    return ''
  if (typeof value === 'string')
    return value
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value))
    return value.map((item) => propertyDisplayText(item)).join(', ')
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? ''
    }
    catch {
      return ''
    }
  }
  return String(value)
}


export function isPropertyEmpty(value: unknown): boolean {
  if (value === null || value === undefined)
    return true
  if (typeof value === 'string')
    return value.trim() === ''
  if (Array.isArray(value))
    return value.length === 0
  return false
}


export function dateShapeOf(value: unknown): DateShape | null {
  const parsed = parsePropertyValueDate(value)
  return parsed ? parsed.shape : null
}

export interface ParsedPropertyValueDate {
  shape: DateShape
  time: number
  dayKey: string
}

export function parsePropertyValueDate(value: unknown): ParsedPropertyValueDate | null {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text)
    return null
  const day = DATE_ONLY.exec(text)
  if (day) {
    const year = Number(day[1])
    const month = Number(day[2])
    const date = Number(day[3])
    if (!isRealDay(year, month, date))
      return null
    const stamp = new Date(year, month - 1, date)
    if (stamp.getFullYear() !== year || stamp.getMonth() !== month - 1 || stamp.getDate() !== date)
      return null
    return { shape: 'date', time: stamp.getTime(), dayKey: text }
  }
  const full = DATE_TIME.exec(text)
  if (!full)
    return null
  const year = Number(full[1])
  const month = Number(full[2])
  const date = Number(full[3])
  const hour = Number(full[4])
  const minute = Number(full[5])
  const second = full[6] ? Number(full[6]) : 0
  const ms = full[7] ? Number(full[7].padEnd(3, '0')) : 0
  if (!isRealDay(year, month, date) || hour > 23 || minute > 59 || second > 59)
    return null
  const zone = full[8]
  let stamp: Date
  if (zone === 'Z')
    stamp = new Date(Date.UTC(year, month - 1, date, hour, minute, second, ms))
  else if (typeof zone === 'string' && zone.length > 1) {
    const sign = zone[0] === '-' ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0)) * sign
    stamp = new Date(Date.UTC(year, month - 1, date, hour, minute, second, ms) - offset * 60_000)
  }
  else
    stamp = new Date(year, month - 1, date, hour, minute, second, ms)
  if (!Number.isFinite(stamp.getTime()))
    return null
  return {
    shape: 'datetime',
    time: stamp.getTime(),
    dayKey: `${String(stamp.getFullYear()).padStart(4, '0')}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}`,
  }
}

function isRealDay(year: number, month: number, date: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || date < 1 || date > 31)
    return false
  const back = new Date(Date.UTC(year, month - 1, date))
  return back.getUTCMonth() === month - 1 && back.getUTCDate() === date
}

export function dayKeyOf(stamp: number): string {
  const date = new Date(stamp)
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}


export function relativeDateOf(value: unknown, now: number): RelativeDate {
  const parsed = parsePropertyValueDate(value)
  if (!parsed)
    return 'none'
  if (parsed.shape === 'date') {
    const today = dayKeyOf(now)
    if (parsed.dayKey === today)
      return 'present'
    return parsed.dayKey < today ? 'past' : 'future'
  }
  const difference = parsed.time - now
  const minutes = Math.trunc(Math.abs(difference) / 60_000)
  if (minutes < 1)
    return 'present'
  return difference < 0 ? 'past' : 'future'
}
