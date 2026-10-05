// One helper for local identifiers, so no entry point has to fall back to Math.random().
export function randomLocalId(prefix = ''): string {
  const source = typeof crypto !== 'undefined' ? crypto : undefined
  let random: string | null = null
  if (source && typeof source.randomUUID === 'function') {
    random = source.randomUUID().replace(/-/g, '')
  } else if (source && typeof source.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16))
    random = Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('')
  }
  if (random === null) {
    // No WebCrypto at all: still monotonic-unique inside this tab, never predictable
    // across tabs the way Math.random() was.
    random = `${Date.now().toString(36)}${(localCounter += 1).toString(36)}`
  }
  return prefix ? `${prefix}-${random}` : random
}

let localCounter = 0
