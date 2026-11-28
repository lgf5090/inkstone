/**
 * Every read and write the reader shelf routes make against D1.
 *
 * The shape follows `notes/store.ts` and `assistant/store.ts`: a store built per request from the
 * account it serves, methods that take already-validated input and hand back rows or the answer the
 * route needs, and nothing in between that knows about HTTP. Two rules hold throughout:
 *  - every statement binds `user_id`, so one account's shelf can never surface in another's listing.
 *    The book-id lookups here are always `user_id` AND `id`, never `id` alone: the R2 key a row names
 *    is derived from the account, and an unscoped lookup would hand one reader another's bytes.
 *  - a mutation's statements stay in the one D1 batch they are written in today. A shelf merge is
 *    atomic on purpose, and splitting a batch into sequential runs would leave a half-merged shelf.
 *
 * The shelf listing reads the reader tables in parallel. They stay separate queries rather than one
 * batch, which is how they run today: a batch would serialize reads that have nothing to do with each
 * other.
 */

/**
 * The shelf rows, one per table, listing exactly the columns `shelf()` reads.
 *
 * The queries spell the same columns out rather than reaching for `*`: a column added to a `reader_`
 * table then has to be asked for, so a schema change cannot quietly widen the payload every reader
 * downloads on start-up, and `r2_key`, which is the server's own, cannot leak into it by accident.
 */
export interface ReaderBookRow {
  id: string
  format: string
  title: string
  author: string
  language: string
  publisher: string
  filename: string
  size: number
  added_at: number
  updated_at: number
  unit_count: number
  has_cover: number
  has_blob: number
  cover_key: string | null
  toc: string
  content_hash: string
  metadata: string
}

export interface ReaderProgressRow {
  book_id: string
  position: string
  fraction: number
  updated_at: number
  finished_at: number | null
}

export interface ReaderHighlightRow {
  id: string
  book_id: string
  chapter: number
  start_offset: number
  end_offset: number
  quote: string
  prefix: string
  suffix: string
  color: string
  comment: string
  created_at: number
  updated_at: number
}

export interface ReaderMarkRow {
  id: string
  book_id: string
  label: string
  position: string
  created_at: number
  updated_at: number
}

export interface ReaderStatRow {
  book_id: string
  seconds: number
  days: string
  updated_at: number
}

export interface ReaderBookNoteRow {
  book_id: string
  note_id: string
  updated_at: number
}

export interface ReaderMetaRow {
  key: string
  value: string | null
  updated_at: number
}

export interface ReaderGroupRow {
  id: string
  name: string
  book_ids: string
  created_at: number
  updated_at: number
}

export type ReaderSyncEntity =
  | 'books'
  | 'progress'
  | 'highlights'
  | 'marks'
  | 'stats'
  | 'notes'
  | 'groups'
  | 'vocabulary'

export interface ReaderSyncVersionRow {
  entity: ReaderSyncEntity
  entity_id: string
  book_id: string
  updated_at: number
  deleted: number
}

/** One account's shelf, as rows, in the order the listing reads them. */
export interface ReaderShelfRows {
  books: ReaderBookRow[]
  progress: ReaderProgressRow[]
  highlights: ReaderHighlightRow[]
  marks: ReaderMarkRow[]
  stats: ReaderStatRow[]
  notes: ReaderBookNoteRow[]
  meta: ReaderMetaRow[]
  groups: ReaderGroupRow[]
  syncVersions: ReaderSyncVersionRow[]
}

/** The book rows a push has to know the server-side answer to: where the bytes and the cover live. */
export interface StoredBookRow {
  id: string
  format: string
  r2_key: string
  has_blob: number
  cover_key: string | null
  cover_size: number
  size: number
}

/**
 * A validated book row, with the JSON columns already stringified by the route.
 *
 * `fallbackKey` is the R2 path the book takes when the account has never held its bytes: the route owns
 * storage paths, this layer only stores the one it was handed.
 */
export interface ShelfBookInput {
  id: string
  title: string
  author: string
  format: string
  filename: string
  language: string
  publisher: string
  size: number
  unitCount: number
  /** The shelf claims a cover for this book, whichever field it came in on. */
  wantsCover: boolean
  tocJson: string
  addedAt: number
  updatedAt: number
  fallbackKey: string
  contentHash?: string
  metadataJson?: string
}

export interface ShelfProgressInput {
  bookId: string
  positionJson: string
  fraction: number
  updatedAt: number
  finishedAt: number | null
}

export interface ShelfHighlightInput {
  id: string
  bookId: string
  chapter: number
  startOffset: number
  endOffset: number
  quote: string
  prefix: string
  suffix: string
  color: string
  comment: string
  createdAt: number
  updatedAt: number
}

export interface ShelfMarkInput {
  id: string
  bookId: string
  label: string
  positionJson: string
  createdAt: number
  updatedAt: number
}

export interface ShelfStatInput {
  bookId: string
  seconds: number
  daysJson: string
  updatedAt: number
}

export interface ShelfNoteInput {
  bookId: string
  noteId: string
  updatedAt: number
}

export interface ShelfGroupInput {
  id: string
  name: string
  /** Members the route kept: strings that name a book on this same shelf. */
  bookIds: string[]
  createdAt: number
  updatedAt: number
}

export interface ShelfDeletedIds {
  ids: string[]
  updatedAt: number
}

/** Explicit deletions are data, never the absence of a row from a snapshot. */
export interface ShelfDeletedInput {
  books: ShelfDeletedIds
  progress: ShelfDeletedIds
  highlights: ShelfDeletedIds
  marks: ShelfDeletedIds
  stats: ShelfDeletedIds
  notes: ShelfDeletedIds
  groups: ShelfDeletedIds
  vocabulary: { deleted: boolean; updatedAt: number } | null
}

/** A whole shelf, already validated and sliced by the route, ready to merge with the account's rows. */
export interface ShelfMergeInput {
  books: ShelfBookInput[]
  progress: ShelfProgressInput[]
  highlights: ShelfHighlightInput[]
  marks: ShelfMarkInput[]
  stats: ShelfStatInput[]
  notes: ShelfNoteInput[]
  /** `null` when the push said nothing about the reading note's vocabulary. */
  vocabulary: string | null
  vocabularyUpdatedAt?: number | null
  settings?: Record<string, unknown>
  settingsUpdatedAt?: number
  groups: ShelfGroupInput[]
  deleted: ShelfDeletedInput
}

export interface ShelfMergeResult {
  /** Incoming live books the shelf claims to hold but this account has no bytes for. */
  missingBlobs: string[]
  /** Incoming live books the shelf claims a cover for while no cover object was ever stored. */
  missingCovers: string[]
}

const DELETED_ENTITIES = ['books', 'progress', 'highlights', 'marks', 'stats', 'notes', 'groups'] as const

type DeletedEntity = (typeof DELETED_ENTITIES)[number]

function versionKey(entity: ReaderSyncEntity, entityId: string): string {
  return `${entity}\u0000${entityId}`
}

function emptyDeleted(): ShelfDeletedInput {
  return {
    books: { ids: [], updatedAt: 0 },
    progress: { ids: [], updatedAt: 0 },
    highlights: { ids: [], updatedAt: 0 },
    marks: { ids: [], updatedAt: 0 },
    stats: { ids: [], updatedAt: 0 },
    notes: { ids: [], updatedAt: 0 },
    groups: { ids: [], updatedAt: 0 },
    vocabulary: null,
  }
}

export class ReaderLibraryStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /** The whole shelf's reading state, rows only; the route decides the shape the device gets back. */
  async shelf(): Promise<ReaderShelfRows> {
    const [books, progress, highlights, marks, stats, notes, meta, groups, syncVersions] = await Promise.all([
      this.db.prepare(
        `SELECT id, format, title, author, language, publisher, filename, size, added_at, updated_at,
                unit_count, has_cover, has_blob, cover_key, toc, content_hash, metadata
           FROM reader_books WHERE user_id = ?1 ORDER BY added_at DESC`).bind(this.userId).all<ReaderBookRow>(),
      this.db.prepare(
        `SELECT book_id, position, fraction, updated_at, finished_at
           FROM reader_progress WHERE user_id = ?1`).bind(this.userId).all<ReaderProgressRow>(),
      this.db.prepare(
        `SELECT id, book_id, chapter, start_offset, end_offset, quote, prefix, suffix, color, comment,
                created_at, updated_at
           FROM reader_highlights WHERE user_id = ?1`).bind(this.userId).all<ReaderHighlightRow>(),
      this.db.prepare(
        `SELECT m.id, m.book_id, m.label, m.position, m.created_at,
                COALESCE(v.updated_at, m.created_at) AS updated_at
           FROM reader_marks m
           LEFT JOIN reader_sync_versions v
             ON v.user_id = m.user_id AND v.entity = 'marks' AND v.entity_id = m.id
          WHERE m.user_id = ?1`).bind(this.userId).all<ReaderMarkRow>(),
      this.db.prepare(
        `SELECT s.book_id, s.seconds, s.days, COALESCE(v.updated_at, 0) AS updated_at
           FROM reader_stats s
           LEFT JOIN reader_sync_versions v
             ON v.user_id = s.user_id AND v.entity = 'stats' AND v.entity_id = s.book_id
          WHERE s.user_id = ?1`).bind(this.userId).all<ReaderStatRow>(),
      this.db.prepare(
        `SELECT n.book_id, n.note_id, COALESCE(v.updated_at, 0) AS updated_at
           FROM reader_notes n
           LEFT JOIN reader_sync_versions v
             ON v.user_id = n.user_id AND v.entity = 'notes' AND v.entity_id = n.book_id
          WHERE n.user_id = ?1`).bind(this.userId).all<ReaderBookNoteRow>(),
      this.db.prepare(
        `SELECT key, value, updated_at
           FROM reader_meta WHERE user_id = ?1`).bind(this.userId).all<ReaderMetaRow>(),
      this.db.prepare(
        `SELECT id, name, book_ids, created_at, updated_at
           FROM reader_groups WHERE user_id = ?1 ORDER BY updated_at DESC`).bind(this.userId).all<ReaderGroupRow>(),
      this.db.prepare(
        `SELECT entity, entity_id, book_id, updated_at, deleted
           FROM reader_sync_versions WHERE user_id = ?1`).bind(this.userId).all<ReaderSyncVersionRow>(),
    ])
    return {
      books: books.results,
      progress: progress.results,
      highlights: highlights.results,
      marks: marks.results,
      stats: stats.results,
      notes: notes.results,
      meta: meta.results,
      groups: groups.results,
      syncVersions: syncVersions.results,
    }
  }

  /**
   * Merge a device snapshot into the account's reading state.
   *
   * Every entity carries its own `updatedAt`; only a strictly newer value may replace the stored row.
   * Omission is not deletion, so two devices can add different highlights without erasing each other.
   * The book rows keep their server-side R2 facts, except that a format change invalidates the old bytes
   * and cover because their keys and contents belong to the previous format.
   */
  async merge(input: ShelfMergeInput): Promise<ShelfMergeResult> {
    const [existing, versionRows, highlightRows, markRows, knowledgeIndex] = await Promise.all([
      this.db.prepare(
        'SELECT id, format, r2_key, has_blob, cover_key, cover_size, size FROM reader_books WHERE user_id = ?1',
      ).bind(this.userId).all<StoredBookRow>(),
      this.db.prepare(
        'SELECT entity, entity_id, book_id, updated_at, deleted FROM reader_sync_versions WHERE user_id = ?1',
      ).bind(this.userId).all<ReaderSyncVersionRow>(),
      this.db.prepare('SELECT id, book_id FROM reader_highlights WHERE user_id = ?1').bind(this.userId)
        .all<{ id: string; book_id: string }>(),
      this.db.prepare('SELECT id, book_id FROM reader_marks WHERE user_id = ?1').bind(this.userId)
        .all<{ id: string; book_id: string }>(),
      this.db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_reader_embeddings'`,
      ).first(),
    ])

    const books = new Map(existing.results.map((row) => [row.id, row]))
    const versions = new Map(versionRows.results.map((row) => [versionKey(row.entity, row.entity_id), row]))
    const highlightBooks = new Map(highlightRows.results.map((row) => [row.id, row.book_id]))
    const markBooks = new Map(markRows.results.map((row) => [row.id, row.book_id]))
    const statements: D1PreparedStatement[] = []
    const queueDeletion = (objectKey: string, bytes: number): void => {
      statements.push(this.db.prepare(
        `INSERT INTO reader_storage_deletions (user_id, object_key, bytes, created_at)
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id, object_key) DO UPDATE SET
           bytes = MAX(reader_storage_deletions.bytes, excluded.bytes)`,
      ).bind(this.userId, objectKey, Math.max(0, bytes), Date.now()))
    }

    const isNewer = (entity: ReaderSyncEntity, entityId: string, updatedAt: number): boolean => {
      const current = versions.get(versionKey(entity, entityId))
      return !current || updatedAt > current.updated_at
    }

    const writeVersion = (
      entity: ReaderSyncEntity,
      entityId: string,
      bookId: string,
      updatedAt: number,
      deleted: boolean,
      allowEqual = false,
    ): void => {
      const comparison = allowEqual ? '>=' : '>'
      statements.push(this.db.prepare(
        `INSERT INTO reader_sync_versions (user_id, entity, entity_id, book_id, updated_at, deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(user_id, entity, entity_id) DO UPDATE SET
           book_id = excluded.book_id, updated_at = excluded.updated_at, deleted = excluded.deleted
         WHERE excluded.updated_at ${comparison} reader_sync_versions.updated_at`,
      ).bind(this.userId, entity, entityId, bookId, updatedAt, deleted ? 1 : 0))
      versions.set(versionKey(entity, entityId), {
        entity, entity_id: entityId, book_id: bookId, updated_at: updatedAt, deleted: deleted ? 1 : 0,
      })
    }

    const writeLive = (
      entity: ReaderSyncEntity,
      entityId: string,
      bookId: string,
      updatedAt: number,
      statement: D1PreparedStatement,
    ): boolean => {
      if (!isNewer(entity, entityId, updatedAt)) return false
      statements.push(statement)
      writeVersion(entity, entityId, bookId, updatedAt, false)
      return true
    }

    const writeDeleted = (
      entity: ReaderSyncEntity,
      entityId: string,
      bookId: string,
      updatedAt: number,
      statement: D1PreparedStatement,
    ): boolean => {
      if (!isNewer(entity, entityId, updatedAt)) return false
      statements.push(statement)
      writeVersion(entity, entityId, bookId, updatedAt, true)
      return true
    }

    const missingBlobs: string[] = []
    const missingCovers: string[] = []
    for (const book of input.books) {
      const current = books.get(book.id)
      const formatChanged = Boolean(current && current.format !== book.format)
      const hasBlob = !formatChanged && current?.has_blob === 1
      const cover = formatChanged ? null : current?.cover_key ?? null
      const coverSize = formatChanged ? 0 : current?.cover_size ?? 0
      if (!hasBlob) missingBlobs.push(book.id)
      if (book.wantsCover && !cover) missingCovers.push(book.id)
      const written = writeLive('books', book.id, '', book.updatedAt, this.db.prepare(
        `INSERT OR REPLACE INTO reader_books (id, user_id, title, author, format, filename, language, publisher, size, unit_count, r2_key, has_cover, toc, added_at, updated_at, has_blob, cover_key, cover_size, content_hash, metadata)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
         WHERE ?15 > COALESCE((SELECT updated_at FROM reader_sync_versions
                                WHERE user_id = ?2 AND entity = 'books' AND entity_id = ?1), -1)`,
      ).bind(
        book.id, this.userId, book.title, book.author, book.format, book.filename, book.language, book.publisher,
        formatChanged ? 0 : book.size, book.unitCount,
        formatChanged ? book.fallbackKey : current?.r2_key ?? book.fallbackKey,
        book.wantsCover ? 1 : 0, book.tocJson, book.addedAt, book.updatedAt,
        hasBlob ? 1 : 0, cover, coverSize, book.contentHash ?? '', book.metadataJson ?? '{}',
      ))
      if (written && formatChanged && current) {
        queueDeletion(current.r2_key, current.size)
        if (current.cover_key) queueDeletion(current.cover_key, current.cover_size)
      }
    }

    const deletedBooks = new Map<string, number>()
    for (const id of input.deleted.books.ids) {
      if (!writeDeleted('books', id, '', input.deleted.books.updatedAt, this.db.prepare(
        `DELETE FROM reader_books WHERE user_id = ?1 AND id = ?2
           AND ?3 > COALESCE((SELECT updated_at FROM reader_sync_versions
                               WHERE user_id = ?1 AND entity = 'books' AND entity_id = ?2), -1)`,
      ).bind(this.userId, id, input.deleted.books.updatedAt))) continue
      const removed = books.get(id)
      if (removed) {
        queueDeletion(removed.r2_key, removed.size)
        if (removed.cover_key) queueDeletion(removed.cover_key, removed.cover_size)
      }
      deletedBooks.set(id, input.deleted.books.updatedAt)
    }

    for (const row of input.progress) {
      if (deletedBooks.has(row.bookId)) continue
      writeLive('progress', row.bookId, row.bookId, row.updatedAt, this.db.prepare(
        `INSERT OR REPLACE INTO reader_progress (user_id, book_id, position, fraction, updated_at, finished_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE ?5 > COALESCE((SELECT updated_at FROM reader_sync_versions
                                WHERE user_id = ?1 AND entity = 'progress' AND entity_id = ?2), -1)`,
      ).bind(this.userId, row.bookId, row.positionJson, row.fraction, row.updatedAt, row.finishedAt))
    }

    for (const row of input.highlights) {
      if (deletedBooks.has(row.bookId)) continue
      writeLive('highlights', row.id, row.bookId, row.updatedAt, this.db.prepare(
        `INSERT OR REPLACE INTO reader_highlights (id, user_id, book_id, chapter, start_offset, end_offset, quote, prefix, suffix, color, comment, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
         WHERE ?13 > COALESCE((SELECT updated_at FROM reader_sync_versions
                                WHERE user_id = ?2 AND entity = 'highlights' AND entity_id = ?1), -1)`,
      ).bind(row.id, this.userId, row.bookId, row.chapter, row.startOffset, row.endOffset, row.quote,
        row.prefix, row.suffix, row.color, row.comment, row.createdAt, row.updatedAt))
    }

    for (const row of input.marks) {
      if (deletedBooks.has(row.bookId)) continue
      writeLive('marks', row.id, row.bookId, row.updatedAt, this.db.prepare(
        `INSERT OR REPLACE INTO reader_marks (id, user_id, book_id, label, position, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE ?7 > COALESCE((SELECT updated_at FROM reader_sync_versions
                                WHERE user_id = ?2 AND entity = 'marks' AND entity_id = ?1), -1)`,
      ).bind(row.id, this.userId, row.bookId, row.label, row.positionJson, row.createdAt, row.updatedAt))
    }

    for (const row of input.stats) {
      if (deletedBooks.has(row.bookId)) continue
      writeLive('stats', row.bookId, row.bookId, row.updatedAt, this.db.prepare(
        `INSERT OR REPLACE INTO reader_stats (user_id, book_id, seconds, days)
         SELECT ?1, ?2, ?3, ?4
         WHERE ?5 > COALESCE((SELECT updated_at FROM reader_sync_versions
                                WHERE user_id = ?1 AND entity = 'stats' AND entity_id = ?2), -1)`,
      ).bind(this.userId, row.bookId, row.seconds, row.daysJson, row.updatedAt))
    }

    for (const row of input.notes) {
      if (deletedBooks.has(row.bookId)) continue
      writeLive('notes', row.bookId, row.bookId, row.updatedAt, this.db.prepare(
        `INSERT OR REPLACE INTO reader_notes (user_id, book_id, note_id)
         SELECT ?1, ?2, ?3
         WHERE ?4 > COALESCE((SELECT updated_at FROM reader_sync_versions
                                WHERE user_id = ?1 AND entity = 'notes' AND entity_id = ?2), -1)`,
      ).bind(this.userId, row.bookId, row.noteId, row.updatedAt))
    }

    if (input.vocabulary !== null && input.vocabularyUpdatedAt !== undefined && input.vocabularyUpdatedAt !== null) {
      writeLive('vocabulary', 'vocabulary', '', input.vocabularyUpdatedAt, this.db.prepare(
        `INSERT OR REPLACE INTO reader_meta (user_id, key, value, updated_at)
         SELECT ?1, 'vocabulary', ?2, ?3
         WHERE ?3 > COALESCE((SELECT updated_at FROM reader_sync_versions
                                WHERE user_id = ?1 AND entity = 'vocabulary' AND entity_id = 'vocabulary'), -1)`,
      ).bind(this.userId, input.vocabulary, input.vocabularyUpdatedAt))
    }
    if (input.settings && input.settingsUpdatedAt !== undefined) {
      statements.push(this.db.prepare(
        `INSERT INTO reader_meta (user_id, key, value, updated_at)
         SELECT ?1, 'settings', ?2, ?3
         WHERE ?3 > COALESCE((SELECT updated_at FROM reader_meta WHERE user_id = ?1 AND key = 'settings'), -1)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
           WHERE excluded.updated_at > reader_meta.updated_at`,
      ).bind(this.userId, JSON.stringify(input.settings), input.settingsUpdatedAt))
    }

    for (const group of input.groups) {
      writeLive('groups', group.id, '', group.updatedAt, this.db.prepare(
        `INSERT OR REPLACE INTO reader_groups (id, user_id, name, book_ids, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE ?6 > COALESCE((SELECT updated_at FROM reader_sync_versions
                                WHERE user_id = ?2 AND entity = 'groups' AND entity_id = ?1), -1)`,
      ).bind(group.id, this.userId, group.name, JSON.stringify(group.bookIds), group.createdAt, group.updatedAt))
    }

    const deleteByEntity = (entity: DeletedEntity, id: string, updatedAt: number): D1PreparedStatement => {
      const version = `COALESCE((SELECT updated_at FROM reader_sync_versions
                                 WHERE user_id = ?1 AND entity = '${entity}' AND entity_id = ?2), -1)`
      if (entity === 'progress' || entity === 'stats' || entity === 'notes') {
        return this.db.prepare(`DELETE FROM reader_${entity} WHERE user_id = ?1 AND book_id = ?2 AND ?3 > ${version}`)
          .bind(this.userId, id, updatedAt)
      }
      return this.db.prepare(`DELETE FROM reader_${entity} WHERE user_id = ?1 AND id = ?2 AND ?3 > ${version}`)
        .bind(this.userId, id, updatedAt)
    }

    for (const entity of DELETED_ENTITIES) {
      if (entity === 'books') continue
      const deletion = input.deleted[entity]
      for (const id of deletion.ids) {
        const bookId = entity === 'highlights' ? highlightBooks.get(id) ?? versions.get(versionKey(entity, id))?.book_id ?? ''
          : entity === 'marks' ? markBooks.get(id) ?? versions.get(versionKey(entity, id))?.book_id ?? ''
            : entity === 'groups' ? '' : id
        writeDeleted(entity, id, bookId, deletion.updatedAt, deleteByEntity(entity, id, deletion.updatedAt))
      }
    }

    if (input.deleted.vocabulary?.deleted) {
      writeDeleted('vocabulary', 'vocabulary', '', input.deleted.vocabulary.updatedAt, this.db.prepare(
        `DELETE FROM reader_meta WHERE user_id = ?1 AND key = 'vocabulary'
           AND ?2 > COALESCE((SELECT updated_at FROM reader_sync_versions
                               WHERE user_id = ?1 AND entity = 'vocabulary' AND entity_id = 'vocabulary'), -1)`,
      ).bind(this.userId, input.deleted.vocabulary.updatedAt))
    }

    // A deleted book owns all of its reading rows. Tombstone those rows too, so an older snapshot cannot
    // bring them back after the book itself has gone.
    for (const [bookId, deletedAt] of deletedBooks) {
      statements.push(
        this.db.prepare('DELETE FROM reader_progress WHERE user_id = ?1 AND book_id = ?2').bind(this.userId, bookId),
        this.db.prepare('DELETE FROM reader_highlights WHERE user_id = ?1 AND book_id = ?2').bind(this.userId, bookId),
        this.db.prepare('DELETE FROM reader_marks WHERE user_id = ?1 AND book_id = ?2').bind(this.userId, bookId),
        this.db.prepare('DELETE FROM reader_stats WHERE user_id = ?1 AND book_id = ?2').bind(this.userId, bookId),
        this.db.prepare('DELETE FROM reader_notes WHERE user_id = ?1 AND book_id = ?2').bind(this.userId, bookId),
      )
      for (const entity of ['progress', 'stats', 'notes'] as const) {
        const current = versions.get(versionKey(entity, bookId))
        const updatedAt = Math.max(deletedAt, current?.updated_at ?? 0)
        if (!current || current.deleted !== 1 || updatedAt > current.updated_at) writeVersion(entity, bookId, bookId, updatedAt, true, true)
      }
      for (const [entity, rows] of [['highlights', highlightRows.results], ['marks', markRows.results]] as const) {
        for (const row of rows) {
          if (row.book_id !== bookId) continue
          const current = versions.get(versionKey(entity, row.id))
          const updatedAt = Math.max(deletedAt, current?.updated_at ?? 0)
          if (!current || current.deleted !== 1 || updatedAt > current.updated_at) writeVersion(entity, row.id, bookId, updatedAt, true, true)
        }
      }
      if (knowledgeIndex) {
        statements.push(this.db.prepare(
          'DELETE FROM chat_reader_embeddings WHERE user_id = ?1 AND book_id = ?2',
        ).bind(this.userId, bookId))
      }
    }

    if (deletedBooks.size) {
      for (const bookId of deletedBooks.keys()) {
        statements.push(this.db.prepare(
          `UPDATE reader_groups SET book_ids = (SELECT COALESCE(json_group_array(value), '[]')
                                                 FROM json_each(reader_groups.book_ids) WHERE value != ?2)
                                       WHERE user_id = ?1`,
        ).bind(this.userId, bookId))
      }
    }

    if (statements.length) await this.db.batch(statements)
    return { missingBlobs, missingCovers }
  }

  /** The book a blob upload is answered from: the format that decides the key, the size already charged. */
  async bookForBlob(bookId: string): Promise<{ format: string; size: number } | null> {
    return this.db.prepare('SELECT format, size FROM reader_books WHERE user_id = ?1 AND id = ?2')
      .bind(this.userId, bookId).first<{ format: string; size: number }>()
  }

  /** Record where the bytes landed. The key comes from the route, which derives it from this row. */
  async markBlobStored(bookId: string, key: string, size: number): Promise<void> {
    await this.db.prepare('UPDATE reader_books SET r2_key = ?1, size = ?2, has_blob = 1 WHERE user_id = ?3 AND id = ?4')
      .bind(key, size, this.userId, bookId).run()
  }

  /** The book a download is served from, including the name the reader gave the file. */
  async bookForDownload(bookId: string): Promise<{ format: string; r2_key: string; filename: string | null } | null> {
    return this.db.prepare('SELECT format, r2_key, filename FROM reader_books WHERE user_id = ?1 AND id = ?2')
      .bind(this.userId, bookId).first<{ format: string; r2_key: string; filename: string | null }>()
  }

  /** The book a cover upload is answered from: where the old cover lives and how big it was. */
  async bookForCover(bookId: string): Promise<{ cover_key: string | null; cover_size: number } | null> {
    return this.db.prepare('SELECT cover_key, cover_size FROM reader_books WHERE user_id = ?1 AND id = ?2')
      .bind(this.userId, bookId).first<{ cover_key: string | null; cover_size: number }>()
  }

  /** Record where the cover landed, charged against the account the row belongs to. */
  async setCover(bookId: string, key: string, size: number): Promise<void> {
    await this.db.prepare('UPDATE reader_books SET cover_key = ?1, cover_size = ?2 WHERE user_id = ?3 AND id = ?4')
      .bind(key, size, this.userId, bookId).run()
  }

  /** The cover object's key, which is the only thing a cover read needs. */
  async coverKeyOf(bookId: string): Promise<{ cover_key: string | null } | null> {
    return this.db.prepare('SELECT cover_key FROM reader_books WHERE user_id = ?1 AND id = ?2')
      .bind(this.userId, bookId).first<{ cover_key: string | null }>()
  }

  /** The two objects a deletion has to release, or nothing when the account never had this book. */
  async bookObjects(bookId: string): Promise<{ r2_key: string; cover_key: string | null } | null> {
    return this.db.prepare('SELECT r2_key, cover_key FROM reader_books WHERE user_id = ?1 AND id = ?2')
      .bind(this.userId, bookId).first<{ r2_key: string; cover_key: string | null }>()
  }

  async queueStorageDeletion(objectKey: string, bytes: number): Promise<void> {
    await this.db.prepare(
      `INSERT INTO reader_storage_deletions (user_id, object_key, bytes, created_at)
       VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id, object_key) DO UPDATE SET
         bytes = MAX(reader_storage_deletions.bytes, excluded.bytes)`,
    ).bind(this.userId, objectKey, Math.max(0, bytes), Date.now()).run()
  }

  async storageDeletions(limit = 100): Promise<Array<{ object_key: string; bytes: number }>> {
    const rows = await this.db.prepare(
      'SELECT object_key, bytes FROM reader_storage_deletions WHERE user_id = ?1 ORDER BY created_at LIMIT ?2',
    ).bind(this.userId, limit).all<{ object_key: string; bytes: number }>()
    return rows.results
  }

  async finishStorageDeletion(objectKey: string): Promise<void> {
    await this.db.prepare('DELETE FROM reader_storage_deletions WHERE user_id = ?1 AND object_key = ?2')
      .bind(this.userId, objectKey).run()
  }

  /**
   * Take the book and everything read from it, in one batch, and leave tombstones for other devices.
   *
   * A group keeps its name when it loses a member: the reader made the group, and an empty one is a
   * place they will put the next book.
   */
  async deleteBook(bookId: string, updatedAt = Date.now()): Promise<void> {
    const deleted = emptyDeleted()
    deleted.books = { ids: [bookId], updatedAt }
    await this.merge({
      books: [],
      progress: [],
      highlights: [],
      marks: [],
      stats: [],
      notes: [],
      vocabulary: null,
      groups: [],
      deleted,
    })
  }
}
