import { durationToMs, formatDateStamp, formatDurationAbbreviated, formatDurationHuman, formatDurationStamp } from './property-formats'
import { parsePropertyValueDate } from './property-values'
import type { TemplateHelper, TemplateVariables } from './property-templates'
import { renderPropertyTemplate } from './property-templates'

const MAX_NUMBER = 1e15

const DAY_MS = 86_400_000

const UNIT_ALIASES: Record<string, string> = {
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',
  min: 'm',
  mins: 'm',
  minute: 'm',
  minutes: 'm',
  hr: 'h',
  hour: 'h',
  hours: 'h',
  day: 'd',
  days: 'd',
  wk: 'w',
  week: 'w',
  weeks: 'w',
}


function num(value: string | undefined): number {
  const parsed = Number((value ?? '').trim())
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_NUMBER ? parsed : 0
}


function unit(value: string | undefined): string {
  const key = (value ?? 's').trim().toLocaleLowerCase()
  return UNIT_ALIASES[key] ?? key
}


function text(value: string | undefined): string {
  return value ?? ''
}


function durationMs(args: string[]): number | null {
  return durationToMs(num(args[0]), unit(args[1]))
}


function truthy(value: string | undefined): boolean {
  const trimmed = (value ?? '').trim().toLocaleLowerCase()
  return Boolean(trimmed) && trimmed !== 'false' && trimmed !== '0' && trimmed !== 'null'
}


function relativeSince(value: string, now: number, locale: string): string {
  const parsed = parsePropertyValueDate(value)
  if (!parsed)
    return value
  const difference = parsed.time - now
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * DAY_MS],
    ['month', 30 * DAY_MS],
    ['day', DAY_MS],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1000],
  ]
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [candidate, size] of units) {
    if (Math.abs(difference) >= size)
      return formatter.format(Math.round(difference / size), candidate)
  }
  return formatter.format(0, 'second')
}


export function buildPropertyTemplateHelpers(locale: string, now: number): Record<string, TemplateHelper> {
  return {
    upper: args => text(args[0]).toLocaleUpperCase(),
    lower: args => text(args[0]).toLocaleLowerCase(),
    trim: args => text(args[0]).trim(),
    capitalize: (args) => {
      const chars = Array.from(text(args[0]))
      return chars.length ? chars[0]!.toLocaleUpperCase() + chars.slice(1).join('') : ''
    },
    truncate: (args) => {
      const limit = Math.max(0, Math.trunc(num(args[1])))
      const chars = Array.from(text(args[0]))
      return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('')
    },
    replace: (args) => {
      const from = text(args[1])
      return from ? text(args[0]).replaceAll(from, text(args[2])) : text(args[0])
    },
    split: args => text(args[0]).split(text(args[1])).join(text(args[2])),
    concat: args => args.join(''),
    pad: (args) => {
      const width = Math.min(24, Math.trunc(num(args[1])))
      const value = text(args[0])
      if (value.length >= width)
        return value
      return (text(args[2]) || '0').repeat(width - value.length) + value
    },
    add: args => String(args.reduce((total, item) => total + num(item), 0)),
    sub: args => String(args.slice(1).reduce((total, item) => total - num(item), num(args[0]))),
    mul: args => String(args.reduce((total, item) => total * num(item), 1)),
    div: args => String(num(args[1]) === 0 ? 0 : num(args[0]) / num(args[1])),
    round: (args) => {
      const digits = Math.min(12, Math.max(0, Math.trunc(num(args[1]))))
      const factor = 10 ** digits
      return String(Math.round(num(args[0]) * factor) / factor)
    },
    floor: args => String(Math.floor(num(args[0]))),
    ceil: args => String(Math.ceil(num(args[0]))),
    min: args => String(args.length ? Math.min(...args.map(num)) : 0),
    max: args => String(args.length ? Math.max(...args.map(num)) : 0),
    percent: (args) => {
      const total = num(args[1]) || 100
      return `${Math.round((num(args[0]) / total) * 100)}%`
    },
    number: (args) => {
      const digits = Math.max(0, Math.trunc(num(args[1])))
      return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(num(args[0]))
    },
    if: args => (truthy(args[0]) ? text(args[1]) : text(args[2])),
    default: args => (text(args[0]).trim() ? text(args[0]) : text(args[1])),
    date: args => {
      const parsed = parsePropertyValueDate(text(args[0]))
      return parsed ? formatDateStamp(parsed.time, text(args[1]), locale) || text(args[0]) : text(args[0])
    },
    relative: args => relativeSince(text(args[0]), now, locale),
    durationAbbreviated: (args) => {
      const ms = durationMs(args)
      return ms === null ? text(args[0]) : formatDurationAbbreviated(ms)
    },
    durationFormatted: (args) => {
      const ms = durationMs(args)
      return ms === null ? text(args[0]) : formatDurationStamp(ms, text(args[2]) || 'HH:mm:ss')
    },
    durationHumanized: (args) => {
      const ms = durationMs(args)
      if (ms === null)
        return text(args[0])
      return formatDurationHuman(ms, truthy(args[2]) ? 'relative' : 'plain', locale)
    },
  }
}

export interface FormatInput {
  template: string
  propertyName: string
  propertyValue: string
  locale: string
  now: number
}


export function formatPropertyValue(input: FormatInput): string | null {
  const variables: TemplateVariables = {
    propertyName: input.propertyName,
    propertyValue: input.propertyValue,
  }
  return renderPropertyTemplate(input.template, variables, buildPropertyTemplateHelpers(input.locale, input.now))
}
