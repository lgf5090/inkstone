import { describe, expect, it } from 'vitest'
import { normalizeForSearch } from '../src/client/features/reading/engine/book-search'

describe('reading search normalization', () => {
  it('matches full-width ASCII and compatibility characters', () => {
    expect(normalizeForSearch('ＡＢＣ　１２３')).toBe(normalizeForSearch('abc 123'))
    expect(normalizeForSearch('ﬁle')).toBe('file')
  })
})
