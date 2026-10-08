const PREFIX = 'b64.'

/**
 * The two escapers live here rather than in `renderer.ts` because a fence module that builds markup has
 * to be able to reach them without importing the renderer back. `renderer.ts` re-exports both, so every
 * existing caller keeps the same import path.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, '&#39;').replace(/\n/g, '&#10;')
}


export function encodeDataValue(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunkSize = 0x4000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return (
    PREFIX +
    btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
  )
}

export function decodeDataValue(value: string | undefined): string {
  if (!value?.startsWith(PREFIX)) return value ?? ''
  try {
    const encoded = value.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}
