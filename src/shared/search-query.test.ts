import { describe, expect, it } from 'vitest'
import { emptyParsedQuery, parseQuery } from './search-query'

describe('the search expression grammar', () => {
  it('collects tag: terms and strips the hash', () => {
    expect(parseQuery('tag:work').tags).toEqual(['work'])
    expect(parseQuery('tag:#work').tags).toEqual(['work'])
    expect(parseQuery('tag:"work meeting"').tags).toEqual(['work meeting'])
    expect(parseQuery('TAG:work').tags).toEqual(['work'])
    expect(parseQuery('tag:work tag:job').tags).toEqual(['work', 'job'])
  })

  it('keeps a leading dash as an exclusion', () => {
    const parsed = parseQuery('-tag:work')
    expect(parsed.tags).toEqual([])
    expect(parsed.excludedTags).toEqual(['work'])
    expect(parseQuery('alpha -tag:#work/meeting beta').excludedTags).toEqual(['work/meeting'])
    expect(parseQuery('-tag:"work meeting"').excludedTags).toEqual(['work meeting'])
  })

  it('never mixes an exclusion into the free text', () => {
    const parsed = parseQuery('recipe -tag:draft')
    expect(parsed.terms).toEqual(['recipe'])
    expect(parsed.text).toBe('recipe')
  })

  it('dedupes by the tag key and caps the list', () => {
    expect(parseQuery('tag:Work tag:work tag:\uFF37\uFF2F\uFF32\uFF2B').tags).toEqual(['Work'])
    expect(parseQuery(Array.from({ length: 20 }, (_unused, index) => `tag:t${index}`).join(' ')).tags).toHaveLength(8)
  })

  it('still reads the other qualifiers', () => {
    expect(parseQuery('folder:Inbox is:starred').folder).toBe('Inbox')
    expect(parseQuery('is:unarchived').archived).toBe(false)
    expect(parseQuery('in:trash').trash).toBe(true)
    expect(parseQuery('-folder:Inbox').folder).toBeNull()
    expect(parseQuery('-folder:Inbox').terms).toEqual(['-folder:Inbox'])
  })

  it('reports an empty query shape', () => {
    expect(emptyParsedQuery()).toEqual({
      text: '',
      terms: [],
      tags: [],
      excludedTags: [],
      folder: null,
      starred: null,
      archived: null,
      trash: false,
    })
  })
})
