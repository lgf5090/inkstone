// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseOpdsFeed } from '../src/client/features/reading/engine/opds'

const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Public books</title>
  <link rel="alternate" href="/new" type="application/atom+xml" title="New arrivals" />
  <entry>
    <title>A Book</title>
    <link rel="http://opds-spec.org/acquisition" href="books/a.epub" type="application/epub+zip" />
    <link rel="http://opds-spec.org/acquisition" href="books/a.pdf" type="application/pdf" />
    <link rel="http://opds-spec.org/acquisition" href="books/a.exe" type="application/octet-stream" />
  </entry>
  <entry><title>No acquisition</title></entry>
</feed>`

describe('OPDS feeds', () => {
  it('keeps supported acquisitions and resolves links against the catalog', () => {
    const parsed = parseOpdsFeed(feed, 'https://catalog.example/opds/')
    expect(parsed.title).toBe('Public books')
    expect(parsed.entries).toEqual([
      { title: 'A Book', url: 'https://catalog.example/opds/books/a.epub', type: 'application/epub+zip' },
      { title: 'A Book', url: 'https://catalog.example/opds/books/a.pdf', type: 'application/pdf' },
    ])
    expect(parsed.navigation).toEqual([
      { title: 'New arrivals', url: 'https://catalog.example/new', type: 'application/atom+xml' },
    ])
  })

  it('rejects malformed XML', () => {
    expect(() => parseOpdsFeed('<feed>', 'https://catalog.example/')).toThrow('Invalid OPDS feed')
  })
})
