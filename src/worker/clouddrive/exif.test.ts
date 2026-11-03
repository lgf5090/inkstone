import { describe, expect, it } from 'vitest'
import { exifTakenAt } from './exif'

const DATE = '2020:03:04 15:06:07'
const EXPECTED = Date.UTC(2020, 2, 4, 15, 6, 7)

interface Entry {
  tag: number
  value: number | string
}

/**
 * Assembles a JPEG whose APP1 holds a real (if minimal) TIFF: one IFD0 and, when asked, one ExifSubIFD
 * reachable through tag 0x8769. ASCII values longer than four bytes go after the IFDs, which is what a
 * camera does, so the reader has to follow the pointer rather than read the field inline.
 */
function jpeg(options: { little?: boolean; ifd0: Entry[]; sub?: Entry[] }): Uint8Array {
  const little = options.little !== false
  const bytes: number[] = [0xff, 0xd8]
  const tiff = new Uint8Array(64 * 1024)
  const view = new DataView(tiff.buffer)
  // II*\0 or MM\0*, then the offset of IFD0 (8) and nothing else before it.
  tiff.set(little ? [0x49, 0x49, 0x2a, 0x00] : [0x4d, 0x4d, 0x00, 0x2a], 0)
  view.setUint32(4, 8, little)

  const strings: { at: number; text: string }[] = []
  let tail = 8

  function writeIfd(start: number, entries: Entry[]): number {
    let at = start
    view.setUint16(at, entries.length, little)
    at += 2
    for (const entry of entries) {
      view.setUint16(at, entry.tag, little)
      if (typeof entry.value === 'number') {
        view.setUint16(at + 2, 4, little)
        view.setUint32(at + 4, 1, little)
        view.setUint32(at + 8, entry.value, little)
      } else {
        const text = `${entry.value}\0`
        view.setUint16(at + 2, 2, little)
        view.setUint32(at + 4, text.length, little)
        strings.push({ at: at + 8, text })
      }
      at += 12
    }
    view.setUint32(at, 0, little)
    return at + 4
  }

  const ifd0Start = tail
  if (options.sub) {
    // IFD0 sits at 8, so the sub-IFD begins right after its entries and its next-IFD pointer.
    const subAt = ifd0Start + 2 + options.ifd0.length * 12 + 4
    for (const entry of options.ifd0) {
      if (entry.tag === 0x8769) entry.value = subAt
    }
  }
  const ifd0End = writeIfd(ifd0Start, options.ifd0)
  tail = ifd0End
  if (options.sub) tail = writeIfd(tail, options.sub)
  for (const item of strings) {
    const at = tail
    for (let index = 0; index < item.text.length; index++) tiff[at + index] = item.text.charCodeAt(index)
    view.setUint32(item.at, at, little)
    tail += item.text.length
  }
  const payload = tiff.subarray(0, tail)
  const size = payload.byteLength + 8
  const segment = [0xff, 0xe1, (size >> 8) & 0xff, size & 0xff, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]
  const out = new Uint8Array(bytes.length + segment.length + payload.byteLength + 2)
  out.set(bytes, 0)
  out.set(segment, bytes.length)
  out.set(payload, bytes.length + segment.length)
  out[out.byteLength - 2] = 0xff
  out[out.byteLength - 1] = 0xd9
  return out
}

describe('exifTakenAt', () => {
  it('follows IFD0 into the ExifSubIFD and reads DateTimeOriginal', () => {
    const bytes = jpeg({
      ifd0: [{ tag: 0x0112, value: 1 }, { tag: 0x8769, value: 0 }],
      sub: [{ tag: 0x9003, value: DATE }],
    })
    expect(exifTakenAt(bytes)).toBe(EXPECTED)
  })

  it('reads a big-endian TIFF the same way', () => {
    const bytes = jpeg({
      little: false,
      ifd0: [{ tag: 0x8769, value: 0 }],
      sub: [{ tag: 0x9003, value: DATE }],
    })
    expect(exifTakenAt(bytes)).toBe(EXPECTED)
  })

  it('falls back to the IFD0 DateTime when there is no sub-IFD', () => {
    const bytes = jpeg({ ifd0: [{ tag: 0x0132, value: DATE }] })
    expect(exifTakenAt(bytes)).toBe(EXPECTED)
  })

  it('prefers the capture time over the file time when both are present', () => {
    const bytes = jpeg({
      ifd0: [{ tag: 0x0132, value: '1999:01:01 00:00:00' }, { tag: 0x8769, value: 0 }],
      sub: [{ tag: 0x0132, value: '1999:01:01 00:00:00' }, { tag: 0x9003, value: DATE }],
    })
    expect(exifTakenAt(bytes)).toBe(EXPECTED)
  })

  it('returns null for anything that is not a JPEG with an Exif block', () => {
    expect(exifTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(exifTakenAt(new Uint8Array(0))).toBeNull()
    expect(exifTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04]))).toBeNull()
  })

  it('survives a block whose offsets point outside it', () => {
    const bytes = jpeg({ ifd0: [{ tag: 0x8769, value: 60000 }], sub: [{ tag: 0x9003, value: DATE }] })
    expect(() => exifTakenAt(bytes)).not.toThrow()
    expect(exifTakenAt(bytes.subarray(0, 40))).toBeNull()
  })
})
