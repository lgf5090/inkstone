export type GenKind = 'skip' | 'sequence' | 'integer' | 'real' | 'text' | 'uuid' | 'email' | 'ip' | 'date' | 'bool' | 'enum'

export interface GenConfig {
  kind: GenKind
  start?: number
  step?: number
  min?: number
  max?: number
  decimals?: number
  length?: number
  values?: string[]
}

export interface ColumnGen {
  name: string
  config: GenConfig
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pick(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

function randomText(rng: () => number, length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  let out = ''
  for (let index = 0; index < length; index++) out += alphabet[pick(rng, 0, alphabet.length - 1)]
  return out
}

function randomHex(rng: () => number, length: number): string {
  const alphabet = '0123456789abcdef'
  let out = ''
  for (let index = 0; index < length; index++) out += alphabet[pick(rng, 0, 15)]
  return out
}

export function generateValue(config: GenConfig, rowIndex: number, rng: () => number): unknown {
  switch (config.kind) {
    case 'sequence':
      return (config.start ?? 1) + rowIndex * (config.step ?? 1)
    case 'integer':
      return pick(rng, config.min ?? 0, config.max ?? 1000)
    case 'real': {
      const value = (config.min ?? 0) + rng() * ((config.max ?? 1000) - (config.min ?? 0))
      return Number(value.toFixed(Math.max(0, Math.min(6, config.decimals ?? 2))))
    }
    case 'text':
      return randomText(rng, Math.max(1, Math.min(64, config.length ?? 8)))
    case 'uuid': {
      const hex = randomHex(rng, 32).split('')
      hex[12] = '4'
      hex[16] = '89ab'[pick(rng, 0, 3)]!
      const text = hex.join('')
      return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
    }
    case 'email':
      return `${randomText(rng, 6)}.${randomHex(rng, 3)}@example.com`
    case 'ip':
      return `${pick(rng, 1, 223)}.${pick(rng, 0, 255)}.${pick(rng, 0, 255)}.${pick(rng, 1, 254)}`
    case 'date': {
      const start = Date.UTC(2020, 0, 1)
      const end = Date.UTC(2025, 11, 31)
      const stamp = start + Math.floor(rng() * (end - start))
      return new Date(stamp).toISOString().slice(0, 10)
    }
    case 'bool':
      return rng() > 0.5 ? 1 : 0
    case 'enum': {
      const values = (config.values ?? []).filter((value) => value.trim().length > 0)
      return values.length > 0 ? values[pick(rng, 0, values.length - 1)] : null
    }
    default:
      return null
  }
}

export function generateRows(columns: ColumnGen[], count: number, seed = 42): unknown[][] {
  const rng = mulberry32(seed)
  const active = columns.filter((column) => column.config.kind !== 'skip')
  const rows: unknown[][] = []
  for (let index = 0; index < count; index++) {
    rows.push(active.map((column) => generateValue(column.config, index, rng)))
  }
  return rows
}
