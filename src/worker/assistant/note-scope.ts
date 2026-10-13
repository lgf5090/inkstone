/**
 * Which notes the assistant may see.
 *
 * A reader can point the assistant at a few folders instead of the whole vault. That is a permission,
 * so it is enforced at the one place every note tool passes through rather than in the prompt: a model
 * that ignores an instruction in its system prompt is a normal Tuesday, and the note it then reads is
 * the one the reader had excluded.
 */

import { ApiError } from '../lib/errors'

export interface NoteScope {
  /** True when the reader named folders or tags, so the note tools must filter. */
  restricted: boolean
  folderIds: Set<string>
  /**
   * Tags pinned to one turn with `#`. A note has to carry at least one of them, which is how a reader
   * says "answer from my meeting notes" without moving files.
   */
  tagIds: Set<string>
}

/**
 * The folders in scope, with their descendants.
 *
 * A folder scope that did not include its subtree would read as a bug the first time a reader picked
 * a parent: the folder tree is how they think about their vault, and "Notes" means what is inside it.
 *
 * `extra` is the per-turn addition: the conversation keeps a standing scope in settings, and the reader
 * can pin more folders and tags for one message. Both are merged, because a turn may only narrow what the
 * assistant sees, never widen it past what the settings allowed.
 */
export async function resolveNoteScope(
  db: D1Database,
  userId: string,
  scopeFolderIds: readonly string[],
  extra: { folderIds?: readonly string[], tagIds?: readonly string[] } = {},
): Promise<NoteScope> {
  const wanted = [...new Set([...scopeFolderIds, ...(extra.folderIds ?? [])].filter((id) => /^[0-9a-hjkmnp-tv-z]{26}$/.test(id)))]
  const tagIds = new Set([...(extra.tagIds ?? [])].filter((id) => /^[0-9a-hjkmnp-tv-z]{26}$/.test(id)))
  if (!wanted.length) return { restricted: tagIds.size > 0, folderIds: new Set(), tagIds }
  const owned = new Set<string>()
  for (const id of wanted) {
    const row = await db.prepare(`SELECT id FROM folders WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`)
      .bind(userId, id).first<{ id: string }>()
    if (row) owned.add(row.id)
  }
  // Folders the reader no longer owns (deleted, or named by another account's backup) leave the set
  // empty, which reads as "nothing is in scope" — not as "no scope was set", which would open the vault.
  if (!owned.size) return { restricted: true, folderIds: owned, tagIds }
  const frontier = [...owned]
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const placeholders = frontier.map((_, index) => `?${index + 2}`).join(', ')
    const { results } = await db.prepare(
      `SELECT id FROM folders WHERE user_id = ?1 AND deleted_at IS NULL AND parent_id IN (${placeholders})`,
    ).bind(userId, ...frontier).all<{ id: string }>()
    frontier.length = 0
    for (const row of results ?? []) {
      if (owned.has(row.id)) continue
      owned.add(row.id)
      frontier.push(row.id)
    }
  }
  return { restricted: true, folderIds: owned, tagIds }
}

/** The subset of these note ids the scope allows, in one query. */
export async function readableNoteIds(
  db: D1Database,
  userId: string,
  noteIds: readonly string[],
  scope: NoteScope,
): Promise<Set<string>> {
  const ids = [...new Set(noteIds)].filter((id) => /^[0-9a-hjkmnp-tv-z]{26}$/.test(id))
  if (!ids.length) return new Set()
  if (!scope.restricted) return new Set(ids)
  const binds: unknown[] = [userId]
  const idPlaceholders = ids.map((id) => {
    binds.push(id)
    return `?${binds.length}`
  }).join(', ')
  const folders = [...scope.folderIds]
  const tags = [...scope.tagIds]
  if (!folders.length && !tags.length) return new Set()
  let where = `user_id = ?1 AND deleted_at IS NULL AND id IN (${idPlaceholders})`
  if (folders.length) {
    const folderPlaceholders = folders.map((folder) => {
      binds.push(folder)
      return `?${binds.length}`
    }).join(', ')
    where += ` AND folder_id IN (${folderPlaceholders})`
  }
  if (tags.length) {
    const tagPlaceholders = tags.map((tag) => {
      binds.push(tag)
      return `?${binds.length}`
    }).join(', ')
    where += ` AND EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = notes.id AND nt.tag_id IN (${tagPlaceholders}))`
  }
  const { results } = await db.prepare(
    `SELECT id FROM notes WHERE ${where}`,
  ).bind(...binds).all<{ id: string }>()
  return new Set((results ?? []).map((row) => row.id))
}

export async function assertNoteReadable(
  db: D1Database,
  userId: string,
  noteId: string,
  scope: NoteScope,
): Promise<void> {
  if (!/^[0-9a-hjkmnp-tv-z]{26}$/.test(noteId)) throw ApiError.notFound('Note not found')
  const allowed = await readableNoteIds(db, userId, [noteId], scope)
  if (!allowed.has(noteId)) throw ApiError.notFound('That note is not available to the assistant')
}

/** The note's own title, for an approval card or an activity line. */
export async function noteTitleForLog(db: D1Database, userId: string, noteId: string): Promise<string> {
  const row = await db.prepare(`SELECT title FROM notes WHERE user_id = ?1 AND id = ?2`)
    .bind(userId, noteId).first<{ title: string }>()
  if (!row) throw ApiError.notFound('Note not found')
  return row.title.slice(0, 90) || 'Untitled'
}
