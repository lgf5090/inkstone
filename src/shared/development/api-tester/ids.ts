const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

export function newApiTesterId(): string {
  let stamp = ''
  let value = Date.now()
  for (let index = 0; index < 10; index++) {
    stamp = ALPHABET[value % 32] + stamp
    value = Math.floor(value / 32)
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let random = ''
  for (let index = 0; index < 16; index++) random += ALPHABET[bytes[index]! & 31]
  return stamp + random
}

export function isApiTesterId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-hjkmnp-tv-z]{26}$/.test(value)
}
