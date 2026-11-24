import { describe, expect, it } from 'vitest'
import { emptyParsedQuery, matchesNoteDate, parseQuery, parseQueryBranches } from './search-query'

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

  it('parses created and updated date comparisons without losing invalid expressions', () => {
    const parsed = parseQuery('created:>=2026-01-01 updated:2026-02-03T04:05:06Z created:not-a-date')
    expect(parsed.created).toEqual({ operator: '>=', time: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 2) })
    expect(parsed.updated).toEqual({ operator: '=', time: Date.parse('2026-02-03T04:05:06Z') })
    expect(parsed.terms).toEqual(['created:not-a-date'])
    expect(parseQuery('created:2026-02-30').created).toBeNull()
    const day = parseQuery('updated:2026-01-01').updated!
    expect(matchesNoteDate(day.time, day)).toBe(true)
    expect(matchesNoteDate(day.end! - 1, day)).toBe(true)
    expect(matchesNoteDate(day.end!, day)).toBe(false)
  })

  it('parses property existence, equality and inequality', () => {
    const parsed = parseQuery('property:status property:"reading status=done" property:rating!=4 property:=broken')
    expect(parsed.properties).toEqual([
      { key: 'status', operator: 'exists' },
      { key: 'reading status', operator: '=', value: 'done' },
      { key: 'rating', operator: '!=', value: '4' },
    ])
    expect(parsed.terms).toEqual(['property:=broken'])
  })

  it('splits standalone OR operators while keeping quoted text intact', () => {
    const branches = parseQueryBranches('tag:work OR "floor OR ceiling" created:>=2026-01-01')
    expect(branches).toHaveLength(2)
    expect(branches[0]?.tags).toEqual(['work'])
    expect(branches[1]?.terms).toEqual(['floor OR ceiling'])
    expect(branches[1]?.created?.operator).toBe('>=')
    expect(parseQueryBranches('orange origin')).toHaveLength(1)
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
      created: null,
      updated: null,
      properties: [],
    })
  })
})
