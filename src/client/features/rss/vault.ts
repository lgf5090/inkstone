/**
 * A folder of the reader's own notes, read as a subscription.
 *
 * The reference reader can point a channel at local vault files, and the useful half of that idea
 * here is the *list*: a folder's notes, newest first, with the same rows, search and sort the feeds
 * get. What is deliberately not copied is the reading pane — a note is read in the notebook, where
 * it can be edited, linked and synced, so opening a row leaves this app rather than rendering a
 * second, worse copy of the note.
 *
 * A note is not an article, and the shapes below say so: no link, no body, and the folder's own name
 * where a source would be. The marks an article can carry (star, later, hide) are not offered for
 * these rows, because writing them would put note ids into the account's article lists.
 */
import type { Folder, NoteSummary } from '@shared/types'
import type { RssEntry } from '@shared/rss/model'
import { folderDescendantIds, folderPathLabel } from '../../lib/folders'

/** The channel's id for a note folder, so a row can be traced back to the folder it came from. */
export function vaultFeedId(folderId: string): string {
  return `vault:${folderId}`
}

export function isVaultEntry(entry: RssEntry): boolean {
  return entry.feedId.startsWith('vault:')
}

/** Every note in the folder and under it, newest first, as a row. */
export function vaultEntries(notes: NoteSummary[], folders: Folder[], folderId: string): RssEntry[] {
  // `folderDescendantIds` already counts the folder itself, which is what a folder view means here.
  const shelf = folderDescendantIds(folders, folderId)
  return notes
    .filter(note => !note.deletedAt && !note.isArchived && shelf.has(note.folderId ?? ''))
    .map(note => ({
      id: note.id,
      feedId: vaultFeedId(folderId),
      title: note.title,
      link: '',
      author: '',
      publishedTs: note.updatedAt,
      summary: note.excerpt,
      content: '',
      imageUrl: '',
      audioUrl: '',
    }))
    .sort((a, b) => (b.publishedTs ?? 0) - (a.publishedTs ?? 0))
}

/** The folders that can become a channel, each with how many notes it holds including its own. */
export function vaultChannels(folders: Folder[], notes: NoteSummary[]): Array<{ id: string, name: string, count: number }> {
  return folders
    .map(folder => {
      const shelf = folderDescendantIds(folders, folder.id)
      return {
        id: folder.id,
        name: folderPathLabel(folders, folder.id) || folder.name,
        count: notes.filter(note => !note.deletedAt && !note.isArchived && shelf.has(note.folderId ?? '')).length,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
