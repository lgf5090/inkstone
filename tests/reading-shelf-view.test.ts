// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  SHELF_VIEW_MODES,
  isShelfViewMode,
  resolveShelfView,
  type ResolvedShelfView,
} from '../src/client/features/reading/shelf-view'
import { stoppedAtLabel } from '../src/client/features/reading/position'

/**
 * Which layout the shelf actually draws.
 *
 * `adaptive` is the only mode with a condition in it, and a condition that lives inside a component is
 * invisible to every other surface — so it is stated here as a table a reader can check by eye.
 */
describe('the shelf layout a mode asks for', () => {
  it('takes the three named modes literally, on any width', () => {
    for (const mode of ['grid', 'list', 'covers'] as const) {
      expect(resolveShelfView(mode, false)).toBe(mode)
      expect(resolveShelfView(mode, true)).toBe(mode)
    }
  })

  it('falls back to the list only when adaptive has no room for a grid', () => {
    expect(resolveShelfView('adaptive', false)).toBe('grid')
    expect(resolveShelfView('adaptive', true)).toBe('list')
  })

  it('offers exactly the four modes the toolbar prints', () => {
    expect([...SHELF_VIEW_MODES].sort()).toEqual(['adaptive', 'covers', 'grid', 'list'])
    for (const mode of SHELF_VIEW_MODES) expect(isShelfViewMode(mode)).toBe(true)
  })

  it('refuses a stored value that is not a mode', () => {
    for (const junk of ['two-column', '', 'GRID', 'adaptive ', 7, null, undefined]) {
      expect(isShelfViewMode(junk)).toBe(false)
    }
  })

  it('resolves every mode to something the shelf can draw', () => {
    const drawable: ResolvedShelfView[] = ['grid', 'list', 'covers']
    for (const mode of SHELF_VIEW_MODES) {
      expect(drawable).toContain(resolveShelfView(mode, false))
      expect(drawable).toContain(resolveShelfView(mode, true))
    }
  })
})

/**
 * What a list row says about where the reader left off.
 *
 * The row has the book's cached contents and nothing else — no archive, no reparse — so the label is
 * read out of the table of contents, and a book whose contents do not name that chapter must say
 * nothing rather than invent a number.
 */
describe('where the reader stopped', () => {
  const toc = [
    { label: ' 第一章 道可道 ', position: { kind: 'epub' as const, chapter: 0, offset: 0 }, level: 0 },
    { label: '第二章', position: { kind: 'epub' as const, chapter: 1, offset: 0 }, level: 0 },
    { label: '无序', position: null, level: 0 },
  ]
  const book = { unitCount: 120, toc }

  it('names the chapter the position falls in, trimmed', () => {
    expect(stoppedAtLabel({ kind: 'epub', chapter: 0, offset: 40 }, book)).toBe('第一章 道可道')
    expect(stoppedAtLabel({ kind: 'epub', chapter: 1, offset: 0 }, book)).toBe('第二章')
  })

  it('counts a fixed-layout book by its page against its own extent', () => {
    expect(stoppedAtLabel({ kind: 'fixed', page: 7 }, book)).toBe('7 / 120')
    expect(stoppedAtLabel({ kind: 'fixed', page: 3 }, { ...book, unitCount: 0 })).toBe('3 / 1')
  })

  it('says nothing it cannot support', () => {
    expect(stoppedAtLabel(undefined, book)).toBe('')
    expect(stoppedAtLabel(null, book)).toBe('')
    expect(stoppedAtLabel({ kind: 'epub', chapter: 9, offset: 0 }, book)).toBe('')
    expect(stoppedAtLabel({ kind: 'epub', chapter: 0, offset: 0 }, { ...book, toc: [] })).toBe('')
  })
})
