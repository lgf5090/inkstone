import type { Folder, Note, NoteSummary, NoteVersionMeta, Tag } from '@shared/types'
import { sortTagNames } from '@shared/markdown-utils'


export interface NoteRow {
  id: string
  user_id: string
  folder_id: string | null
  title: string
  content: string
  excerpt: string
  rev: number
  word_count: number
  char_count: number
  is_pinned: number
  is_starred: number
  is_archived: number
  position: number
  content_hash: string
  created_at: number
  updated_at: number
  deleted_at: number | null

  tag_names?: string | null
}

export interface FolderRow {
  id: string
  parent_id: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  created_at: number
  updated_at: number
  note_count?: number
}

export interface TagRow {
  id: string
  name: string
  color: string | null
  created_at: number
  note_count?: number
}

export function toNoteSummary(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    folderId: row.folder_id,
    tags: splitTags(row.tag_names),
    isPinned: row.is_pinned === 1,
    isStarred: row.is_starred === 1,
    isArchived: row.is_archived === 1,
    wordCount: row.word_count,
    charCount: row.char_count,
    rev: row.rev,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

export function toNote(row: NoteRow): Note {
  return { ...toNoteSummary(row), content: row.content }
}

export function toFolder(row: FolderRow): Folder {
  const folder: Folder = {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.note_count !== undefined) folder.noteCount = row.note_count
  return folder
}

export function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    count: row.note_count ?? 0,
    createdAt: row.created_at,
  }
}

export function toVersionMeta(row: {
  id: string
  note_id: string
  title: string
  size: number
  created_at: number
}): NoteVersionMeta {
  return {
    id: row.id,
    noteId: row.note_id,
    title: row.title,
    size: row.size,
    createdAt: row.created_at,
  }
}


export const TAG_SEP_CODE = 1

export function splitTags(joined: string | null | undefined): string[] {
  if (!joined) return []
  return sortTagNames(joined.split(String.fromCharCode(TAG_SEP_CODE)).filter(Boolean))
}


const NOTE_COLUMNS_BASE = `n.id, n.user_id, n.folder_id, n.title, n.excerpt, n.rev,
  n.word_count, n.char_count, n.is_pinned, n.is_starred, n.is_archived, n.position,
  n.content_hash, n.created_at, n.updated_at, n.deleted_at`

/** Listing columns without tags; pair with noteTagsQueryForPage so a page pays one join. */
export const NOTE_COLUMNS_NOTAGS = NOTE_COLUMNS_BASE

/**
 * The per-row subquery is the cheap shape for a handful of rows: SQLite runs it once per
 * note. A page of 500 turns it into 500 index walks whose tags are never indexed for it,
 * so listings use NOTE_COLUMNS_NOTAGS plus noteTagsQueryForPage in the same batch.
 */
export const NOTE_COLUMNS = `${NOTE_COLUMNS_BASE},
  (SELECT GROUP_CONCAT(t.name, char(1)) FROM note_tags nt
     JOIN tags t ON t.id = nt.tag_id
    WHERE nt.note_id = n.id AND t.user_id = n.user_id) AS tag_names`

export const NOTE_COLUMNS_FULL = `${NOTE_COLUMNS}, n.content`

export interface NoteTagRow {
  note_id: string
  name: string
}

/**
 * Mirrors an already-built page query (`from` is the `FROM notes n WHERE … ORDER BY … LIMIT …`
 * tail) to fetch that page's tags as flat rows. `?1` must be bound to the account id.
 */
export function noteTagsQueryForPage(pageFrom: string): string {
  return `SELECT nt.note_id, t.name FROM note_tags nt
    JOIN tags t ON t.id = nt.tag_id AND t.user_id = ?1
   WHERE nt.note_id IN (SELECT n.id ${pageFrom})`
}

/** Rewrites rows in place so the existing mappers keep reading `tag_names`. */
export function attachNoteTags<T extends { id: string; tag_names?: string | null }>(
  rows: T[],
  tagRows: NoteTagRow[],
): void {
  if (!rows.length) return
  const owned = new Set(rows.map((row) => row.id))
  const byNote = new Map<string, string[]>()
  for (const tagRow of tagRows) {
    if (!owned.has(tagRow.note_id)) continue
    const names = byNote.get(tagRow.note_id)
    if (names) names.push(tagRow.name)
    else byNote.set(tagRow.note_id, [tagRow.name])
  }
  for (const row of rows) {
    const names = byNote.get(row.id)
    row.tag_names = names ? names.join(String.fromCharCode(TAG_SEP_CODE)) : null
  }
}

/** Body + metadata without the per-row tag GROUP_CONCAT subquery. */
export const NOTE_CONTENT_COLUMNS = `n.id, n.user_id, n.folder_id, n.title, n.excerpt, n.rev,
  n.word_count, n.char_count, n.is_pinned, n.is_starred, n.is_archived, n.position,
  n.content_hash, n.created_at, n.updated_at, n.deleted_at, n.content`

const TAG_SELECT_COLUMNS = `t.id, t.name, t.color, t.created_at,
  COUNT(n.id) AS note_count`

export function tagSelectQuery(whereClause: string): string {
  return `SELECT ${TAG_SELECT_COLUMNS}
    FROM tags t
    LEFT JOIN note_tags nt ON nt.tag_id = t.id
    LEFT JOIN notes n ON n.id = nt.note_id AND n.user_id = t.user_id
      AND n.deleted_at IS NULL AND n.is_archived = 0
   WHERE ${whereClause}
   GROUP BY t.id, t.name, t.color, t.created_at`
}
