/**
 * The smallest EXIF reader that answers one question: when was this picture taken?
 *
 * Only the JPEG APP1 `Exif` block is parsed, and only to the `ExifSubIFD` pointer and its date tags.
 * That is where a camera writes `DateTimeOriginal`, and it is always within the first few kilobytes,
 * so a caller can hand over a ranged slice instead of the whole file. Anything unrecognised returns
 * `null` — a photo without EXIF, a PNG, a stripped thumbnail, or a block whose offsets do not line
 * up. No dependency is justified by one date field.
 */

const MAX_SCAN_BYTES = 128 * 1024
const TAG_DATETIME_ORIGINAL = 0x9003
const TAG_DATETIME = 0x0132
const TAG_EXIF_SUB_IFD = 0x8769
/** The ASCII date a camera stores: `2020:03:04 15:06:07`, in the camera's own zone. */
const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

function parseExifDate(value: string): number | null {
  const match = EXIF_DATE.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  return Number.isFinite(time) ? time : null
}

/** One IFD entry's value as ASCII, given the block, its endianness and the entry's offset/size. */
function asciiAt(view: DataView, little: boolean, base: number, type: number, count: number, valueOffset: number): string | null {
  if (type !== 2) return null
  const bytes = count
  // Values longer than four bytes live at a pointer stored in the value field.
  const offset = bytes <= 4
    ? valueOffset
    : (little ? view.getUint32(valueOffset, true) : view.getUint32(valueOffset, false))
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + bytes > view.byteLength) return null
  let text = ''
  for (let index = 0; index < bytes; index++) {
    const code = view.getUint8(base + offset + index)
    if (code === 0) break
    text += String.fromCharCode(code)
  }
  return text
}

function readIfdTags(
  view: DataView,
  little: boolean,
  base: number,
  ifdOffset: number,
  want: number[],
): Map<number, string> {
  const found = new Map<number, string>()
  const header = base + ifdOffset
  if (header < base || header + 2 > view.byteLength) return found
  const count = little ? view.getUint16(header, true) : view.getUint16(header, false)
  if (count > 255) return found
  for (let index = 0; index < count; index++) {
    const entry = header + 2 + index * 12
    if (entry + 12 > view.byteLength) break
    const tag = little ? view.getUint16(entry, true) : view.getUint16(entry, false)
    if (!want.includes(tag)) continue
    const type = little ? view.getUint16(entry + 2, true) : view.getUint16(entry + 2, false)
    const size = little ? view.getUint32(entry + 4, true) : view.getUint32(entry + 4, false)
    const text = asciiAt(view, little, base, type, size, entry + 8)
    if (text) found.set(tag, text)
  }
  return found
}

/** The pointer to `ExifSubIFD`, which is where the capture date actually lives. */
function subIfdOffset(view: DataView, little: boolean, base: number, ifd0: number): number | null {
  const header = base + ifd0
  if (header + 2 > view.byteLength) return null
  const count = little ? view.getUint16(header, true) : view.getUint16(header, false)
  if (count > 255) return null
  for (let index = 0; index < count; index++) {
    const entry = header + 2 + index * 12
    if (entry + 12 > view.byteLength) return null
    const tag = little ? view.getUint16(entry, true) : view.getUint16(entry, false)
    if (tag !== TAG_EXIF_SUB_IFD) continue
    return little ? view.getUint32(entry + 8, true) : view.getUint32(entry + 8, false)
  }
  return null
}

/** The capture time of a JPEG in milliseconds, or `null` when the bytes do not say. */
export function exifTakenAt(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, MAX_SCAN_BYTES))
  let offset = 2
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null
    const marker = view.getUint8(offset + 1)
    // 0xE1 is APP1, where the `Exif\0\0` block lives; 0xD8/0x01 and the RST range carry no length.
    if (marker === 0xda || marker === 0xd9) return null
    const size = view.getUint16(offset + 2, false)
    const segmentStart = offset + 2
    if (marker === 0xe1) {
      const header = segmentStart + 2
      if (header + 6 > view.byteLength) return null
      const isExif = view.getUint32(header, false) === 0x45786966 && view.getUint16(header + 4, false) === 0x0000
      if (!isExif) return null
      const base = header + 6
      if (base + 8 > view.byteLength) return null
      const little = view.getUint16(base, false) === 0x4949
      // The magic 42 is stored in the block's own byte order, so it has to be read in that order.
      if ((little ? view.getUint16(base + 2, true) : view.getUint16(base + 2, false)) !== 0x2a) return null
      const ifd0 = little ? view.getUint32(base + 4, true) : view.getUint32(base + 4, false)
      const first = readIfdTags(view, little, base, ifd0, [TAG_DATETIME, TAG_EXIF_SUB_IFD])
      const sub = subIfdOffset(view, little, base, ifd0)
      if (sub !== null) {
        const deep = readIfdTags(view, little, base, sub, [TAG_DATETIME_ORIGINAL, TAG_DATETIME])
        const original = deep.get(TAG_DATETIME_ORIGINAL) ?? deep.get(TAG_DATETIME) ?? first.get(TAG_DATETIME)
        return original ? parseExifDate(original) : null
      }
      const fallback = first.get(TAG_DATETIME)
      return fallback ? parseExifDate(fallback) : null
    }
    if (size < 2) return null
    offset = segmentStart + size
  }
  return null
}
