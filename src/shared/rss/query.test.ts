import { describe, expect, it } from 'vitest'
import type { RssEntry } from './model'
import { parseRssSearchQuery, rssEntryMatchesAdvancedQuery } from './query'

const entry: RssEntry = {
  id: 'e1', feedId: 'f1', title: 'A smaller model', link: 'https://example.test/1', author: 'Rae',
  publishedTs: Date.parse('2026-11-03T02:00:00Z'), summary: 'Half the size', content: 'Benchmarks are useful.',
  imageUrl: '', audioUrl: '',
}

describe('RSS advanced query syntax', () => {
  it('separates field, author, date and mark constraints from free text', () => {
    const query = parseRssSearchQuery('title:"smaller model" author:Rae after:2026-11-01 before:2026-11-04 is:unread model')
    expect(query).toEqual({ text: 'model', field: 'title', author: 'Rae', after: '2026-11-01', before: '2026-11-04', mark: 'unread', error: null })
    expect(rssEntryMatchesAdvancedQuery(entry, query, { read: new Set(), starred: new Set(), later: new Set() })).toBe(true)
  })

  it('refuses impossible dates and unknown mark names', () => {
    expect(parseRssSearchQuery('after:2026-02-30').error).toBe('date')
    expect(parseRssSearchQuery('after:2026-11-04 before:2026-11-01').error).toBe('date')
    expect(parseRssSearchQuery('is:everything').error).toBe('syntax')
    expect(parseRssSearchQuery('title:').error).toBe('syntax')
  })

  it('keeps ordinary fuzzy text untouched', () => {
    expect(parseRssSearchQuery('  smaller   model ')).toEqual({ text: 'smaller model', field: 'any', author: '', after: '', before: '', mark: null, error: null })
  })

  it('applies mark constraints to the supplied account marks', () => {
    const query = parseRssSearchQuery('is:starred')
    expect(rssEntryMatchesAdvancedQuery(entry, query, { read: new Set(), starred: new Set(['e1']), later: new Set() })).toBe(true)
    expect(rssEntryMatchesAdvancedQuery(entry, query, { read: new Set(), starred: new Set(), later: new Set() })).toBe(false)
  })
})
