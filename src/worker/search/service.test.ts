import { describe, expect, it } from 'vitest'
import { queryNeedsLikeFallback } from './service'

describe('queryNeedsLikeFallback', () => {
  it('recognises CJK prose, which unicode61 tokenises as one long run', () => {
    expect(queryNeedsLikeFallback(['行号'])).toBe(true)
    expect(queryNeedsLikeFallback(['段落与行号'])).toBe(true)
    expect(queryNeedsLikeFallback(['カタカナ'])).toBe(true)
    expect(queryNeedsLikeFallback(['漢字'])).toBe(true)
  })

  it('leaves space-separated languages to the index', () => {
    expect(queryNeedsLikeFallback(['line', 'numbers'])).toBe(false)
    expect(queryNeedsLikeFallback(['große'])).toBe(false)
    expect(queryNeedsLikeFallback([])).toBe(false)
  })
})
