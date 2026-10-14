// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { bookLink, planReadingNote, NOTE_BEGIN, NOTE_END, refreshReadingProperties, renderReadingSection, spliceNote } from '../src/client/features/reading/reading-note'
import { useLibrary } from '../src/client/features/reading/store/library'
import { comparePositions, decodePosition, encodePosition, fractionOfPosition, parsePositionInput, positionFromFraction } from '../src/client/features/reading/position'
import { initI18n } from '../src/client/lib/i18n'
import type { BookRecord, Highlight } from '../src/client/features/reading/types'

const book: BookRecord = {
  id: 'book-1', format: 'epub', title: '测试书', author: '某作者', language: 'zh-CN', publisher: '',
  filename: 'a.epub', size: 10, addedAt: 1, unitCount: 3, coverPath: null, toc: [],
}

function mark(over: Partial<Highlight> = {}): Highlight {
  return {
    id: 'h1', bookId: 'book-1', chapter: 0, start: 4, end: 10, color: 'yellow',
    quote: '一句被划线的话', prefix: '', suffix: '', comment: '', createdAt: 1, updatedAt: 1, ...over,
  }
}

describe('a note that keeps the marks in colour', () => {
  it('wraps each quote in a data attribute the note renderer cannot strip', () => {
    const section = renderReadingSection(book, [mark({ color: 'green' }), mark({ id: 'h2', start: 12, end: 18, color: 'pink', quote: '另一句' })], 0.4, {
      backlinks: false, colors: true,
    })
    expect(section).toContain('<mark data-hl="green">一句被划线的话</mark>')
    expect(section).toContain('<mark data-hl="pink">另一句</mark>')
  })

  it('leaves the quote bare when the reader turned colours off', () => {
    const section = renderReadingSection(book, [mark()], 0, { backlinks: false, colors: false })
    expect(section).not.toContain('data-hl')
    expect(section).toContain('> 一句被划线的话')
  })

  it('survives the note renderer, which is the whole point of the data attribute', async () => {
    const { renderMarkdown } = await import('../src/client/lib/markdown/renderer')
    const section = renderReadingSection(book, [mark({ color: 'blue' })], 0, { backlinks: false, colors: true })
    const body = [NOTE_BEGIN, section, NOTE_END].join('\n')
    const { html } = renderMarkdown(body, {})
    expect(html).toContain('data-hl="blue"')
    expect(html).toContain('<mark')
    // An inline style would have been the obvious encoding, and this renderer forbids it.
    expect(html).not.toMatch(/style="[^"]*background/)
  })
})

describe('the position codec', () => {
  it('round-trips both kinds', () => {
    expect(decodePosition(encodePosition({ kind: 'epub', chapter: 3, offset: 41 }))).toEqual({ kind: 'epub', chapter: 3, offset: 41 })
    expect(decodePosition(encodePosition({ kind: 'fixed', page: 12 }))).toEqual({ kind: 'fixed', page: 12 })
  })

  it('refuses anything malformed rather than guessing', () => {
    for (const raw of ['', 'e:1', 'e:x:2', 'f:0', 'f:-3', 'nonsense', 'e:1:2:3']) {
      expect(decodePosition(raw), raw).toBeNull()
    }
  })

  it('orders positions inside one chapter and across chapters', () => {
    expect(comparePositions({ kind: 'epub', chapter: 1, offset: 5 }, { kind: 'epub', chapter: 1, offset: 9 })).toBeLessThan(0)
    expect(comparePositions({ kind: 'epub', chapter: 2, offset: 0 }, { kind: 'epub', chapter: 1, offset: 999 })).toBeGreaterThan(0)
  })

  it('reads what a typer writes: a percentage, a number, or a raw position', () => {
    const model = { kind: 'epub' as const, total: 4, weights: [100, 100, 100, 100] }
    expect(parsePositionInput('0%', model)).toEqual({ kind: 'epub', chapter: 0, offset: 0 })
    // Halfway through four equal chapters is the end of the second one, which is the same place as the
    // start of the third; the walk stops on the chapter whose span it lands inside.
    expect(parsePositionInput('50%', model)).toEqual({ kind: 'epub', chapter: 1, offset: 100 })
    expect(parsePositionInput('100%', model)).toEqual({ kind: 'epub', chapter: 3, offset: 100 })
    expect(parsePositionInput('e:2:15', model)).toEqual({ kind: 'epub', chapter: 2, offset: 15 })
    expect(parsePositionInput('3', model)).toEqual({ kind: 'epub', chapter: 1, offset: 100 })
    expect(parsePositionInput('9', model)).toBeNull()
    expect(parsePositionInput('abc', model)).toBeNull()
  })

  it('spreads a percentage over chapters of different lengths', () => {
    const model = { kind: 'epub' as const, total: 2, weights: [1000, 10] }
    const halfway = positionFromFraction(0.5, model)
    expect(halfway?.kind === 'epub' && halfway.chapter).toBe(0)
    expect(halfway?.kind === 'epub' && halfway.offset).toBe(505)
  })

  it('keeps a fraction inside the book', () => {
    const model = { kind: 'epub' as const, total: 2, weights: [10, 10] }
    expect(fractionOfPosition({ kind: 'epub', chapter: 0, offset: 5 }, model, 5)).toBeCloseTo(0.25)
    expect(fractionOfPosition({ kind: 'epub', chapter: 1, offset: 20 }, model, 999)).toBe(1)
  })
})

describe('the reading note', () => {
  it('links a book at one place and at another', () => {
    expect(bookLink('b/1')).toBe('/reading/b%2F1')
    expect(bookLink('b1', { kind: 'epub', chapter: 2, offset: 30 })).toBe('/reading/b1?p=e%3A2%3A30')
  })

  it('writes the marks grouped by chapter, with a way back', async () => {
    await initI18n()
    const section = renderReadingSection(book, [
      mark({ id: 'a', chapter: 1, quote: '第二章的一句' }),
      mark({ id: 'b', chapter: 0, quote: '第一章的一句' }),
    ], 0.4, { backlinks: true, colors: false, chapterTitles: new Map([[0, '开篇'], [1, '次章']]) })
    expect(section.indexOf('开篇')).toBeLessThan(section.indexOf('次章'))
    expect(section).toContain('> 第一章的一句 [↩](/reading/book-1?p=e%3A0%3A4)')
    expect(section).toContain('第二章的一句')
  })

  it('leaves the backlink off when the reader turned it off', async () => {
    await initI18n()
    const section = renderReadingSection(book, [mark()], 0, { backlinks: false, colors: false })
    expect(section).not.toContain('↩')
    expect(section).toContain('> 一句被划线的话')
  })

  it('keeps a comment with the passage it belongs to', async () => {
    await initI18n()
    const section = renderReadingSection(book, [mark({ comment: '这里要重读' })], 0, { backlinks: false, colors: false })
    expect(section).toContain('> 一句被划线的话\n>\n> 这里要重读')
  })

  it('replaces only its own part of a note the reader has written in', async () => {
    await initI18n()
    const section = renderReadingSection(book, [mark()], 0, { backlinks: false, colors: false })
    const existing = `---\nbook: "测试书"\n---\n\n我自己的序言。\n\n${NOTE_BEGIN}\n\n旧的划线\n${NOTE_END}\n\n我的后记。\n`
    const next = spliceNote(existing, section)
    expect(next).toContain('我自己的序言。')
    expect(next).toContain('我的后记。')
    expect(next).toContain('一句被划线的话')
    expect(next).not.toContain('旧的划线')
    expect(next.match(new RegExp(NOTE_BEGIN, 'g'))).toHaveLength(1)
    expect(next.match(new RegExp(NOTE_END, 'g'))).toHaveLength(1)
  })

  it('appends its block to a note that has no markers yet', async () => {
    await initI18n()
    const section = renderReadingSection(book, [], 0, { backlinks: false, colors: false })
    const next = spliceNote('# 我的想法\n\n先写着的东西。', section)
    expect(next.startsWith('# 我的想法')).toBe(true)
    expect(next).toContain('先写着的东西。')
    expect(next.indexOf(NOTE_BEGIN)).toBeGreaterThan(next.indexOf('先写着的东西。'))
    expect(next).toContain(NOTE_END)
  })

  it('keeps a quoted passage from breaking into separate paragraphs', async () => {
    await initI18n()
    const section = renderReadingSection(book, [mark({ quote: '第一行\n\n第二行' })], 0, { backlinks: false, colors: false })
    expect(section).toContain('> 第一行\n> 第二行')
    expect(section).not.toContain('> 第一行\n\n')
  })
})

describe('what the note says about the book', () => {
  const body = [
    '---',
    'book: "道德经样书"',
    'reading-progress: 0%',
    'highlights: 2',
    'type: reading-note',
    '---',
    '',
    '我自己写的一段，不该被动。',
    '',
    NOTE_BEGIN,
    '',
    '> 0 条划线 · 74%',
    '',
    NOTE_END,
  ].join('\n')

  it('brings both numbers up to date with the body', () => {
    const next = refreshReadingProperties(body, 9, 0.74)
    expect(next).toContain('highlights: 9')
    expect(next).toContain('reading-progress: 74%')
    expect(next).toContain('我自己写的一段，不该被动。')
    expect(next).toContain('book: "道德经样书"')
  })

  it('keeps the count a number, which is what the properties panel sorts and colours by', () => {
    const next = refreshReadingProperties(body, 12, 0.5)
    expect(next).toMatch(/^highlights: 12$/m)
    expect(next).not.toContain('highlights: "12"')
  })

  it('does not resurrect a property the reader deleted', () => {
    const trimmed = body.split('\n').filter((line) => !line.startsWith('highlights:')).join('\n')
    const next = refreshReadingProperties(trimmed, 4, 0.2)
    expect(next).not.toMatch(/^highlights:/m)
    expect(next).toContain('reading-progress: 20%')
  })

  it('says nothing when there is no front matter to write into', () => {
    const plain = `${NOTE_BEGIN}\n\n> 0 条划线\n\n${NOTE_END}`
    expect(refreshReadingProperties(plain, 3, 0.3)).toBe(plain)
  })
})

describe('which note a book owns', () => {
  const baseTitle = '《道德经》阅读笔记'
  const notes = {
    n1: { id: 'n1', title: baseTitle, deletedAt: null },
    n2: { id: 'n2', title: '《道德经》阅读笔记 (epub)', deletedAt: null },
    gone: { id: 'gone', title: '《道德经》阅读笔记 (pdf)', deletedAt: 123 },
  }
  const plan = (over: Partial<Parameters<typeof planReadingNote>[0]>) => planReadingNote({ book, existingNoteId: undefined, notes, byBook: {}, baseTitle, ...over })
  const two = { ...book, id: 'book-2' }

  it('takes the free note with a matching title', () => {
    expect(plan({})).toEqual({ title: baseTitle, noteId: 'n1' })
  })

  it('will not write another book\'s note, even when its own link says so', () => {
    const shared = { book, existingNoteId: 'n1', byBook: { 'book-2': 'n1' } }
    expect(plan(shared).noteId).not.toBe('n1')
    // ...and the owner still uses it.
    expect(plan({ book: two, byBook: { 'book-2': 'n1' } })).toEqual({ title: baseTitle, noteId: 'n1' })
  })

  it('keeps the link when this book is the only claimant', () => {
    expect(plan({ book, existingNoteId: 'n1', byBook: { 'book-1': 'n1' } })).toEqual({ title: baseTitle, noteId: 'n1' })
  })

  it('ignores a note in the trash', () => {
    const trashed = { n1: { id: 'n1', title: baseTitle, deletedAt: 7 } }
    expect(plan({ notes: trashed }).noteId).toBeNull()
  })

  it('names a new note so two editions can be told apart', () => {
    const taken = {
      n1: { id: 'n1', title: baseTitle, deletedAt: null },
      n2: { id: 'n2', title: '《道德经》阅读笔记 (epub)', deletedAt: null },
    }
    const answer = planReadingNote({ book, existingNoteId: undefined, notes: taken, byBook: { 'book-2': 'n1' }, baseTitle })
    expect(answer.noteId).toBeNull()
    expect(answer.title).toBe('《道德经》阅读笔记 (ok-1)')
  })

  it('reuses the freed title of a note the reader deleted', () => {
    const answer = plan({ notes: { ...notes, n1: { id: 'n1', title: baseTitle, deletedAt: 1 } } })
    expect(answer).toEqual({ title: baseTitle, noteId: null })
  })
})
