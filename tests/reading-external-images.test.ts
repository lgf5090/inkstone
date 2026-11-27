// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { prepareChapter } from '../src/client/features/reading/engine/chapter'
import type { EpubPackage } from '../src/client/features/reading/engine/epub-package'
import type { ZipArchive } from '../src/client/features/reading/engine/zip'

function source() {
  const html = '<html><head><style>p { background: url("https://tracker.example/pixel.png") }</style></head><body><p>text</p><img src="https://tracker.example/pixel.png" alt="pixel"></body></html>'
  const archive = {
    readText: vi.fn(async () => html),
    has: () => false,
    read: vi.fn(),
    entries: [],
  } as unknown as ZipArchive
  const pkg = {
    spine: [{ idref: 'c1', item: { id: 'c1', href: 'chapter.xhtml', mediaType: 'application/xhtml+xml', properties: [] }, linear: true }],
    byPath: new Map([['chapter.xhtml', { id: 'c1', href: 'chapter.xhtml', mediaType: 'application/xhtml+xml', properties: [] }]]),
  } as unknown as EpubPackage
  const pool = { urlFor: vi.fn(async () => 'blob:internal'), cached: () => undefined, revokeAll: vi.fn() }
  return { archive, pkg, pool }
}

describe('prepareChapter external images', () => {
  it('removes remote image URLs by default', async () => {
    const input = source()
    const chapter = await prepareChapter(input, 0, '.reader-doc', { allowExternalImages: false })
    expect(chapter?.html).not.toContain('tracker.example')
    expect(chapter?.css).not.toContain('tracker.example')
    expect(input.pool.urlFor).not.toHaveBeenCalled()
  })

  it('keeps remote image URLs only when the reader opts in', async () => {
    const input = source()
    const chapter = await prepareChapter(input, 0, '.reader-doc', { allowExternalImages: true })
    expect(chapter?.html).toContain('https://tracker.example/pixel.png')
    expect(chapter?.css).toContain('https://tracker.example/pixel.png')
  })
})
