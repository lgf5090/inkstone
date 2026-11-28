import { describe, expect, it } from 'vitest'
import { normalizeForSearch } from '../src/client/features/reading/engine/book-search'

describe('reading search normalization', () => {
  it('matches full-width ASCII and compatibility characters', () => {
    expect(normalizeForSearch('ＡＢＣ　１２３')).toBe(normalizeForSearch('abc 123'))
    expect(normalizeForSearch('ﬁle')).toBe('file')
  })

  it('matches simplified and traditional Chinese without changing offsets', () => {
    const simplified = '\u8bfb\u4e66\u4eba'
    const traditional = '\u8b80\u66f8\u4eba'
    expect(normalizeForSearch(simplified)).toBe(normalizeForSearch(traditional))
    expect(normalizeForSearch(traditional)).toHaveLength(traditional.length)
  })
})
