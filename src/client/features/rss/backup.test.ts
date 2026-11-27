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
    expect(parseRssLibraryBackup(exportRssLibraryBackup(library))).toEqual(library)
  })

  it('rejects another format, a wrong version and a library that would be trimmed', () => {
    expect(parseRssLibraryBackup('{}')).toBeNull()
    expect(parseRssLibraryBackup(JSON.stringify({ type: 'inkstone-rss-library', version: 2, library: emptyLibrary() }))).toBeNull()
    const library = { ...emptyLibrary(), readIds: Array.from({ length: 5001 }, (_, index) => `e${index}`) }
    expect(parseRssLibraryBackup(JSON.stringify({ type: 'inkstone-rss-library', version: 1, library }))).toBeNull()
    expect(parseRssLibraryBackup('not json')).toBeNull()
  })
})
