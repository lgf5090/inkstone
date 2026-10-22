import { describe, expect, it } from 'vitest'
import { findMentionRanges } from './mentions'

describe('the mention scanner', () => {
  it('finds handles at a word boundary', () => {
    const text = 'Hi @alice and (@bob_c)!'
    const ranges = findMentionRanges(text)
    expect(ranges.map((range) => range.username)).toEqual(['alice', 'bob_c'])
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual(['@alice', '@bob_c'])
  })

  it('leaves addresses, links, short names and uppercase words alone', () => {
    const text = 'bob@example.com https://x.test/@alice @ab @Alice'
    expect(findMentionRanges(text)).toEqual([])
  })

  it('does not split a longer word after a handle', () => {
    expect(findMentionRanges('@aliceé')).toEqual([])
    expect(findMentionRanges('@alice.b')).toHaveLength(1)
  })
})
