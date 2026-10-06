import { api } from '../../api'
import { kanbanFileId } from './url'
import type { KanbanFile } from './types'

/**
 * The board's two doors to the attachment store. They live here rather than in `lib/api` because the
 * store speaks in attachments and a card's fence body speaks in `KanbanFile`; the translation belongs
 * on the side that owns the second shape.
 */

/**
 * `kanbanName` is the note the board lives in, or `'default'` for a board whose note is not saved
 * yet. The store keys an upload to a note so the attachment survives with it, so an unsaved board
 * uploads unowned rather than inventing an id.
 */
export async function uploadKanbanFile(file: File, kanbanName = 'default'): Promise<KanbanFile> {
  const stored = await api.files.upload(file, kanbanName === 'default' ? undefined : kanbanName)
  return { id: stored.id, name: stored.filename, size: stored.size, mime: stored.mime, url: stored.url }
}

/**
 * Takes the file itself, not a namespace and a name: this app addresses an attachment by its id, and
 * the only place that id is written down is the url the upload handed back. A file the store does not
 * hold has nothing here to delete, so the call answers without asking the network.
 */
export async function deleteKanbanFile(file: KanbanFile): Promise<boolean> {
  const id = kanbanFileId(file)
  if (!id) return false
  await api.files.remove(id)
  return true
}
