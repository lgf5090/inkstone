import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROPERTY_NAMES,
  bannerPositionPercent,
  coverPositionOrNull,
  coverShapeOrNull,
  parsePropertyIcon,
  parsePropertyImage,
  readNoteDecorations,
} from './property-decorations'

describe('parsePropertyImage', () => {
  it('reads a wikilink as an attachment name, folder included', () => {
    expect(parsePropertyImage('![[Cover.png]]')).toEqual({ source: { kind: 'attachment', name: 'Cover.png' }, alt: '' })
    expect(parsePropertyImage('[[Covers/Book one]]')).toEqual({ source: { kind: 'attachment', name: 'Book one' }, alt: '' })
    expect(parsePropertyImage('![[Cover.png|the front]]')).toEqual({
      source: { kind: 'attachment', name: 'Cover.png' },
      alt: 'the front',
    })
  })

  it('reads a markdown link by whichever target it points at', () => {
    expect(parsePropertyImage('![alt](Covers/Book.png)')).toEqual({
      source: { kind: 'attachment', name: 'Book.png' },
      alt: 'alt',
    })
    expect(parsePropertyImage('![alt](https://example.com/a.png)')).toEqual({
      source: { kind: 'url', url: 'https://example.com/a.png' },
      alt: 'alt',
    })
  })

  it('reads a bare path and a bare url', () => {
    expect(parsePropertyImage('Covers/Book.png')).toEqual({ source: { kind: 'attachment', name: 'Book.png' }, alt: '' })
    expect(parsePropertyImage('https://example.com/a.jpg')).toEqual({
      source: { kind: 'url', url: 'https://example.com/a.jpg' },
      alt: '',
    })
  })

  it('turns a video link into its thumbnail', () => {
    expect(parsePropertyImage('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.source).toEqual({
      kind: 'url',
      url: 'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    })
    expect(parsePropertyImage('https://youtu.be/dQw4w9WgXcQ')?.source).toEqual({
      kind: 'url',
      url: 'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    })
  })

  it('keeps a base64 image but not a script-bearing one', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    expect(parsePropertyImage(png)?.source).toEqual({ kind: 'url', url: png })
    expect(parsePropertyImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBe(null)
    expect(parsePropertyImage('data:text/html;base64,PHNjcmlwdD4=')).toBe(null)
  })

  it('refuses anything that could reach a script or a local file', () => {
    expect(parsePropertyImage('javascript:alert(1)')).toBe(null)
    expect(parsePropertyImage('![x](javascript:alert(1))')).toBe(null)
    expect(parsePropertyImage('file:///etc/passwd.png')).toBe(null)
    expect(parsePropertyImage('https://user:pw@example.com/a.png')).toBe(null)
    expect(parsePropertyImage('http://example.com/a.png onerror=alert(1)')).toBe(null)
    expect(parsePropertyImage(`https://example.com/${'a'.repeat(2100)}.png`)).toBe(null)
    expect(parsePropertyImage('just some text')).toBe(null)
    expect(parsePropertyImage('')).toBe(null)
    expect(parsePropertyImage(7)).toBe(null)
  })
})

describe('cover and banner option readers', () => {
  it('accepts only the shapes and positions the panel can draw', () => {
    expect(coverShapeOrNull('vertical-cover')).toBe('vertical-cover')
    expect(coverShapeOrNull(' SQUARE ')).toBe('square')
    expect(coverShapeOrNull('triangle')).toBe(null)
    expect(coverPositionOrNull('right')).toBe('right')
    expect(coverPositionOrNull('middle')).toBe(null)
  })

  it('clamps a banner crop to the visible range', () => {
    expect(bannerPositionPercent(25)).toBe(25)
    expect(bannerPositionPercent('50%')).toBe(50)
    expect(bannerPositionPercent(-30)).toBe(0)
    expect(bannerPositionPercent(400)).toBe(100)
    expect(bannerPositionPercent('up')).toBe(null)
  })
})

describe('parsePropertyIcon', () => {
  it('prefers an image and falls back to the text the author wrote', () => {
    expect(parsePropertyIcon('![[face.png]]')).toEqual({
      kind: 'image',
      image: { source: { kind: 'attachment', name: 'face.png' }, alt: '' },
    })
    expect(parsePropertyIcon('\u{1F385}')).toEqual({ kind: 'glyph', text: '\u{1F385}' })
    expect(parsePropertyIcon('  spaced  ')).toEqual({ kind: 'glyph', text: 'spaced' })
    expect(parsePropertyIcon('x'.repeat(80))).toEqual({ kind: 'glyph', text: 'x'.repeat(32) })
    expect(parsePropertyIcon('')).toBe(null)
  })
})

describe('readNoteDecorations', () => {
  const data = {
    cover: '[[Covers/One.png]]',
    second: '[[Covers/Two.png]]',
    cover_shape: 'circle',
    cover_position: 'right',
    banner: 'https://example.com/b.png',
    banner_position: 30,
    icon: '\u{1F516}',
  }

  it('takes the first cover property the note actually carries', () => {
    const read = readNoteDecorations(data, { ...DEFAULT_PROPERTY_NAMES, cover: ['missing', 'second', 'cover'] }, {
      coverShape: 'square',
      coverPosition: 'left',
      bannerPosition: 50,
    })
    expect(read.cover?.image.source).toEqual({ kind: 'attachment', name: 'Two.png' })
    expect(read.cover?.property).toBe('second')
  })

  it('reads the shape and position off the note and falls back to the defaults', () => {
    const read = readNoteDecorations(data, DEFAULT_PROPERTY_NAMES, {
      coverShape: 'square',
      coverPosition: 'left',
      bannerPosition: 50,
    })
    expect(read.cover?.shape).toBe('circle')
    expect(read.cover?.position).toBe('right')
    expect(read.banner?.positionPercent).toBe(30)
    expect(read.icon?.icon).toEqual({ kind: 'glyph', text: '\u{1F516}' })

    const bare = readNoteDecorations({ cover: '[[C.png]]' }, DEFAULT_PROPERTY_NAMES, {
      coverShape: 'square',
      coverPosition: 'left',
      bannerPosition: 50,
    })
    expect(bare.cover?.shape).toBe('square')
    expect(bare.cover?.position).toBe('left')
    expect(bare.banner).toBe(null)
    expect(bare.icon).toBe(null)
  })

  it('answers null when the decoration properties name nothing usable', () => {
    const read = readNoteDecorations({ cover: 'not an image', banner: 'nope', icon: '   ' }, DEFAULT_PROPERTY_NAMES, {
      coverShape: 'initial',
      coverPosition: 'top',
      bannerPosition: 50,
    })
    expect(read).toEqual({ cover: null, banner: null, icon: null })
  })

  it('walks a dotted path without ever reaching the prototype', () => {
    const nested = readNoteDecorations({ obsidian: { icon: '\u{1F385}' } }, { ...DEFAULT_PROPERTY_NAMES, icon: 'obsidian.icon' }, {
      coverShape: 'initial',
      coverPosition: 'top',
      bannerPosition: 50,
    })
    expect(nested.icon?.icon).toEqual({ kind: 'glyph', text: '\u{1F385}' })
    const hostile = readNoteDecorations({}, { ...DEFAULT_PROPERTY_NAMES, icon: 'constructor.prototype' }, {
      coverShape: 'initial',
      coverPosition: 'top',
      bannerPosition: 50,
    })
    expect(hostile.icon).toBe(null)
  })
})
