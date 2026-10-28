export type TransformKind =
  | 'upper'
  | 'lower'
  | 'trim'
  | 'json'
  | 'unixToDate'
  | 'dateToUnix'
  | 'baseConvert'

export type TransformError = 'invalid_json' | 'invalid_number' | 'invalid_date' | 'invalid_base'

export interface TransformOptions {
  kind: TransformKind
  unit?: 's' | 'ms'
  fromBase?: number
  toBase?: number
}

export type TransformResult = { ok: true; text: string } | { ok: false; error: TransformError }

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function parseBase(input: string, base: number): bigint | null {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'
  const cleaned = input.trim().toLowerCase()
  const negative = cleaned.startsWith('-')
  const body = negative ? cleaned.slice(1) : cleaned
  if (!body) return null
  let value = 0n
  for (const character of body) {
    const digit = digits.indexOf(character)
    if (digit < 0 || digit >= base) return null
    value = value * BigInt(base) + BigInt(digit)
  }
  return negative ? -value : value
}

export function transformValue(value: unknown, options: TransformOptions): TransformResult {
  const source = text(value)
  switch (options.kind) {
    case 'upper':
      return { ok: true, text: source.toUpperCase() }
    case 'lower':
      return { ok: true, text: source.toLowerCase() }
    case 'trim':
      return { ok: true, text: source.trim() }
    case 'json': {
      try {
        return { ok: true, text: JSON.stringify(JSON.parse(source), null, 2) }
      } catch {
        return { ok: false, error: 'invalid_json' }
      }
    }
    case 'unixToDate': {
      const parsed = Number(source.trim())
      if (!Number.isFinite(parsed)) return { ok: false, error: 'invalid_number' }
      const millis = options.unit === 'ms' ? parsed : parsed * 1000
      const date = new Date(millis)
      if (Number.isNaN(date.getTime())) return { ok: false, error: 'invalid_date' }
      return { ok: true, text: date.toISOString().replace('T', ' ').replace('Z', ' UTC') }
    }
    case 'dateToUnix': {
      const parsed = Date.parse(source.trim())
      if (Number.isNaN(parsed)) return { ok: false, error: 'invalid_date' }
      return { ok: true, text: String(options.unit === 'ms' ? parsed : Math.floor(parsed / 1000)) }
    }
    case 'baseConvert': {
      const from = options.fromBase ?? 10
      const to = options.toBase ?? 16
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 2 || from > 36 || to < 2 || to > 36) {
        return { ok: false, error: 'invalid_base' }
      }
      const parsed = parseBase(source, from)
      if (parsed === null) return { ok: false, error: 'invalid_number' }
      return { ok: true, text: parsed.toString(to) }
    }
  }
}
