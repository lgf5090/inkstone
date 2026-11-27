import { describe, expect, it } from 'vitest'
import { emptyLibrary, newFeed } from '@shared/rss/model'
import { sourceHealthRows } from './SourceHealth'

const feed = newFeed('f1', 'https://example.com/feed', 'Example', 0)

describe('source health rows', () => {
  it('uses the durable cache count without calling an unloaded feed unread', () => {
    const rows = sourceHealthRows({ ...emptyLibrary(), feeds: [feed] }, {}, { f1: { fetchedAt: 1, bytes: 10, count: 5 } })
    expect(rows[0]).toMatchObject({ cached: 5, opened: null, last: null })
  })

  it('counts opened articles only when the feed is loaded', () => {
    const rows = sourceHealthRows(
      { ...emptyLibrary(), feeds: [feed], opened: { e1: 10 } },
      { f1: [{ id: 'e1', feedId: 'f1', title: 'One', link: 'https://example.com/1', author: '', publishedTs: 1, summary: '', content: '', imageUrl: '', audioUrl: '' }] },
      {},
    )
    expect(rows[0]).toMatchObject({ cached: 1, opened: 1, last: 10 })
  })
})
