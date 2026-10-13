// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { coverMediaType, importBook } from '../src/client/features/reading/engine/book-import'
import { fixtureEpub, TINY_JPEG } from './reading-fixtures'

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

/**
 * What a whole import does with the cover a package declares, which is where the two rules above meet a
 * real book. A shelf tile of markup is what one reader's novel produced: its package names a real
 * cover.jpg the EPUB 2 way, the reader missed that and took the guide's cover *page* instead.
 */
async function imported(coverKind: 'property' | 'meta' | 'page') {
  const bytes = fixtureEpub({ coverKind })
  const file = new File([bytes] as unknown as BlobPart[], `cover-${coverKind}.epub`, { type: 'application/epub+zip' })
  return importBook(file)
}

describe('the cover a book import keeps', () => {
  it('keeps the picture an EPUB 3 property names', async () => {
    const one = await imported('property')
    expect(one.coverType).toBe('image/png')
    expect(one.record.coverPath).toBe('OEBPS/images/cover.png')
  })

  it('keeps the picture an EPUB 2 meta names', async () => {
    const one = await imported('meta')
    expect(one.coverType).toBe('image/jpeg')
    expect(Array.from(one.cover ?? [])).toEqual(Array.from(TINY_JPEG))
    expect(one.record.coverPath).toBe('OEBPS/images/cover.jpg')
  })

  it('keeps nothing when the declared cover is a page', async () => {
    const one = await imported('page')
    expect(one.cover).toBeNull()
    expect(one.coverType).toBe('')
    // The record has to stop claiming one too, or the device offers the bytes up as a cover to store.
    expect(one.record.coverPath).toBeNull()
    // And the book itself is still a book.
    expect(one.record.title.length).toBeGreaterThan(0)
  })
})
