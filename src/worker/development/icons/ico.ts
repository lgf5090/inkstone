/**
 * ICO packing.
 *
 * Every entry is a PNG payload: the format allows PNG-compressed images and that is the only
 * encoder this worker already has. The directory is validated on both sides so a corrupt upstream
 * artifact cannot be served as if it were an icon.
 */

export interface IcoEntry {
  size: number
  png: Uint8Array
}

export const ICO_MAX_ENTRIES = 4
export const ICO_MAX_BYTES = 256 * 1024

function assertSize(size: number): void {
  if (![16, 32, 48, 256].includes(size)) throw new Error(`ICO size ${size} is not supported`)
}

/** The canonical token used in object keys: sizes sorted ascending and joined with dashes. */
export function icoSizesToken(sizes: readonly number[]): string {
  return [...new Set(sizes)].sort((left, right) => left - right).join('-')
}

export function encodeIco(entries: readonly IcoEntry[]): Uint8Array {
  if (!entries.length || entries.length > ICO_MAX_ENTRIES) throw new Error('An ICO carries one to four images')
  const seen = new Set<number>()
  let offset = 6 + entries.length * 16
  for (const entry of entries) {
    assertSize(entry.size)
    if (seen.has(entry.size)) throw new Error(`The ICO repeats size ${entry.size}`)
    seen.add(entry.size)
    if (!entry.png.byteLength) throw new Error('An ICO entry is empty')
    if (entry.png.byteLength > ICO_MAX_BYTES) throw new Error('An ICO entry is too large')
  }

  const output = new Uint8Array(offset + entries.reduce((sum, entry) => sum + entry.png.byteLength, 0))
  const view = new DataView(output.buffer)
  view.setUint16(0, 0, true)
  view.setUint16(2, 1, true)
  view.setUint16(4, entries.length, true)
  entries.forEach((entry, index) => {
    const base = 6 + index * 16
    output[base] = entry.size === 256 ? 0 : entry.size
    output[base + 1] = entry.size === 256 ? 0 : entry.size
    output[base + 2] = 0
    output[base + 3] = 0
    view.setUint16(base + 4, 1, true)
    view.setUint16(base + 6, 32, true)
    view.setUint32(base + 8, entry.png.byteLength, true)
    view.setUint32(base + 12, offset, true)
    output.set(entry.png, offset)
    offset += entry.png.byteLength
  })
  return output
}

/** Parse and validate an ICO's directory. Used by tests and by the upload guard. */
export function inspectIco(bytes: Uint8Array): { count: number; sizes: number[] } {
  if (bytes.byteLength < 6) throw new Error('The ICO header is truncated')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) throw new Error('The ICO header is not valid')
  const count = view.getUint16(4, true)
  if (!count || count > ICO_MAX_ENTRIES) throw new Error('The ICO entry count is not valid')
  if (bytes.byteLength < 6 + count * 16) throw new Error('The ICO directory is truncated')
  const sizes: number[] = []
  for (let index = 0; index < count; index += 1) {
    const base = 6 + index * 16
    const width = bytes[base] === 0 ? 256 : bytes[base]!
    const height = bytes[base + 1] === 0 ? 256 : bytes[base + 1]!
    if (width !== height) throw new Error('An ICO entry is not square')
    const length = view.getUint32(base + 8, true)
    const offset = view.getUint32(base + 12, true)
    if (!length || offset < 6 + count * 16 || offset + length > bytes.byteLength) throw new Error('An ICO entry points outside the file')
    sizes.push(width)
  }
  return { count, sizes }
}
