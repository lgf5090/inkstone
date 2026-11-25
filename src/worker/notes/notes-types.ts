import type { SortKey, SortOrder, ViewKind } from '@shared/types'
import type { NoteRow } from '../db/rows'

/**
 * The last row of a page, in the order the listing sorted it.
 *
 * A keyset cursor is a row's sort position, not an offset, so a page turn cannot shift when another
 * note is edited in between; the offset form below only exists for links minted before that was true.
 */
export interface NotesListCursor {
  view: ViewKind
  sort: SortKey
  order: SortOrder
  pinned: number
  value: string | number
  id: string
}

export type ParsedNotesListCursor =
  | { kind: 'first' }
  | { kind: 'legacy'; offset: number }
  | { kind: 'keyset'; cursor: NotesListCursor }

/** A validated listing request: the route parses the query string, this names what to fetch. */
export interface NotesListQuery {
  view: ViewKind
  sort: SortKey
  order: SortOrder
  limit: number
  cursor: ParsedNotesListCursor
  /** Required by the `folder` view; checked by the route. */
  folderId?: string
  /** Tag scopes to keep, required by the `tag` view; combined with AND. */
  tags?: string[]
  /** Tag scopes to drop, already trimmed and capped by the route. */
  excludeTags?: string[]
}

export interface NotesListPage {
  /** The page plus one extra row when there is a next page, so the route decides `nextCursor`. */
  rows: NoteRow[]
  /** `null` on a keyset page: the client already counted the listing this page continues. */
  total: number | null
}

/** A note the route has validated, hashed and measured; `id` and `now` were chosen by the route. */
export interface NoteCreateInput {
  id: string
  folderId: string | null
  title: string
  content: string
  excerpt: string
  words: number
  chars: number
  isStarred: boolean
  contentHash: string
  now: number
}

/** The same note copied from another: the archive state comes from the source, and nothing is starred. */
export interface NoteDuplicateInput {
  id: string
  folderId: string | null
  title: string
  content: string
  excerpt: string
  words: number
  chars: number
  isArchived: number
  contentHash: string
  now: number
}

export interface NoteMergeInput {
  target: NoteRow
  sources: NoteRow[]
  now: number
}

export interface NoteMergeResult {
  row: NoteRow | null
  changeSeq: number | undefined
  applied: boolean
  merged: number
  tooLarge: boolean
}

export interface NoteWriteResult {
  /** `null` only for `create`, whose insert ignores an id that turned out to be taken. */
  row: NoteRow | null
  /** The `changes` row this write produced, for the cursor the route broadcasts. */
  changeSeq: number | undefined
  /** False when the write was skipped: `create` lost an id race. */
  created: boolean
}

/**
 * The outcome of a guarded mutation.
 *
 * `applied` is false when the `rev`/`content_hash` guard matched nothing, which means somebody else
 * wrote the note between the route's read and this batch; the route turns that into a 409 with the
 * server copy, so the readback row is only meaningful when `applied` is true.
 */
export interface NoteMutationResult {
  row: NoteRow | null
  changeSeq: number | undefined
  applied: boolean
}

/** A stored revision: the listing reads it without the body, the single view reads it with. */
export interface NoteVersionMetaRow {
  id: string
  note_id: string
  title: string
  size: number
  created_at: number
}

export interface NoteVersionRow extends NoteVersionMetaRow {
  content: string
}

/**
 * A revision write the route has already chosen: the body, its hash, its measurements and the title
 * the note is to carry afterwards, all derived from the revision outside the store.
 */
export interface VersionRestoreInput {
  noteId: string
  /** The note as the route read it, which supplies the revision the write is guarded against. */
  current: NoteRow
  title: string
  content: string
  excerpt: string
  words: number
  chars: number
  contentHash: string
  now: number
}

/** The row the caller read, plus the revision and timestamp its response already advertises. */
export interface NoteTrashInput {
  current: NoteRow
  now: number
  nextRev: number
}

/** The same shape for a restore: the guard is on the trashed revision, the write lands on the next. */
export interface NoteRestoreInput {
  current: NoteRow
  now: number
  nextRev: number
}

/** The columns an edit writes, named as the table names them; `updated_at` and `rev` are not the caller's. */
export interface NotePatchColumns {
  content?: string
  content_hash?: string
  title?: string
  title_key?: string
  excerpt?: string
  word_count?: number
  char_count?: number
  folder_id?: string | null
  is_pinned?: number
  is_starred?: number
  is_archived?: number
  is_encrypted?: number
}

/**
 * One edit, decided by the route: which columns differ, what the note says afterwards, and whether the
 * text it stops saying is worth keeping.
 */
export interface NotePatchInput {
  current: NoteRow
  /** The revision the client sent; the update matches it so a stale editor cannot overwrite a newer one. */
  expectedRev: number
  columns: NotePatchColumns
  title: string
  content: string
  contentHash: string
  now: number
  contentChanged: boolean
  titleChanged: boolean
  /** Rebuild tags, links and index rows: skipped for a note that is already in the trash. */
  derive: boolean
  /**
   * Whether this edit's text belongs in the AI index. A lock writes ciphertext, which must not be
   * embedded; ordinary edits leave this unset and keep the queue statement.
   */
  indexable?: boolean
  sealing?: boolean
  /** `null` when the previous text is not kept; the route owns that rule. */
  snapshot: { preserve: boolean; bigChange: boolean } | null
  extraGuard?: { sql: string; values: unknown[] }
  prefixStatements?: D1PreparedStatement[]
  suffixStatements?: D1PreparedStatement[]
}

export interface NotePatchResult {
  applied: boolean
  changeSeq: number | undefined
  /** The note as this batch leaves it, so the caller can answer without reading it back. */
  next: NoteRow
  /** Another live note already answers to either title, so wiki links must not be rewritten. */
  ambiguous: boolean
}
