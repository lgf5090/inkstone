/**
 * A five-field cron parser for the module's scheduled tasks.
 *
 * The reference module used `node-cron`, which a Worker cannot load. Only the matching half is needed
 * here: a Worker is invoked by the platform's own cron trigger, and the question it asks is "does this
 * task's expression include this minute?" — not "when is the next fire?".
 *
 * Supported per field: `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, and comma lists. Day of
 * month and day of week follow the usual cron rule: when both are restricted, either may match.
 */
export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  dayOfMonthRestricted: boolean
  dayOfWeekRestricted: boolean
}

const LIMITS: readonly [keyof Omit<CronFields, 'dayOfMonthRestricted' | 'dayOfWeekRestricted'>, number, number][] = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dayOfMonth', 1, 31],
  ['month', 1, 12],
  ['dayOfWeek', 0, 7],
]

function parseField(raw: string, name: string, min: number, max: number): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>()
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error(`${name} is empty`)
  for (const part of parts) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`${name} has an invalid step: ${part}`)
    let start = min
    let end = max
    if (rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [left, right] = rangePart.split('-').map(Number)
        if (!Number.isInteger(left) || !Number.isInteger(right) || left > right) {
          throw new Error(`${name} has an invalid range: ${part}`)
        }
        start = left
        end = right
      } else {
        const single = Number(rangePart)
        if (!Number.isInteger(single)) throw new Error(`${name} has a non-numeric value: ${part}`)
        start = single
        end = stepPart === undefined ? single : max
      }
    }
    for (let value = start; value <= end; value += step) {
      if (value < min || value > max) throw new Error(`${name} is out of range: ${value}`)
      values.add(name === 'dayOfWeek' && value === 7 ? 0 : value)
    }
  }
  return { values, restricted: raw.trim() !== '*' }
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('A cron expression has five fields: minute hour day month weekday')
  const parsed = {} as CronFields
  for (let index = 0; index < LIMITS.length; index++) {
    const [key, min, max] = LIMITS[index]!
    const { values, restricted } = parseField(fields[index]!, key, min, max)
    parsed[key] = values
    if (key === 'dayOfMonth') parsed.dayOfMonthRestricted = restricted
    if (key === 'dayOfWeek') parsed.dayOfWeekRestricted = restricted
  }
  return parsed
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression)
    return true
  } catch {
    return false
  }
}

export function cronMatches(expression: string, date: Date): boolean {
  let fields: CronFields
  try {
    fields = parseCron(expression)
  } catch {
    return false
  }
  if (!fields.minute.has(date.getUTCMinutes())) return false
  if (!fields.hour.has(date.getUTCHours())) return false
  if (!fields.month.has(date.getUTCMonth() + 1)) return false
  const dayMatches = fields.dayOfMonth.has(date.getUTCDate())
  const weekdayMatches = fields.dayOfWeek.has(date.getUTCDay())
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return dayMatches || weekdayMatches
  if (fields.dayOfMonthRestricted) return dayMatches
  if (fields.dayOfWeekRestricted) return weekdayMatches
  return true
}
