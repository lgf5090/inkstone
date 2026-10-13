// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { coverMediaType } from '../src/client/features/reading/engine/book-import'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]
const JPEG = [0xff, 0xd8, 0xff, 0xe0]
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]

function bytes(head: number[]): Uint8Array {
  return Uint8Array.from([...head, ...new Array(24).fill(0)])
}

describe('what a cover really is', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
  ])('reads %s off the bytes, whatever the name claims', (expected, head) => {
    expect(coverMediaType(bytes(head), 'cover.jpg')).toBe(expected)
  })

  it('falls back to the name only when the header says nothing', () => {
    const bmp = Uint8Array.from([0x42, 0x4d, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(coverMediaType(bmp, 'page.bmp')).toBe('image/bmp')
  })

  it('says nothing about a book with no cover', () => {
    expect(coverMediaType(null, 'cover.png')).toBe('')
  })

  it('does not invent a type for a name that has no extension', () => {
    expect(coverMediaType(Uint8Array.from([1, 2, 3, 4]), 'cover')).toBe('')
  })
})
