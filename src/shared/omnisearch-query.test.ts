import { describe, expect, it } from 'vitest'
import { excerptStringOf, isOmnisearchQueryEmpty, parseOmnisearchQuery } from './omnisearch-query'

const fold = (value: string) => value.toLowerCase()
const parse = (raw: string) => parseOmnisearchQuery(raw, fold)

describe('parseOmnisearchQuery', () => {
  it('keeps plain words as terms', () => {
    const query = parse('latte foam')
    expect(query.terms).toEqual(['latte', 'foam'])
    expect(query.text).toBe('latte foam')
  })

  it('keeps a quoted phrase as one term and as an exact filter', () => {
    const query = parse('"latte art" milk')
    expect(query.terms).toContain('latte art')
    expect(query.exact).toEqual(['latte art'])
    expect(excerptStringOf(query)).toBe('latte art')
  })

  it('keeps single-quoted phrases too', () => {
    expect(parse("'latte art'").exact).toEqual(['latte art'])
  })

  it('treats a leading dash as an exclusion', () => {
    const query = parse('alpha -draft -"work in progress"')
    expect(query.terms).toEqual(['alpha'])
    expect(query.excludeTerms).toEqual(['draft', 'work in progress'])
  })

  it('reads ext from the keyword and from a dotted word', () => {
    expect(parse('latte ext:png').ext).toEqual(['png'])
    expect(parse('latte .png').ext).toEqual(['png'])
    expect(parse('latte -.png').excludeExt).toEqual(['png'])
    expect(parse('latte .png').terms).toEqual(['latte'])
  })

  it('reads path fragments both ways', () => {
    expect(parse('path:drinks tea').path).toEqual(['drinks'])
    expect(parse('tea -path:archive').excludePath).toEqual(['archive'])
    expect(parse('path:"old notes"').path).toEqual(['old notes'])
  })

  it('separates a named tag from a tag the reader just likes', () => {
    const query = parse('tea tag:drinks #favourite')
    expect(query.tags).toEqual(['drinks'])
    expect(query.boostedTags).toEqual(['favourite'])
    expect(query.terms).toEqual(['tea'])
  })

  it('folds a tag name the way the tag lists do', () => {
    expect(parse('TAG:Drinks').tags).toEqual(['drinks'])
    expect(parse('#Drinks').boostedTags).toEqual(['drinks'])
  })

  it('keeps the folder qualifier on the subtree rule', () => {
    const query = parse('folder:Drinks tea')
    expect(query.folder).toBe('drinks')
    expect(query.terms).toEqual(['tea'])
  })

  it('understands the is and in qualifiers', () => {
    expect(parse('is:starred tea').starred).toBe(true)
    expect(parse('-is:starred tea').starred).toBe(false)
    expect(parse('is:archived').archived).toBe(true)
    expect(parse('is:unarchived').archived).toBe(false)
    expect(parse('in:trash').trash).toBe(true)
    expect(parse('is:trash').trash).toBe(true)
  })

  it('keeps an unknown qualifier as text rather than a filter', () => {
    expect(parse('status:open tea').terms).toEqual(['status:open', 'tea'])
  })

  it('folds every piece of the query', () => {
    const query = parse('CAFÉ Path:DRINKS')
    expect(query.terms).toEqual(['café'])
    expect(query.path).toEqual(['drinks'])
  })

  it('ignores an empty qualifier value', () => {
    // A half-typed qualifier has no value to filter on, so it searches as the literal.
    const query = parse('tea tag: path:')
    expect(query.terms).toEqual(['tea', 'tag:', 'path:'])
    expect(query.tags).toEqual([])
    expect(query.path).toEqual([])
  })

  it('caps how many terms one query can carry', () => {
    const query = parse(Array.from({ length: 40 }, (_unused, index) => `w${index}`).join(' '))
    expect(query.terms.length).toBeLessThanOrEqual(12)
  })

  it('caps the raw length so a paste cannot become a query', () => {
    expect(parse('a'.repeat(4000)).raw).toHaveLength(512)
  })

  it('does not let a crafted NUL forge a quoted span', () => {
    const nul = String.fromCharCode(0)
    const forged = ['latte', nul, '0', nul].join('')
    expect(parse(forged).terms).toEqual(['latte0'])
    expect(parse('a').terms).toEqual(['a'])
  })

  it('folds a dotted extension without case', () => {
    expect(parse('shot .PNG').ext).toEqual(['png'])
  })

  it('does not list the same word twice', () => {
    expect(parse('tea tea tag:hot tag:hot')).toMatchObject({ terms: ['tea'], tags: ['hot'] })
  })

  it('knows an exclusion-only query has nothing to look up', () => {
    expect(isOmnisearchQueryEmpty(parse(''))).toBe(true)
    expect(isOmnisearchQueryEmpty(parse('-draft'))).toBe(true)
    expect(isOmnisearchQueryEmpty(parse('tag:hot'))).toBe(false)
    expect(isOmnisearchQueryEmpty(parse('#hot'))).toBe(false)
    expect(isOmnisearchQueryEmpty(parse('in:trash'))).toBe(false)
  })

  it('gives the excerpt the longest phrase, or the text', () => {
    expect(excerptStringOf(parse('tea "short" "much longer phrase"'))).toBe('much longer phrase')
    expect(excerptStringOf(parse('tea latte'))).toBe('tea latte')
  })
})
