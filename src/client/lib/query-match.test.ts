import { describe, expect, it } from 'vitest'
import { compileQuery, queryMatches } from './query-match'

const hit = (source: string, text: string): number[] => {
  const match = queryMatches(compileQuery(source), text)
  return match ? match.ranges.flat() : []
}

describe('the plain half of a filter query', () => {
  it('treats anything without slashes as letters to find, not as an expression', () => {
    const query = compileQuery('work')
    expect(query.mode).toBe('fuzzy')
    expect(query.error).toBeNull()
    expect(hit('work', 'Work log')).toEqual([0, 4])
  })

  it('leaves a path that merely ends in a slash to the fuzzy matcher', () => {
    expect(compileQuery('notes/2024').mode).toBe('fuzzy')
    expect(compileQuery('/api').mode).toBe('fuzzy')
  })

  it('answers every row, in order, when there is nothing to filter by', () => {
    const empty = compileQuery('   ')
    expect(empty.text).toBe('')
    expect(queryMatches(empty, 'Anything')).toEqual({ score: 0, ranges: [] })
  })

  it('leaves the whole label to the fuzzy matcher, cap or not', () => {
    const long = `${'x'.repeat(400)}tail`
    expect(queryMatches(compileQuery('tail'), long)).not.toBeNull()
    expect(queryMatches(compileQuery('/tail/'), long)).toBeNull()
  })

  it('keeps the reading of a Chinese label available', () => {
    // The dictionary is lazy in the browser; here the literal is what a reader can type without it.
    expect(hit('\u5168\u9009', '\u5168\u9009\u5168\u90e8')).toEqual([0, 2])
  })
})

describe('the expression half of a filter query', () => {
  it('compiles /body/ and reports where it landed', () => {
    const query = compileQuery('/meet/')
    expect(query.mode).toBe('regex')
    expect(query.error).toBeNull()
    expect(hit('/meet/', 'Weekly meeting')).toEqual([7, 11])
  })

  it('ignores case unless the reader asks not to', () => {
    expect(hit('/MEET/', 'Weekly meeting')).toEqual([7, 11])
    expect(hit('/MEET/i', 'Weekly meeting')).toEqual([7, 11])
  })

  it('underlines every place the expression lands', () => {
    expect(hit('/ee/', 'weekly meeting')).toEqual([1, 3, 8, 10])
  })

  it('keeps anchors and groups usable', () => {
    expect(hit('/^work$/', 'Work')).toEqual([0, 4])
    expect(hit('/(deep|weekly) research/', 'Deep Research')).toEqual([0, 13])
  })

  it('says so when the expression does not compile', () => {
    for (const source of ['/unbalanced(/', '/[a-/', '/(*)/']) {
      const query = compileQuery(source)
      expect(query.mode, source).toBe('regex')
      expect(query.error, source).toBe('syntax')
      expect(queryMatches(query, 'anything'), source).toBeNull()
    }
  })

  it('answers a zero-width expression without underlining the whole row', () => {
    expect(hit('^', 'Anything')).toEqual([])
  })
})

describe('the guard on expressions that would never finish', () => {
  const refused = [
    '/(a+)+/',
    '/(a*)*b/',
    '/(a|aa)+/',
    '/(a?b?)+/',
    '/(a{1,4})*/',
    '/((x+)y)+/',
    '/(?:\\w+|\\w)+$/',
  ]
  for (const source of refused)
    it(`refuses ${source}`, () => {
      expect(compileQuery(source).error).toBe('unsafe')
    })

  const allowed = [
    '/(a|b)+/',
    '/\\d{4}-\\d{2}/',
    '/^(todo|done):/i',
    '/(foo|bar)\\s*\\d{1,2}/',
    '/[+*]+/',
    '/(a{2}){2}/',
    '/^(?!x).*$/i',
    '/x?y?z/',
  ]
  for (const source of allowed)
    it(`accepts ${source}`, () => {
      expect(compileQuery(source).error, source).toBeNull()
    })

  it('refuses an expression longer than a name can be', () => {
    expect(compileQuery('/' + 'a'.repeat(200) + '/').error).toBe('unsafe')
  })

  it('measures the guard against a string the engine would not survive', () => {
    const haystack = 'a'.repeat(30) + 'b'
    const compiled = compileQuery('/(a+)+b/')
    expect(compiled.error).toBe('unsafe')
    // The same shape, run for real, is the thing the guard is for: it is unbounded, not merely slow.
    expect(() => /(?:a+)+b/.test(haystack.slice(0, 22))).not.toThrow()
  })

  it('caps what it hands the engine, so one long field cannot decide the cost', () => {
    const long = `${'x'.repeat(400)}tail`
    expect(queryMatches(compileQuery('/tail/'), long)).toBeNull()
    expect(queryMatches(compileQuery('/x{11}/'), long)).not.toBeNull()
  })
})
