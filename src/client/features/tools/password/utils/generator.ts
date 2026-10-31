/**
 * Cryptographically secure random password generator.
 */

export interface PasswordGeneratorOptions {
  length: number
  uppercase: boolean
  lowercase: boolean
  numbers: boolean
  symbols: boolean
  customSymbols: string
}

export const DEFAULT_CUSTOM_SYMBOLS = '!@#$%^&*()_+-=,.<>?/\\|[]{}:;"\'`~'

export const DEFAULT_GENERATOR_OPTIONS: PasswordGeneratorOptions = {
  length: 16,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
  customSymbols: DEFAULT_CUSTOM_SYMBOLS,
}

function getRandomInt(max: number): number {
  if (max <= 0) return 0
  const array = new Uint32Array(1)
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    // A password built from Math.random is not a password. There is no safe fallback, so this is an
    // error rather than a quietly weaker result.
    throw new Error('A secure random source is not available in this browser')
  }
  crypto.getRandomValues(array)
  return array[0] % max
}

export function generateRandomPassword(options: Partial<PasswordGeneratorOptions> = {}): string {
  const merged: PasswordGeneratorOptions = {
    ...DEFAULT_GENERATOR_OPTIONS,
    ...options,
  }

  const length = Math.max(1, Math.min(256, merged.length))
  // Each pool is deduplicated: a symbol typed twice in `customSymbols` would otherwise be twice as
  // likely as every other one, which is a weighting nobody asked for.
  const pools: string[] = []
  if (merged.uppercase) pools.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  if (merged.lowercase) pools.push('abcdefghijklmnopqrstuvwxyz')
  if (merged.numbers) pools.push('0123456789')
  if (merged.symbols && merged.customSymbols.length > 0) {
    pools.push([...new Set(merged.customSymbols)].join(''))
  }

  if (pools.length === 0) return ''

  const allChars = pools.join('')
  const result: string[] = []

  // Ensure at least one character from each selected charset when length allows
  if (length >= pools.length) {
    for (const pool of pools) {
      result.push(pool[getRandomInt(pool.length)])
    }
  }

  while (result.length < length) {
    result.push(allChars[getRandomInt(allChars.length)])
  }

  // Fisher-Yates shuffle
  for (let i = result.length - 1; i > 0; i--) {
    const j = getRandomInt(i + 1)
    const temp = result[i]
    result[i] = result[j]
    result[j] = temp
  }

  return result.join('')
}
