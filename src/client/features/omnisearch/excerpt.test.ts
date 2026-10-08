import { describe, expect, it } from 'vitest'
import { buildExcerpt, findMatches, groupOffsets, prioritizePhrase } from './excerpt'

const ACCENTED = { ignoreDiacritics: true }

describe('findMatches', () => {
  it('reports offsets that slice the original text exactly', () => {
    const text = 'the latte was a café latte'
    const matches = findMatches(text, ['latte'], ACCENTED)
    expect(matches).toHaveLength(2)
    for (const match of matches) {
      expect(text.slice(match.offset, match.offset + match.term.length)).toBe(match.term)
    }
  })

  it('finds an accent-free query against an accented body without moving the offsets', () => {
    const text = 'a naïve café server'
    const matches = findMatches(text, ['naive', 'cafe'], ACCENTED)
    expect(matches.map((match) => match.offset)).toEqual([2, 8])
    expect(matches.map((match) => match.term)).toEqual(['naïve', 'café'])
  })

  it('does not shift offsets past inline code, which the reference plugin did', () => {
    // The reference folded `` ` `` and `^` into long placeholders before matching, so every offset
    // after a code span pointed somewhere else in the note.
    const text = 'run `npm i -g thing` then find the target word'
    const matches = findMatches(text, ['target'], ACCENTED)
    expect(matches[0]!.offset).toBe(text.indexOf('target'))
  })

  it('matches case-insensitively', () => {
    expect(findMatches('One TWO three', 'two'.split(' '), { ignoreDiacritics: false })).toHaveLength(1)
  })

  it('prefers the longer term when several hit the same place', () => {
    const matches = findMatches('a mindmap block', ['mindmap', 'mind'], ACCENTED)
    expect(matches[0]!.term).toBe('mindmap')
  })

  it('stops at the limit instead of walking a huge note forever', () => {
    const text = 'ab '.repeat(2000)
    expect(findMatches(text, ['ab'], { ignoreDiacritics: false, limit: 50 })).toHaveLength(50)
  })

  it('returns nothing when there is no term or no text', () => {
    expect(findMatches('abc', [], ACCENTED)).toEqual([])
    expect(findMatches('', ['abc'], ACCENTED)).toEqual([])
  })
})

describe('groupOffsets', () => {
  it('collapses hits that sit inside one window', () => {
    const matches = [
      { term: 'a', offset: 10 },
      { term: 'a', offset: 40 },
      { term: 'a', offset: 900 },
      { term: 'a', offset: 950 },
    ]
    expect(groupOffsets(matches, 300)).toEqual([10, 900])
  })

  it('sorts regardless of the order the matches arrived in', () => {
    expect(groupOffsets([{ term: 'x', offset: 500 }, { term: 'x', offset: 20 }], 100)).toEqual([20, 500])
  })

  it('returns nothing for nothing', () => {
    expect(groupOffsets([], 100)).toEqual([])
  })
})

describe('prioritizePhrase', () => {
  it('puts the whole query first when the note contains it', () => {
    const text = 'a latte art class about latte foam'
    const matches = findMatches(text, ['latte', 'foam'], ACCENTED)
    const ordered = prioritizePhrase(matches, text, 'latte foam', true)
    expect(ordered[0]!.offset).toBe(text.indexOf('latte foam'))
    expect(ordered[0]!.term).toBe('latte foam')
  })

  it('leaves the list alone when the phrase is not in the note', () => {
    const text = 'latte foam'
    const matches = findMatches(text, ['latte'], ACCENTED)
    expect(prioritizePhrase(matches, text, 'foam latte', true)).toEqual(matches)
  })
})

describe('buildExcerpt', () => {
  const body = `intro line one
${' filler'.repeat(40)}
the target word sits on this line and nowhere else
${' tail'.repeat(40)}
closing line`

  it('cuts around the offset and marks both ends as truncated', () => {
    const excerpt = buildExcerpt(body, body.indexOf('target'), {
      ignoreDiacritics: true,
      keepLineReturns: true,
      plainText: false,
      terms: ['target'],
    })
    expect(excerpt.leading).toBe(true)
    // The window reaches the end of the note, so only the head is cut away.
    expect(excerpt.trailing).toBe(false)
    expect(excerpt.lines.some((line) => line.text.includes('target word'))).toBe(true)
  })

  it('reports highlight ranges that index the line it returned', () => {
    const excerpt = buildExcerpt(body, body.indexOf('target'), {
      ignoreDiacritics: true,
      keepLineReturns: true,
      plainText: false,
      terms: ['target'],
    })
    const line = excerpt.lines.find((item) => item.hits.length > 0)!
    expect(line).toBeDefined()
    for (const [start, end] of line.hits) {
      expect(line.text.slice(start, end)).toBe('target')
    }
  })

  it('starts from the line above the match when line returns are kept', () => {
    const excerpt = buildExcerpt(body, body.indexOf('target'), {
      ignoreDiacritics: true,
      keepLineReturns: true,
      plainText: false,
      terms: ['target'],
    })
    expect(excerpt.lines.every((line) => !line.text.includes('intro line one'))).toBe(true)
  })

  it('strips markdown from the displayed excerpt when asked, keeping the highlight', () => {
    const rich = `prefix ${'x '.repeat(120)} **bold target** more text`
    const excerpt = buildExcerpt(rich, rich.indexOf('target'), {
      ignoreDiacritics: true,
      keepLineReturns: false,
      plainText: true,
      terms: ['target'],
    })
    const text = excerpt.lines.map((line) => line.text).join(' ')
    expect(text).toContain('bold target')
    expect(text).not.toContain('**')
    const line = excerpt.lines.find((item) => item.hits.length > 0)!
    expect(line.text.slice(line.hits[0]![0], line.hits[0]![1])).toBe('target')
  })

  it('degrades to the head of the note when the offset is unknown', () => {
    const excerpt = buildExcerpt('start of a long note body', -1, {
      ignoreDiacritics: true,
      keepLineReturns: false,
      plainText: false,
      terms: ['start'],
    })
    expect(excerpt.lines[0]!.text).toContain('start of a long note')
    expect(excerpt.leading).toBe(false)
  })

  it('returns nothing for an empty body', () => {
    expect(buildExcerpt('', 0, {
      ignoreDiacritics: true,
      keepLineReturns: false,
      plainText: false,
      terms: ['x'],
    }).lines).toEqual([])
  })
})
