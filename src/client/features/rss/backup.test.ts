import { describe, expect, it } from 'vitest'
import { emptyLibrary, newFeed, newGroup } from '@shared/rss/model'
import { exportRssLibraryBackup, parseRssLibraryBackup } from './backup'

describe('RSS library backup', () => {
  it('round-trips subscriptions, folders, tags and reading marks', () => {
    const library = emptyLibrary()
    const group = newGroup('g1', 'Work', 0)
    const feed = newFeed('f1', 'https://example.com/feed', 'Example', 0)
    feed.groupId = group.id
    feed.tags = ['tech']
    feed.readBefore = 100
    library.groups.push(group)
    library.feeds.push(feed)
    library.readIds = ['e1']
    library.favorites = ['e2']
    library.readLater = ['e3']
    library.hiddenIds = ['e4']
    library.opened = { e1: 10 }
    library.savedNotes = { 'e1|note': 'n1' }
    expect(parseRssLibraryBackup(exportRssLibraryBackup(library))?.library).toEqual(library)
  })

  it('carries article metadata and makes body export explicit', () => {
    const library = emptyLibrary()
    library.feeds.push(newFeed('f1', 'https://example.com/feed', 'Example', 0))
    const entry = { id: 'e1', feedId: 'f1', title: 'One', link: 'https://example.com/1', author: '', publishedTs: 1, summary: 'Summary', content: 'Body', imageUrl: '', audioUrl: '' }
    const metadata = parseRssLibraryBackup(exportRssLibraryBackup(library, [entry]))!
    expect(metadata.articles[0]).toMatchObject({ id: 'e1', summary: 'Summary', content: '' })
    expect(metadata.includesContent).toBe(false)
    const full = parseRssLibraryBackup(exportRssLibraryBackup(library, [entry], { includeContent: true }))!
    expect(full.articles[0]?.content).toBe('Body')
    expect(full.includesContent).toBe(true)
  })

  it('reads the original library-only version without inventing articles', () => {
    const value = { type: 'inkstone-rss-library', version: 1, exportedAt: new Date().toISOString(), library: emptyLibrary() }
    expect(parseRssLibraryBackup(JSON.stringify(value))).toMatchObject({ version: 1, articles: [], includesContent: false })
  })

  it('rejects another format, a wrong version and a library that would be trimmed', () => {
    expect(parseRssLibraryBackup('{}')).toBeNull()
    expect(parseRssLibraryBackup(JSON.stringify({ type: 'inkstone-rss-library', version: 2, library: emptyLibrary() }))).toBeNull()
    const library = { ...emptyLibrary(), readIds: Array.from({ length: 5001 }, (_, index) => `e${index}`) }
    expect(parseRssLibraryBackup(JSON.stringify({ type: 'inkstone-rss-library', version: 1, library }))).toBeNull()
    expect(parseRssLibraryBackup('not json')).toBeNull()
  })
})
