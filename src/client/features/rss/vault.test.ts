/**
 * A note folder read as a subscription — the conversion, and the two ways it could lie.
 *
 * The rows must be the folder *and everything under it*, because that is what a folder means
 * everywhere else in the app; and a note in the trash or the archive must not appear, because the
 * channel offers no way out of either. The shapes are pinned too: no link, no body, the folder's own
 * id as the source, so nothing downstream mistakes a note for an article it can star or hide.
 */
import { describe, expect, it } from 'vitest'
import type { Folder, NoteSummary } from '@shared/types'
import { channelEntries, feedsForChannel } from '@shared/rss/reading'
import { emptyLibrary } from '@shared/rss/model'
import { isVaultEntry, vaultChannels, vaultEntries, vaultFeedId } from './vault'

const folders: Folder[] = [
  { id: 'a', parentId: null, name: 'Alpha', icon: null, color: null, noteCount: 0, createdAt: 1, updatedAt: 1, position: 0 },
  { id: 'b', parentId: 'a', name: 'Beta', icon: null, color: null, noteCount: 0, createdAt: 1, updatedAt: 1, position: 1 },
  { id: 'c', parentId: null, name: 'Gamma', icon: null, color: null, noteCount: 0, createdAt: 1, updatedAt: 1, position: 2 },
]

function note(id: string, folderId: string | null, over: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id, title: `Note ${id}`, excerpt: 'an excerpt', folderId, tags: [], isPinned: false, isStarred: false,
    isArchived: false, wordCount: 3, charCount: 12, rev: 1, position: 0, createdAt: 1, updatedAt: 100, deletedAt: null, ...over,
  }
}

const notes = [note('n-a', 'a'), note('n-b', 'b'), note('n-c', 'c'), note('n-root', null), note('n-gone', 'a', { deletedAt: 9 }), note('n-archived', 'a', { isArchived: true })]

describe('vaultEntries', () => {
  it('reads a folder and everything under it, newest first', () => {
    const rows = vaultEntries(notes, folders, 'a')
    expect(rows.map(row => row.id)).toEqual(['n-a', 'n-b'])
  })

  it('leaves the trash and the archive out', () => {
    const ids = vaultEntries(notes, folders, 'a').map(row => row.id)
    expect(ids).not.toContain('n-gone')
    expect(ids).not.toContain('n-archived')
  })

  it('is empty for a folder with nothing in it', () => {
    expect(vaultEntries(notes, folders, 'empty')).toEqual([])
  })

  it('carries the folder as its source and no article shape at all', () => {
    const row = vaultEntries(notes, folders, 'a')[0]
    expect(row.feedId).toBe(vaultFeedId('a'))
    expect(row.link).toBe('')
    expect(row.content).toBe('')
    expect(row.publishedTs).toBe(100)
    expect(row.summary).toBe('an excerpt')
    expect(isVaultEntry(row)).toBe(true)
    expect(isVaultEntry({ ...row, feedId: 'f1' })).toBe(false)
  })
})

describe('vaultChannels', () => {
  it('lists every folder with the path a reader would recognise and its own count', () => {
    const rows = vaultChannels(folders, notes)
    expect(rows.map(row => row.name)).toEqual(['Alpha', 'Alpha / Beta', 'Gamma'])
    expect(rows.map(row => row.count)).toEqual([2, 1, 1])
  })
})

describe('the article library asked about a note folder', () => {
  // A library that does have an article, so "nothing" is an answer rather than an accident.
  const view = {
    library: { ...emptyLibrary(), feeds: [{ id: 'f1', url: 'https://x.test/feed', title: 'X', siteUrl: '', imageUrl: '', groupId: '', tags: [], order: 0, updatedAt: 1, lastAttemptAt: 1, error: '', errorCount: 0, lastErrorAt: 0, etag: '', lastModified: '', paused: false, pinned: false }] },
    articles: { f1: [{ id: 'e1', feedId: 'f1', title: 'An article', link: 'https://x.test/1', author: '', publishedTs: 5, summary: '', content: '', imageUrl: '', audioUrl: '' }] },
  }

  it('answers with nothing rather than with everything', () => {
    expect(channelEntries(view, { kind: 'vault', folderId: 'a' })).toEqual([])
    expect(channelEntries(view, { kind: 'all' }).map(entry => entry.id)).toEqual(['e1'])
  })

  it('names no feed to fetch, so opening the channel asks nothing of the network', () => {
    expect(feedsForChannel(view.library, { kind: 'vault', folderId: 'a' })).toEqual([])
    expect(feedsForChannel(view.library, { kind: 'all' }).map(feed => feed.id)).toEqual(['f1'])
  })
})
