import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { buildFileDocument, buildNoteDocument, customPropertyValues, extensionOf, notePathOf, type NoteSource } from './document'
import { documentSettings } from './settings'

const HAN = String.fromCharCode(0x7814, 0x7a76)

function source(over: Partial<NoteSource> = {}): NoteSource {
  return {
    id: 'n1',
    title: 'Latte art',
    content: 'milk and foam',
    updatedAt: 1000,
    folderPath: 'Drinks',
    archived: false,
    starred: false,
    ...over,
  }
}

const settings = documentSettings(DEFAULT_SETTINGS.search)

describe('buildNoteDocument', () => {
  it('composes the path the path filter matches against', () => {
    const built = buildNoteDocument(source(), settings)
    expect(built.doc.path).toBe('Drinks/Latte art.md')
    expect(built.stored.folder).toBe('Drinks')
    expect(notePathOf(source({ folderPath: '' }))).toBe('Latte art.md')
  })

  it('separates headings by level and ignores fenced code', () => {
    const body = [
      '# One',
      '## Two',
      '### Three',
      '#### Four',
      '```',
      '# Not a heading',
      '```',
      '## Five',
      '',
      '~~~',
      '# Also not a heading',
      '~~~',
      '# Six',
    ].join('\n')
    const built = buildNoteDocument(source({ content: body }), settings)
    expect(built.doc.headings1).toBe('One Six')
    expect(built.doc.headings2).toBe('Two Five')
    expect(built.doc.headings3).toBe('Three')
    expect(built.doc.headings1).not.toContain('Not a heading')
  })

  it('collects aliases from both front matter spellings', () => {
    const list = buildNoteDocument(source({ content: '---\naliases: [Cino, Flat white]\n---\nbody' }), settings)
    expect(list.doc.aliases).toBe('Cino Flat white')
    const single = buildNoteDocument(source({ content: '---\nalias: Cino\n---\nbody' }), settings)
    expect(single.doc.aliases).toBe('Cino')
  })

  it('takes tags from the body and the front matter', () => {
    const built = buildNoteDocument(source({ content: '---\ntags: [coffee]\n---\nbody #latte' }), settings)
    expect(built.stored.tags).toEqual(expect.arrayContaining(['coffee', 'latte']))
  })

  it('uses a front matter property as the display title when configured', () => {
    const withTitle = documentSettings({ ...DEFAULT_SETTINGS.search, displayTitleProperty: 'title' })
    const built = buildNoteDocument(source({ content: '---\ntitle: The Milk Document\n---\nbody' }), withTitle)
    expect(built.doc.displayTitle).toBe('The Milk Document')
    const none = buildNoteDocument(source(), settings)
    expect(none.doc.displayTitle).toBe('')
  })

  it('falls back to the first heading when the reader asked for it', () => {
    const byHeading = documentSettings({ ...DEFAULT_SETTINGS.search, displayTitleProperty: '#heading' })
    const built = buildNoteDocument(source({ content: '# Real Heading\n\nbody' }), byHeading)
    expect(built.doc.displayTitle).toBe('Real Heading')
  })

  it('flags a body it had to cut and records the whole size', () => {
    const capped = documentSettings({ ...DEFAULT_SETTINGS.search, maxContentChars: 10 })
    const built = buildNoteDocument(source({ content: 'x'.repeat(40) }), capped)
    expect(built.body).toHaveLength(10)
    expect(built.stored.truncated).toBe(true)
    expect(built.stored.size).toBe(40)
  })

  it('keeps the excerpt short and plain', () => {
    const built = buildNoteDocument(source({ content: `# Title\n\n${'word '.repeat(200)}` }), settings)
    expect(built.stored.excerpt.length).toBeLessThanOrEqual(240)
    expect(built.stored.excerpt).not.toContain('#')
  })

  it('indexes Han titles so a Chinese note is reachable', () => {
    const built = buildNoteDocument(source({ title: HAN, content: `${HAN} body` }), settings)
    expect(built.doc.title).toBe(HAN)
    expect(built.doc.path).toBe(`Drinks/${HAN}.md`)
  })
})

describe('customPropertyValues', () => {
  it('reads a numeric property without throwing, which the reference did', () => {
    expect(() => customPropertyValues({ priority: 9 }, ['priority'])).not.toThrow()
    expect(customPropertyValues({ priority: 9 }, ['priority'])).toEqual(['9'])
  })

  it('flattens a list and caps how many values it keeps', () => {
    expect(customPropertyValues({ keywords: ['a', 'b', 'c'] }, ['keywords'])).toEqual(['a', 'b', 'c'])
    const many = customPropertyValues({ keywords: Array.from({ length: 40 }, (_unused, index) => `k${index}`) }, ['keywords'])
    expect(many.length).toBeLessThanOrEqual(32)
  })

  it('ignores objects and missing names', () => {
    expect(customPropertyValues({ meta: { a: 1 } }, ['meta', 'absent', ''])).toEqual([])
  })
})

describe('buildFileDocument', () => {
  it('names the attachment and its extension', () => {
    const built = buildFileDocument({ id: 'f1', filename: 'Shot.HEIC', noteId: 'n9', updatedAt: 5, size: 1200, mime: 'image/heic' })
    expect(built.doc.id).toBe('f:f1')
    expect(built.doc.ext).toBe('heic')
    expect(built.stored.noteId).toBe('n9')
    expect(built.stored.excerpt).toBe('image/heic')
  })

  it('holds nothing to tokenize for a file', () => {
    expect(buildFileDocument({ id: 'f1', filename: 'a.bin', noteId: null, updatedAt: 1, size: 1, mime: '' }).body).toBe('')
  })
})

describe('extensionOf', () => {
  it('reads the last dot and lowercases', () => {
    expect(extensionOf('a/b/Photo.PNG')).toBe('png')
    expect(extensionOf('no-extension')).toBe('')
    expect(extensionOf('tar.gz')).toBe('gz')
  })
})
