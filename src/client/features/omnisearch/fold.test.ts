import { describe, expect, it } from 'vitest'
import { escapeRegExp, foldForDisplay, foldTerm } from './fold'

describe('foldTerm', () => {
  it('lowercases and strips accents when the reader wants accent-insensitive search', () => {
    expect(foldTerm('Café', true)).toBe('cafe')
    expect(foldTerm('CAFE', true)).toBe('cafe')
    expect(foldTerm('Café', false)).toBe('café')
  })

  it('keeps markdown syntax that happens to be a diacritic class character', () => {
    // `^` and `` ` `` are Diacritic-class but they are keystrokes an author typed, not accents.
    expect(foldTerm('`code` ^ caret', true)).toBe('`code` ^ caret')
  })

  it('leaves Han and punctuation alone', () => {
    const han = String.fromCharCode(0x7814, 0x7a76)
    expect(foldTerm(han + ', 2024!', true)).toBe(han + ', 2024!')
  })
})

describe('foldForDisplay', () => {
  it('keeps every offset valid for the original text', () => {
    const text = 'a café and a naïve note'
    const folded = foldForDisplay(text, true)
    expect(folded.aligned).toBe(true)
    expect(folded.text).toHaveLength(text.length)
    expect(folded.text.indexOf('cafe')).toBe(text.indexOf('café'))
  })

  it('gives up on folding rather than lie about an offset', () => {
    // An `e` followed by a combining acute accent is two units that fold to one.
    const decomposed = 'cafe\u0301 note'
    const folded = foldForDisplay(decomposed, true)
    expect(folded.aligned).toBe(false)
    expect(folded.text).toBe(decomposed)
  })

  it('folds without lowering, because lowering is not width-preserving', () => {
    // U+0130 lowercases to two units; dropping its accent keeps one, which is what the fold does.
    const folded = foldForDisplay('\u0130stanbul', true)
    expect(folded.aligned).toBe(true)
    expect(folded.text).toBe('Istanbul')
    expect(folded.text).toHaveLength('\u0130'.length + 'stanbul'.length)
  })

  it('returns the text untouched when accents matter', () => {
    expect(foldForDisplay('Café', false)).toEqual({ text: 'Café', aligned: true })
  })
})

describe('escapeRegExp', () => {
  it('makes a note body safe to embed in a pattern', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c')
    expect(new RegExp(escapeRegExp('(x|y)+'), 'u').test('(x|y)+')).toBe(true)
  })
})
