// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { bookLink, NOTE_BEGIN, NOTE_END, renderReadingSection, spliceNote } from '../src/client/features/reading/reading-note'
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
    ], 0.4, { backlinks: true, chapterTitles: new Map([[0, '开篇'], [1, '次章']]) })
    expect(section.indexOf('开篇')).toBeLessThan(section.indexOf('次章'))
    expect(section).toContain('> 第一章的一句 [↩](/reading/book-1?p=e%3A0%3A4)')
    expect(section).toContain('第二章的一句')
  })

  it('leaves the backlink off when the reader turned it off', async () => {
    await initI18n()
    const section = renderReadingSection(book, [mark()], 0, { backlinks: false })
    expect(section).not.toContain('↩')
    expect(section).toContain('> 一句被划线的话')
  })

  it('keeps a comment with the passage it belongs to', async () => {
    await initI18n()
    const section = renderReadingSection(book, [mark({ comment: '这里要重读' })], 0, { backlinks: false })
    expect(section).toContain('> 一句被划线的话\n>\n> 这里要重读')
  })

  it('replaces only its own part of a note the reader has written in', async () => {
    await initI18n()
    const section = renderReadingSection(book, [mark()], 0, { backlinks: false })
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
    const section = renderReadingSection(book, [], 0, { backlinks: false })
    const next = spliceNote('# 我的想法\n\n先写着的东西。', section)
    expect(next.startsWith('# 我的想法')).toBe(true)
    expect(next).toContain('先写着的东西。')
    expect(next.indexOf(NOTE_BEGIN)).toBeGreaterThan(next.indexOf('先写着的东西。'))
    expect(next).toContain(NOTE_END)
  })

  it('keeps a quoted passage from breaking into separate paragraphs', async () => {
    await initI18n()
    const section = renderReadingSection(book, [mark({ quote: '第一行\n\n第二行' })], 0, { backlinks: false })
    expect(section).toContain('> 第一行\n> 第二行')
    expect(section).not.toContain('> 第一行\n\n')
  })
})
