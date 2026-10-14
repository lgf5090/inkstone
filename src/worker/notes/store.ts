/**
 * Every read and write the notes HTTP routes make against D1.
 *
 * The shape follows `assistant/store.ts`, the one place in this worker where a route holds no SQL at
 * all: a store built per request from the account it serves, methods that take already-validated
 * input and hand back rows or the record the route needs to answer with, and nothing in between that
 * knows about HTTP. Two rules hold throughout, both inherited from that file:
 *  - every statement carries `user_id`, so one reader's notes can never surface in another's listing,
 *    and the few statements that cannot (a cross-account id collision probe, a join through a note id
 *    that the scoped statement already resolved) are the deliberate exceptions, written next to the
 *    scoped statement that put the id in play;
 *  - a mutation's statements stay in one D1 batch. The guards inside them (`rev`, `content_hash`,
 *    `updated_at`) only mean "nobody changed this row between my read and my write" while the whole
 *    batch lands together, so splitting a batch into sequential runs would turn an atomic edit into a
 *    lost update that no test would notice.
 *
 * Change records (`changes.seq`) come back to the caller rather than being broadcast here: the cursor
 * belongs to the response and the background drain to the request context, both of which are the
 * route's business.
 */

import { LIMITS } from '@shared/constants'
import {
  countText,
  deriveExcerpt,
  extractTags,
  foldCase,
  foldIndexOf,
  likePattern,
  linkFirstMention,
  normalizeLinkKey,
  plainLinkText,
  replaceWikiLinkTarget,
  trimFrontMatterLead,
} from '@shared/markdown-utils'
import { truncateText, utf8ByteLength } from '@shared/text-utils'
import type { SortKey, SortOrder, ViewKind } from '@shared/types'
import {
  NOTE_COLUMNS_FULL,
  NOTE_COLUMNS_NOTAGS,
  TAG_SEP_CODE,
  attachNoteTags,
  noteTagsQueryForPage,
  splitTags,
  tagScopePredicate,
  type NoteRow,
  type NoteTagRow,
} from '../db/rows'
import {
  FTS_QUEUE_CONFLICT_SQL,
  INLINE_REWRITE_LIMIT,
  LINK_TARGET_SUBQUERY,
  REWRITE_CONCURRENCY,
  REWRITE_LOAD_CHUNK,
  buildNoteDerivedStatements,
  rewriteQueueStatement,
  shiftSqlPlaceholders,
} from '../db/writes'
import { aiDeleteNeededSql, noteIndexQueueStatement } from '../mcp/ai-search'
import { buildFtsQuery } from '../routes/search'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'

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

/** How long a note's previous text is kept only when the edit was big or asked for it. */
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000

/** The columns an edit writes, named as the table names them; `updated_at` and `rev` are not the caller's. */
export interface NotePatchColumns {
  content?: string
  content_hash?: string
  title?: string
  excerpt?: string
  word_count?: number
  char_count?: number
  folder_id?: string | null
  is_pinned?: number
  is_starred?: number
  is_archived?: number
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
  /** `null` when the previous text is not kept; the route owns that rule. */
  snapshot: { preserve: boolean; bigChange: boolean } | null
}

export interface NotePatchResult {
  applied: boolean
  changeSeq: number | undefined
  /** The note as this batch leaves it, so the caller can answer without reading it back. */
  next: NoteRow
  /** Another live note already answers to either title, so wiki links must not be rewritten. */
  ambiguous: boolean
}

export class NotesStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
    /**
     * Whether this database has the FTS index.
     *
     * It is a property of the connection, decided once per request by `db/fts.ts`, and every write
     * here queues an index update only when it is set.
     */
    readonly ftsEnabled: boolean,
  ) {}

  /**
   * One page of a note view, with its tags and (for a first page) its total.
   *
   * The page and its tags are two statements in one batch because a listing of 500 notes cannot pay
   * 500 correlated `GROUP_CONCAT` walks; see `noteTagsQueryForPage`. The count rides in the same
   * batch only when the caller actually needs a fresh one.
   */
  async list(query: NotesListQuery): Promise<NotesListPage> {
    const { view, sort, order, limit, cursor } = query
    const binds: unknown[] = [this.userId]
    let where = 'n.user_id = ?1'

    if (view === 'trash') {
      where += ' AND n.deleted_at IS NOT NULL'
    } else {
      where += ' AND n.deleted_at IS NULL'
      where += view === 'archived' ? ' AND n.is_archived = 1' : ' AND n.is_archived = 0'
    }

    if (view === 'starred') where += ' AND n.is_starred = 1'
    if (view === 'unfiled') where += ' AND n.folder_id IS NULL'
    if (view === 'untagged') {
      where += ' AND NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id)'
    }

    if (view === 'folder') {
      binds.push(query.folderId!)
      where += ` AND n.folder_id = ?${binds.length}`
    }

    // Several `tag` params combine with AND, and each one also matches its whole subtree so the
    // rolled-up count in the sidebar and the result set agree. Both halves have to stay in step
    // with tagInScope(), which spells the same rule in TypeScript for the offline shell.
    for (const scope of query.excludeTags ?? []) {
      binds.push(scope, likePattern(`${scope}/`))
      const nameBind = binds.length - 1
      const prefixBind = binds.length
      where += ` AND NOT EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                   WHERE nt.note_id = n.id AND t.user_id = n.user_id
                     AND ${tagScopePredicate('t.name', `?${nameBind}`, `?${prefixBind}`)})`
    }

    if (view === 'tag') {
      for (const tag of query.tags ?? []) {
        binds.push(tag, likePattern(`${tag}/`))
        const nameBind = binds.length - 1
        const prefixBind = binds.length
        where += ` AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                   WHERE nt.note_id = n.id AND t.user_id = n.user_id
                     AND ${tagScopePredicate('t.name', `?${nameBind}`, `?${prefixBind}`)})`
      }
    }

    const countWhere = where
    const countBinds = [...binds]

    const dir = order === 'asc' ? 'ASC' : 'DESC'
    const valueColumn = view === 'trash'
      ? 'n.deleted_at'
      : sort === 'created'
        ? 'n.created_at'
        : sort === 'title'
          ? 'n.title'
          : 'n.updated_at'
    const valueCollation = sort === 'title' && view !== 'trash' ? ' COLLATE NOCASE' : ''
    const orderBy =
      view === 'trash'
        ? `n.deleted_at ${dir}, n.id ASC`
        : ({
            updated: `n.is_pinned DESC, n.updated_at ${dir}, n.id ASC`,
            created: `n.is_pinned DESC, n.created_at ${dir}, n.id ASC`,
            title: `n.is_pinned DESC, n.title COLLATE NOCASE ${dir}, n.id ASC`,
          }[sort] ?? `n.is_pinned DESC, n.updated_at ${dir}, n.id ASC`)

    if (cursor.kind === 'keyset') {
      const comparison = order === 'asc' ? '>' : '<'
      if (view === 'trash') {
        binds.push(cursor.cursor.value, cursor.cursor.value, cursor.cursor.id)
        const valueBind = binds.length - 2
        const repeatedValueBind = binds.length - 1
        const idBind = binds.length
        where += ` AND (${valueColumn}${valueCollation} ${comparison} ?${valueBind}
          OR (${valueColumn}${valueCollation} = ?${repeatedValueBind} AND n.id > ?${idBind}))`
      } else {
        binds.push(
          cursor.cursor.pinned,
          cursor.cursor.pinned,
          cursor.cursor.value,
          cursor.cursor.value,
          cursor.cursor.id,
        )
        const firstPinnedBind = binds.length - 4
        const repeatedPinnedBind = binds.length - 3
        const valueBind = binds.length - 2
        const repeatedValueBind = binds.length - 1
        const idBind = binds.length
        where += ` AND (n.is_pinned < ?${firstPinnedBind}
          OR (n.is_pinned = ?${repeatedPinnedBind} AND (
            ${valueColumn}${valueCollation} ${comparison} ?${valueBind}
            OR (${valueColumn}${valueCollation} = ?${repeatedValueBind} AND n.id > ?${idBind})
          )))`
      }
    }

    const pageFrom = cursor.kind === 'legacy'
      ? `FROM notes n WHERE ${where} ORDER BY ${orderBy}
         LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
      : `FROM notes n WHERE ${where} ORDER BY ${orderBy}
         LIMIT ?${binds.length + 1}`
    const pageBinds = cursor.kind === 'legacy'
      ? [...binds, limit + 1, cursor.offset]
      : [...binds, limit + 1]
    const listStatement = this.db.prepare(`SELECT ${NOTE_COLUMNS_NOTAGS} ${pageFrom}`).bind(...pageBinds)
    const tagStatement = this.db.prepare(noteTagsQueryForPage(pageFrom)).bind(...pageBinds)
    // A keyset page continues a listing the client already counted; re-counting scans every
    // visible row (up to LIMITS.notesMaxPerUser) again on each page turn.
    const countTotal = cursor.kind !== 'keyset'
    const results = await this.db.batch(countTotal
      ? [
          this.db.prepare(`SELECT COUNT(*) AS total FROM notes n WHERE ${countWhere}`).bind(...countBinds),
          listStatement,
          tagStatement,
        ]
      : [listStatement, tagStatement])
    const [countResult, listResult, tagResult] = countTotal
      ? results
      : [undefined, results[0], results[1]]

    const total = countTotal
      ? Number((countResult?.results?.[0] as { total?: unknown } | undefined)?.total ?? 0)
      : null
    const rows = (listResult?.results as NoteRow[] | undefined) ?? []
    attachNoteTags(rows, (tagResult?.results as NoteTagRow[] | undefined) ?? [])
    return { rows, total }
  }

  // ------------------------------------------------------------------ reads

  /**
   * One note of this account, tags and body included.
   *
   * `null` means "not this account's or not there", which is the same 404 either way: the route must
   * not be able to tell another account's note id apart from a missing one.
   */
  async noteRow(id: string): Promise<NoteRow | null> {
    const row = await this.db
      .prepare(`SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`)
      .bind(id, this.userId)
      .first<NoteRow>()
    return row ?? null
  }

  /**
   * Just the title, for the panels that show a note's surroundings rather than the note.
   *
   * `liveOnly` drops trashed notes: linking a mention into a note that is in the trash would edit
   * text nobody can reach, while the backlink panel still has to answer for a trashed note.
   */
  async noteTitle(id: string, options: { liveOnly?: boolean } = {}): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT title FROM notes WHERE id = ?1 AND user_id = ?2${options.liveOnly ? ' AND deleted_at IS NULL' : ''}`,
      )
      .bind(id, this.userId)
      .first<{ title: string }>()
    return row?.title ?? null
  }

  /**
   * Whether any account already owns this id.
   *
   * Deliberately the one statement here without a `user_id` filter: it answers a client-supplied id
   * collision, which is only meaningful across accounts. It reads a single column of a row the caller
   * cannot address any other way, and the caller has already failed the same id against its own note.
   */
  async idTakenByAnyone(id: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT user_id FROM notes WHERE id = ?1`)
      .bind(id)
      .first<{ user_id: string }>()
    return row !== null
  }

  /**
   * The newest `delete` change recorded for a note.
   *
   * Returned to a client that asked for a note it already deleted, so it can advance its cursor past
   * the deletion instead of refetching the note forever.
   */
  async latestDeletionSeq(id: string): Promise<number | null> {
    const row = await this.db
      .prepare(
        `SELECT MAX(seq) AS seq FROM changes
          WHERE user_id = ?1 AND entity = 'note' AND entity_id = ?2 AND op = 'delete'`,
      )
      .bind(this.userId, id)
      .first<{ seq: number | null }>()
    return row?.seq ?? null
  }

  /** Whether the account owns a live folder — the only check a note's `folderId` needs. */
  async folderExists(folderId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT id FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`)
      .bind(folderId, this.userId)
      .first<{ id: string }>()
    return row !== null
  }

  // ----------------------------------------------------------------- writes

  /**
   * A note to create: every column the route has already validated and derived.
   *
   * `contentHash`, `excerpt`, `words` and `chars` are computed by the route because they are rules
   * about the text, not about the row; the store must not be the place that decides them twice.
   */
  async create(input: NoteCreateInput): Promise<NoteWriteResult> {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO notes (id, user_id, folder_id, title, content, excerpt, rev, word_count, char_count,
         is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 0, ?9, 0, ?10, ?11, ?12, ?12)`,
    )
      .bind(
        input.id, this.userId, input.folderId, input.title, input.content, input.excerpt,
        input.words, input.chars, input.isStarred ? 1 : 0, input.now, input.contentHash, input.now,
      )
    const derived = buildNoteDerivedStatements({
      db: this.db,
      userId: this.userId,
      noteId: input.id,
      title: input.title,
      content: input.content,
      ftsEnabled: this.ftsEnabled,
      expectedRev: 1,
      expectedContentHash: input.contentHash,
      expectedTitle: input.title,
      expectedUpdatedAt: input.now,
    }).statements
    const createChange = this.db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE EXISTS (
          SELECT 1 FROM notes
           WHERE id = ?2 AND user_id = ?1 AND rev = 1
             AND content_hash = ?4 AND title = ?5 AND created_at = ?3 AND updated_at = ?3
        )
       RETURNING seq`,
    ).bind(this.userId, input.id, input.now, input.contentHash, input.title)
    const readback = this.db.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
    ).bind(input.id, this.userId)
    // One batch: the `INSERT OR IGNORE`, its derived rows, the guarded change record and the readback
    // either all land against the same revision or none of them describe the note to anyone.
    const batchResults = await this.db.batch([
      insert,
      ...derived,
      noteIndexQueueStatement(this.db, this.userId, input.id, 'embed', input.now),
      createChange,
      readback,
    ])
    return {
      row: (batchResults.at(-1) as D1Result<NoteRow>).results?.[0] ?? null,
      changeSeq: (batchResults.at(-2) as D1Result<{ seq: number }>).results?.[0]?.seq,
      created: Boolean(batchResults[0]?.meta.changes),
    }
  }

  /**
   * A copy of an existing note, kept in the same folder and archive state as the original.
   *
   * Unlike `create` the insert is not `OR IGNORE`, and the change record is unconditional: the id was
   * chosen by this method or already proved free, so a lost race here is a real failure the route
   * reports after re-checking the id.
   */
  async duplicate(input: NoteDuplicateInput): Promise<NoteWriteResult> {
    const insert = this.db.prepare(
      `INSERT INTO notes (id, user_id, folder_id, title, content, excerpt, rev, word_count, char_count,
         is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 0, 0, ?9, ?10, ?11, ?12, ?12)`,
    )
      .bind(
        input.id, this.userId, input.folderId, input.title, input.content, input.excerpt,
        input.words, input.chars, input.isArchived, input.now, input.contentHash, input.now,
      )
    const derived = buildNoteDerivedStatements({
      db: this.db,
      userId: this.userId,
      noteId: input.id,
      title: input.title,
      content: input.content,
      ftsEnabled: this.ftsEnabled,
      expectedRev: 1,
      expectedContentHash: input.contentHash,
      expectedTitle: input.title,
      expectedUpdatedAt: input.now,
    }).statements
    const change = this.db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at) VALUES (?1, 'note', ?2, 'upsert', ?3) RETURNING seq`,
    ).bind(this.userId, input.id, input.now)
    const readback = this.db.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
    ).bind(input.id, this.userId)
    const batchResults = await this.db.batch([
      insert,
      ...derived,
      noteIndexQueueStatement(this.db, this.userId, input.id, 'embed', input.now),
      change,
      readback,
    ])
    return {
      row: (batchResults.at(-1) as D1Result<NoteRow>).results?.[0] ?? null,
      changeSeq: (batchResults.at(-2) as D1Result<{ seq: number }>).results?.[0]?.seq,
      created: true,
    }
  }

  // ---------------------------------------------------------------- versions

  /**
   * The revisions of one note, newest first, without their bodies.
   *
   * `length(CAST(content AS BLOB))` is the stored size in bytes rather than the JavaScript string
   * length the panel would otherwise have to fetch the body to learn.
   */
  async versions(noteId: string): Promise<NoteVersionMetaRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, note_id, title, length(CAST(content AS BLOB)) AS size, created_at FROM note_versions
           WHERE note_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT 100`,
      )
      .bind(noteId, this.userId)
      .all<NoteVersionMetaRow>()
    return results ?? []
  }

  /** One revision with its body, for the diff view. */
  async version(noteId: string, versionId: string): Promise<NoteVersionRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, note_id, title, content, length(CAST(content AS BLOB)) AS size, created_at FROM note_versions
           WHERE id = ?1 AND note_id = ?2 AND user_id = ?3`,
      )
      .bind(versionId, noteId, this.userId)
      .first<NoteVersionRow>()
    return row ?? null
  }

  /** Just what a restore needs from a revision — the listing route never pulls the body twice. */
  async versionContent(noteId: string, versionId: string): Promise<{ title: string; content: string } | null> {
    const row = await this.db
      .prepare(`SELECT title, content FROM note_versions WHERE id = ?1 AND note_id = ?2 AND user_id = ?3`)
      .bind(versionId, noteId, this.userId)
      .first<{ title: string; content: string }>()
    return row ?? null
  }

  /**
   * Write a revision back over the live note, keeping the text it replaces as a revision first.
   *
   * The revision rows are trimmed only after the new one exists, so a note at the revision ceiling
   * still loses its oldest entry rather than its current text.
   */
  async restoreVersion(input: VersionRestoreInput): Promise<NoteMutationResult> {
    const { noteId: id, current } = input
    const now = input.now
    const nextRev = current.rev + 1
    const mutationGuard = `EXISTS (SELECT 1 FROM notes
      WHERE id = ?1 AND user_id = ?2 AND rev = ?3
        AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
    const mutationValues = [id, this.userId, nextRev, input.contentHash, input.title, now] as const
    const update = this.db.prepare(
      `UPDATE notes SET content = ?1, title = ?2, excerpt = ?3, word_count = ?4, char_count = ?5,
         content_hash = ?6, rev = ?7, updated_at = ?8
         WHERE id = ?9 AND user_id = ?10 AND rev = ?11`,
    )
      .bind(
        input.content,
        input.title,
        input.excerpt,
        input.words,
        input.chars,
        input.contentHash,
        nextRev,
        now,
        id,
        this.userId,
        current.rev,
      )
    const snapshot = this.db.prepare(
      `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
        WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}`,
    ).bind(newId(), id, this.userId, current.title, current.content, utf8ByteLength(current.content), now, ...mutationValues)
    const trimVersions = this.db.prepare(
      `DELETE FROM note_versions WHERE note_id = ?1
         AND ${shiftSqlPlaceholders(mutationGuard, 1)}
         AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
    ).bind(id, ...mutationValues, LIMITS.versionsPerNote)
    const derived = buildNoteDerivedStatements({
      db: this.db,
      userId: this.userId,
      noteId: id,
      title: input.title,
      content: input.content,
      ftsEnabled: this.ftsEnabled,
      titleChanged: true,
      previousTitle: current.title,
      expectedRev: nextRev,
      expectedContentHash: input.contentHash,
      expectedTitle: input.title,
      expectedUpdatedAt: now,
      deleted: current.deleted_at !== null,
    }).statements
    const change = this.db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}
       RETURNING seq`,
    ).bind(this.userId, id, now, ...mutationValues)
    const readback = this.db.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
    ).bind(id, this.userId)
    const batchResults = await this.db.batch([
      update,
      snapshot,
      trimVersions,
      ...derived,
      noteIndexQueueStatement(this.db, this.userId, id, 'embed', now),
      change,
      readback,
    ])
    return {
      row: (batchResults.at(-1) as D1Result<NoteRow>).results?.[0] ?? null,
      changeSeq: (batchResults.at(-2) as D1Result<{ seq: number }>).results?.[0]?.seq,
      applied: Boolean(batchResults[0]?.meta.changes),
    }
  }

  // ----------------------------------------------------------------- updates

  /**
   * Apply one validated edit to a note, with the revision, derived rows and change record it implies.
   *
   * `columns` is the update's SET list, in the order the caller wrote it: the route decides which
   * columns actually differ from the row it read, and this decides how they reach the database.
   * `updated_at` and `rev` are appended here because every guarded write of this method ends with the
   * same revision the change record is later matched against.
   */
  async patch(input: NotePatchInput): Promise<NotePatchResult> {
    const { current, now } = input
    const id = current.id
    const nextRev = current.rev + 1
    const sets: string[] = []
    const binds: unknown[] = []
    for (const [column, value] of Object.entries(input.columns)) {
      binds.push(value)
      sets.push(`${column} = ?${binds.length}`)
    }
    binds.push(now)
    sets.push(`updated_at = ?${binds.length}`)
    binds.push(nextRev)
    sets.push(`rev = ?${binds.length}`)
    binds.push(id, this.userId, input.expectedRev)

    const mutationGuard = `EXISTS (SELECT 1 FROM notes
      WHERE id = ?1 AND user_id = ?2 AND rev = ?3
        AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
    const mutationValues = [id, this.userId, nextRev, input.contentHash, input.title, now] as const

    const update = this.db.prepare(
      `UPDATE notes SET ${sets.join(', ')}
        WHERE id = ?${binds.length - 2} AND user_id = ?${binds.length - 1} AND rev = ?${binds.length}`,
    ).bind(...binds)

    const statements: D1PreparedStatement[] = [update]
    let tags: string[] | null = null

    if (input.snapshot) {
      const snapshotId = newId()
      statements.push(
        this.db.prepare(
          `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
            WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}
              AND (?14 = 1
                   OR NOT EXISTS (SELECT 1 FROM note_versions WHERE note_id = ?2)
                   OR ?15 - COALESCE((SELECT MAX(created_at) FROM note_versions WHERE note_id = ?2), 0) > ?16
                   OR ?17 = 1)`,
        ).bind(
          snapshotId, id, this.userId, current.title, current.content, utf8ByteLength(current.content), now,
          ...mutationValues,
          input.snapshot.preserve ? 1 : 0, now, SNAPSHOT_INTERVAL_MS, input.snapshot.bigChange ? 1 : 0,
        ),
        this.db.prepare(
          `DELETE FROM note_versions WHERE note_id = ?1
             AND EXISTS (SELECT 1 FROM note_versions WHERE id = ?9)
             AND ${shiftSqlPlaceholders(mutationGuard, 1)}
             AND id IN (
               SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
        ).bind(id, ...mutationValues, LIMITS.versionsPerNote, snapshotId),
      )
    }

    if (input.derive) {
      const derived = buildNoteDerivedStatements({
        db: this.db,
        userId: this.userId,
        noteId: id,
        title: input.title,
        content: input.content,
        ftsEnabled: this.ftsEnabled,
        titleChanged: input.titleChanged,
        previousTitle: current.title,
        expectedRev: nextRev,
        expectedContentHash: input.contentHash,
        expectedTitle: input.title,
        expectedUpdatedAt: now,
      })
      statements.push(...derived.statements)
      tags = derived.tags
      // The automatic tags are rebuilt from the new body, so the ones this note no longer uses can go
      // — but only when the set really moved, or an unrelated save would prune tags another note needs.
      if (input.contentChanged && !sameTagSet(splitTags(current.tag_names), derived.tags)) {
        statements.push(
          this.db.prepare(
            `DELETE FROM tags WHERE user_id = ?1 AND is_manual = 0
               AND ${shiftSqlPlaceholders(mutationGuard, 1)}
               AND NOT EXISTS (SELECT 1 FROM note_tags WHERE tag_id = tags.id)`,
          ).bind(this.userId, ...mutationValues),
        )
      }
    }

    if (input.contentChanged || input.titleChanged) {
      statements.push(noteIndexQueueStatement(this.db, this.userId, id, 'embed', now))
    }

    // Whether another note already answers to either title decides the wiki-link rewrite, so
    // it rides along with the mutation instead of costing the rename path its own round trip.
    let ambiguityIndex = -1
    if (input.titleChanged) {
      ambiguityIndex = statements.length
      statements.push(this.db.prepare(
        `SELECT 1 AS found FROM notes
          WHERE user_id = ?1 AND id <> ?2 AND deleted_at IS NULL AND title_key IN (?3, ?4)
          LIMIT 1`,
      ).bind(this.userId, id, normalizeLinkKey(current.title), normalizeLinkKey(input.title)))
    }

    statements.push(
      this.db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'note', ?2, 'upsert', ?3
          WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}
         RETURNING seq`,
      ).bind(this.userId, id, now, ...mutationValues),
    )

    const results = await this.db.batch(statements)
    // The route answers with the row it already holds, patched with exactly what this batch wrote, so a
    // save costs one read rather than two — and the client's revision matches the server's either way.
    const nextTags = input.contentChanged ? (tags ?? extractTags(input.content)) : null
    const next: NoteRow = { ...current, ...input.columns, updated_at: now, rev: nextRev }
    if (nextTags !== null) next.tag_names = nextTags.join(String.fromCharCode(TAG_SEP_CODE))
    return {
      applied: Boolean(results[0]?.meta.changes),
      changeSeq: (results.at(-1) as D1Result<{ seq: number }>).results?.[0]?.seq,
      next,
      ambiguous: input.titleChanged && (results[ambiguityIndex]?.results?.length ?? 0) > 0,
    }
  }

  /**
   * Re-point the saved links at this note when its new title collides with another note's.
   *
   * The rename cannot rewrite other people's text — both titles would mean the same `[[link]]` — so
   * only the link table's resolved target moves, and only while the guarded row is still as written.
   */
  async retargetAmbiguousLinks(input: {
    noteId: string
    previousTitle: string
    title: string
    nextRev: number
    now: number
  }): Promise<void> {
    await this.db.prepare(
      `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
        WHERE user_id = ?1 AND target_key = ?2
          AND EXISTS (SELECT 1 FROM notes
            WHERE id = ?3 AND user_id = ?1 AND rev = ?4
              AND title = ?5 AND updated_at = ?6 AND deleted_at IS NULL)`,
    ).bind(
      this.userId,
      normalizeLinkKey(input.previousTitle),
      input.noteId,
      input.nextRev,
      input.title,
      input.now,
    ).run()
  }

  // ------------------------------------------------------------ trash, restore

  /** The next page of trashed ids, keyset-paged: a bulk purge must never hold the whole trash. */
  async trashedNoteIdsAfter(afterId: string, limit: number): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id > ?2
          ORDER BY id ASC LIMIT ?3`,
      )
      .bind(this.userId, afterId, limit)
      .all<{ id: string }>()
    return (results ?? []).map((row) => row.id)
  }

  /**
   * The newest change of any kind for this account.
   *
   * `undefined` when the account has none, which the caller passes on as "no cursor to report" —
   * not `0`, which would tell every other device to replay from the start of time.
   */
  async latestChangeSeq(): Promise<number | undefined> {
    const row = await this.db
      .prepare(`SELECT seq FROM changes WHERE user_id = ?1 ORDER BY seq DESC LIMIT 1`)
      .bind(this.userId)
      .first<{ seq: number }>()
    return row?.seq
  }

  /**
   * Purge one page of trashed notes through every dependent table.
   *
   * The caller reads the page, hands the ids over and gets the batch results back, because it counts
   * the notes actually deleted — the last statement of the batch, not the first.
   */
  async purgeTrashed(ids: string[], now: number): Promise<D1Result<unknown>[]> {
    return await this.db.batch(
      trashPurgeStatements(this.db, this.userId, JSON.stringify(ids), now, this.ftsEnabled),
    ) as D1Result<unknown>[]
  }

  /**
   * Move a live note to the trash.
   *
   * No readback: the caller answers with the row it already held, patched with the same `deleted_at`,
   * `updated_at` and `rev` this batch wrote, so the client's revision matches without a second query.
   */
  async trash(input: NoteTrashInput): Promise<NoteMutationResult> {
    const { current, now, nextRev } = input
    const id = current.id
    const guard = `EXISTS (SELECT 1 FROM notes
      WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND deleted_at IS NOT NULL)`
    const statements = [
      this.db.prepare(
        `UPDATE notes SET deleted_at = ?1, updated_at = ?1, rev = ?2
          WHERE id = ?3 AND user_id = ?4 AND rev = ?5 AND deleted_at IS NULL`,
      ).bind(now, nextRev, id, this.userId, current.rev),
      this.db.prepare(`DELETE FROM links WHERE source_note_id = ?1 AND ${shiftSqlPlaceholders(guard, 1)}`)
        .bind(id, id, this.userId, nextRev),
      this.db.prepare(
        `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
          WHERE target_note_id = ?1 AND user_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
      ).bind(id, this.userId, id, this.userId, nextRev),
    ]
    if (this.ftsEnabled) {
      statements.push(
        this.db.prepare(
           `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
            SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
            ${FTS_QUEUE_CONFLICT_SQL}`,
        ).bind(this.userId, id, now, id, this.userId, nextRev),
      )
    }
    statements.push(
      this.db.prepare(
        `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
         SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
           AND ${aiDeleteNeededSql('?1', '?2')}`,
      ).bind(this.userId, id, now, id, this.userId, nextRev),
    )
    statements.push(
      this.db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
         RETURNING seq`,
      ).bind(this.userId, id, now, id, this.userId, nextRev),
    )
    const results = await this.db.batch(statements)
    return {
      row: null,
      changeSeq: (results.at(-1) as D1Result<{ seq: number }>).results?.[0]?.seq,
      applied: Boolean(results[0]?.meta.changes),
    }
  }

  /**
   * Bring a trashed note back, rebuilding the derived rows the trash dropped.
   *
   * The restore re-derives tags, links and index rows from the body as if the title had changed, so a
   * note that comes back is searchable again without the client having to save it once more.
   */
  async restore(input: NoteRestoreInput): Promise<NoteMutationResult> {
    const { current, now, nextRev } = input
    const update = this.db.prepare(
      `UPDATE notes SET deleted_at = NULL, updated_at = ?1, rev = ?2
        WHERE id = ?3 AND user_id = ?4 AND rev = ?5 AND deleted_at IS NOT NULL`,
    ).bind(now, nextRev, current.id, this.userId, current.rev)
    const derived = buildNoteDerivedStatements({
      db: this.db,
      userId: this.userId,
      noteId: current.id,
      title: current.title,
      content: current.content,
      ftsEnabled: this.ftsEnabled,
      titleChanged: true,
      expectedRev: nextRev,
      expectedContentHash: current.content_hash,
      expectedTitle: current.title,
      expectedUpdatedAt: now,
    }).statements
    const change = this.db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE EXISTS (SELECT 1 FROM notes WHERE id = ?2 AND user_id = ?1 AND rev = ?4 AND deleted_at IS NULL)
       RETURNING seq`,
    ).bind(this.userId, current.id, now, nextRev)
    const readback = this.db.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
    ).bind(current.id, this.userId)
    const batchResults = await this.db.batch([
      update,
      ...derived,
      noteIndexQueueStatement(this.db, this.userId, current.id, 'embed', now),
      change,
      readback,
    ])
    return {
      row: (batchResults.at(-1) as D1Result<NoteRow>).results?.[0] ?? null,
      changeSeq: (batchResults.at(-2) as D1Result<{ seq: number }>).results?.[0]?.seq,
      applied: Boolean(batchResults[0]?.meta.changes),
    }
  }

  /**
   * Delete a trashed note for good, along with everything that pointed at it.
   *
   * Every statement is guarded on the same `id`/`user_id`/`rev`/`deleted_at` shape and the note delete
   * rides in the same batch, so a note that came back to life mid-request loses nothing. The orphaned
   * tags are pruned last: they can only be judged once this note's rows are gone.
   */
  async purge(current: NoteRow): Promise<{ changeSeq: number | undefined; deleted: boolean }> {
    const id = current.id
    const guard = `EXISTS (SELECT 1 FROM notes
      WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND deleted_at IS NOT NULL)`
    const guarded = (sql: string) => this.db
      .prepare(`${sql} AND ${shiftSqlPlaceholders(guard, 1)}`)
      .bind(id, id, this.userId, current.rev)
    const statements: D1PreparedStatement[] = [
      guarded(`DELETE FROM note_tags WHERE note_id = ?1`),
      guarded(`DELETE FROM links WHERE source_note_id = ?1`),
      this.db.prepare(
        `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
          WHERE target_note_id = ?1 AND user_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
      ).bind(id, this.userId, id, this.userId, current.rev),
      guarded(`DELETE FROM note_versions WHERE note_id = ?1`),
      this.db.prepare(
        `DELETE FROM mcp_operations
          WHERE user_id = ?1 AND instr(response_json, ?2) > 0
            AND ${shiftSqlPlaceholders(guard, 2)}`,
      ).bind(this.userId, id, id, this.userId, current.rev),
      this.db.prepare(
        `DELETE FROM share_asset_sessions
          WHERE slug IN (SELECT slug FROM shares WHERE note_id = ?1 AND user_id = ?2)
            AND ${shiftSqlPlaceholders(guard, 2)}`,
      ).bind(id, this.userId, id, this.userId, current.rev),
      guarded(`DELETE FROM shares WHERE note_id = ?1`),
      guarded(`UPDATE attachments SET note_id = NULL WHERE note_id = ?1`),
      this.db.prepare(
        `DELETE FROM import_mappings
          WHERE user_id = ?1 AND entity = 'note' AND target_id = ?2
            AND EXISTS (SELECT 1 FROM notes
              WHERE id = ?2 AND user_id = ?1 AND rev = ?3 AND deleted_at IS NOT NULL)`,
      ).bind(this.userId, id, current.rev),
    ]
    if (this.ftsEnabled) {
      statements.push(
        this.db.prepare(
           `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
            SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
            ${FTS_QUEUE_CONFLICT_SQL}`,
        ).bind(this.userId, id, Date.now(), id, this.userId, current.rev),
      )
    }
    statements.push(
      this.db.prepare(
        `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
         SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
           AND ${aiDeleteNeededSql('?1', '?2')}`,
      ).bind(this.userId, id, Date.now(), id, this.userId, current.rev),
    )
    statements.push(
      this.db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'note', ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
         RETURNING seq`,
      ).bind(this.userId, id, Date.now(), id, this.userId, current.rev),
      this.db.prepare(
        `DELETE FROM notes WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND deleted_at IS NOT NULL`,
      ).bind(id, this.userId, current.rev),
      this.db.prepare(`DELETE FROM tags
        WHERE user_id = ?1 AND is_manual = 0
          AND NOT EXISTS (SELECT 1 FROM note_tags WHERE tag_id = tags.id)`)
        .bind(this.userId),
    )
    const results = await this.db.batch(statements)
    return {
      changeSeq: (results.at(-3) as D1Result<{ seq: number }>).results?.[0]?.seq,
      deleted: Boolean(results.at(-2)?.meta.changes),
    }
  }
}

/** Whether two tag listings hold the same names, ignoring order. */
function sameTagSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((name) => set.has(name))
}

/**
 * The dependent-table cleanup for one page of trashed note ids, in the order the cascade
 * needs: link retargeting before the notes go, share sessions before their shares.
 * Statements bind `?1` = account, `?2` = JSON id page (the note_tags delete has no account
 * column to filter, so it takes the id page as `?1`), `?3` = timestamp.
 *
 * A free function rather than a method because the bulk purge builds it per page and the batch test
 * builds it directly: neither wants a store that exists only to hold a connection.
 */
export function trashPurgeStatements(
  db: D1Database,
  userId: string,
  idsJson: string,
  now: number,
  ftsEnabled: boolean,
): D1PreparedStatement[] {
  const inTrash = `IN (SELECT value FROM json_each(?2))`
  const statements = [
    db.prepare(
      `DELETE FROM mcp_operations WHERE user_id = ?1 AND EXISTS (
         SELECT 1 FROM json_each(?2) e WHERE instr(mcp_operations.response_json, e.value) > 0)`,
    ).bind(userId, idsJson),
    db.prepare(`DELETE FROM note_tags WHERE note_id IN (SELECT value FROM json_each(?1))`).bind(idsJson),
    db.prepare(`DELETE FROM links WHERE user_id = ?1 AND source_note_id ${inTrash}`).bind(userId, idsJson),
    db.prepare(
      `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
        WHERE user_id = ?1 AND target_note_id ${inTrash}`,
    ).bind(userId, idsJson),
    db.prepare(`DELETE FROM note_versions WHERE user_id = ?1 AND note_id ${inTrash}`).bind(userId, idsJson),
    db.prepare(
      `DELETE FROM share_asset_sessions WHERE slug IN (
         SELECT slug FROM shares WHERE user_id = ?1 AND note_id ${inTrash}
       )`,
    ).bind(userId, idsJson),
    db.prepare(`DELETE FROM shares WHERE user_id = ?1 AND note_id ${inTrash}`).bind(userId, idsJson),
    db.prepare(`UPDATE attachments SET note_id = NULL WHERE user_id = ?1 AND note_id ${inTrash}`).bind(userId, idsJson),
    db.prepare(
      `DELETE FROM import_mappings WHERE user_id = ?1 AND entity = 'note' AND target_id ${inTrash}`,
    ).bind(userId, idsJson),
  ]
  if (ftsEnabled) {
    statements.push(
      db.prepare(
        `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
         SELECT ?1, id, 'delete', ?3
           FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id ${inTrash}
         ${FTS_QUEUE_CONFLICT_SQL}`,
      ).bind(userId, idsJson, now),
    )
  }
  statements.push(
    db.prepare(
      `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
       SELECT ?1, id, 'delete', ?3
         FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id ${inTrash}
           AND ${aiDeleteNeededSql('?1', 'notes.id')}`,
    ).bind(userId, idsJson, now),
    db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', id, 'delete', ?3
         FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id ${inTrash}`,
    ).bind(userId, idsJson, now),
    db.prepare(
      `DELETE FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL AND id ${inTrash}`,
    ).bind(userId, idsJson),
  )
  return statements
}

export type LinkMentionOutcome =
  | { status: 'linked'; row: NoteRow; cursor: number | undefined }
  | { status: 'no-mention' }
  | { status: 'missing' }
  | { status: 'conflict' }

export async function linkMentionInNote(
  db: D1Database,
  userId: string,
  sourceNoteId: string,
  title: string,
  ftsEnabled: boolean,
): Promise<LinkMentionOutcome> {
  const load = () => db.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
  ).bind(sourceNoteId, userId).first<NoteRow>()
  let current = await load()
  if (!current || current.deleted_at !== null) return { status: 'missing' }
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = linkFirstMention(current.content, title)
    if (content === current.content) return { status: 'no-mention' }
    const hash = await sha256Hex(content)
    const { words, chars } = countText(content)
    const now = Math.max(Date.now(), current.updated_at + 1)
    const nextRev = current.rev + 1
    const guard = `EXISTS (SELECT 1 FROM notes
      WHERE id = ?1 AND user_id = ?2 AND rev = ?3
        AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
    const guardValues = [current.id, userId, nextRev, hash, current.title, now] as const
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `UPDATE notes SET content = ?1, excerpt = ?2, word_count = ?3, char_count = ?4,
           content_hash = ?5, rev = ?6, updated_at = ?7
          WHERE id = ?8 AND user_id = ?9 AND rev = ?10 AND content_hash = ?11`,
      ).bind(content, deriveExcerpt(content), words, chars, hash, nextRev, now,
        current.id, userId, current.rev, current.content_hash),
      db.prepare(
        `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${shiftSqlPlaceholders(guard, 7)}`,
      ).bind(newId(), current.id, userId, current.title, current.content,
        utf8ByteLength(current.content), now, ...guardValues),
      db.prepare(
        `DELETE FROM note_versions WHERE note_id = ?1
           AND ${shiftSqlPlaceholders(guard, 1)}
           AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
      ).bind(current.id, ...guardValues, LIMITS.versionsPerNote),
    ]
    statements.push(...buildNoteDerivedStatements({
      db,
      userId,
      noteId: current.id,
      title: current.title,
      content,
      ftsEnabled,
      expectedRev: nextRev,
      expectedContentHash: hash,
      expectedTitle: current.title,
      expectedUpdatedAt: now,
    }).statements)
    statements.push(noteIndexQueueStatement(db, userId, current.id, 'embed', now))
    statements.push(
      db.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
         RETURNING seq`,
      ).bind(userId, current.id, now, ...guardValues),
    )
    const results = await db.batch(statements)
    if (results[0]?.meta.changes) {
      const row = await load()
      if (!row) return { status: 'missing' }
      const change = results.at(-1)?.results?.[0] as { seq?: number } | undefined
      return { status: 'linked', row, cursor: change?.seq }
    }
    current = await load()
    if (!current || current.deleted_at !== null) return { status: 'missing' }
  }
  return { status: 'conflict' }
}


/**
 * The notes whose `[[wikilinks]]` the link table already points at this one, each with
 * the text around the link.
 *
 * The window is cut from `hit`, so the column has to survive the outer projection: it
 * did not, and every context came back empty until a test read the row keys.
 */
/**
 * The sentence around a mention, or `null` when the row does not actually carry one.
 *
 * Two reasons not to trust the index pass: SQLite's `lower()` folds ASCII characters only,
 * so a mention written with an accented or Cyrillic capital gives `hit` 0 and leaves the
 * window parked at the top of the note; and the full-text index matches token neighbours,
 * not characters, so it can offer a note where the words only happen to sit next to each
 * other. `foldIndexOf` is exact and length-preserving, so one check answers both.
 */
function mentionExcerpt(window: string, hit: number, len: number, needle: string): string | null {
  const body = trimFrontMatterLead(window)
  const found = foldIndexOf(body, needle)
  if (found < 0) return null
  const from = Math.max(0, found - 60)
  const to = Math.min(body.length, found + needle.length + 90)
  // `trimFrontMatterLead` only ever removes a prefix, so the difference in length is how
  // much of the note the window already left behind.
  const dropped = (hit > 0 ? Math.max(hit - 61, 0) : 0) + (window.length - body.length)
  const headCut = dropped + from > 0
  const tailCut = dropped + to < len
  return (headCut ? '…' : '') + plainLinkText(body.slice(from, to)).replace(/\s+/g, ' ').trim() + (tailCut ? '…' : '')
}

/**
 * How far into a note the retry scan looks for a mention the cheap index pass could not
 * place. Sized to cover most notes whole, and applied only to the few rows per page that
 * need it, so the panel never pulls a body at the content limit.
 */
const MENTION_RETRY_SCAN_CHARS = 4000

function backlinkContext(window: string, hit: number, len: number, needle: string): string {
  const located = mentionExcerpt(window, hit, len, needle)
  // A backlink is known from the link table, so the row stays even when the excerpt could
  // not be placed on it; the head of the note is the honest fallback.
  return located ?? plainLinkText(truncateText(window, 120).replace(/\s+/g, ' ').trim())
}

/**
 * The letters SQLite's `lower()` cannot fold, spelled out as `replace()` arguments.
 *
 * `lower()` covers ASCII; `foldCase` covers every letter with a single-code-unit lowercase.
 * The gap between them is exactly this list, so folding the column with these pairs and the
 * needle with `foldCase` leaves both sides in the same alphabet. Capped at twelve pairs: a
 * title made of exotic letters would build a `replace()` chain longer than the scan is worth,
 * and the caller's retry pass picks up what the cap drops.
 */
function caseFoldPairs(title: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const char of title) {
    const folded = foldCase(char)
    if (folded.length !== 1) continue
    for (const variant of [char, char.toUpperCase()]) {
      if (variant.length !== 1 || variant === folded || variant.charCodeAt(0) < 0x80) continue
      if (!pairs.some(([from]) => from === variant)) pairs.push([variant, folded])
    }
  }
  return pairs.slice(0, 12)
}

/** `expression`, folded down to the alphabet `foldCase` reports for `title`. */
function foldSql(expression: string, pairs: Array<[string, string]>, firstSlot: number): string {
  return pairs.reduce(
    (sql, _pair, index) => `replace(${sql}, ?${firstSlot + index * 2}, ?${firstSlot + index * 2 + 1})`,
    expression,
  )
}

export async function findLinkedBacklinks(
  db: D1Database,
  userId: string,
  target: { id: string; title: string },
): Promise<Array<{ id: string; title: string; context: string }>> {
  const needle = `[[${target.title}`
  const pairs = caseFoldPairs(target.title)
  // One fold and one instr per row: SQLite does not share the repeated subexpression
  // across the references below.
  const { results } = await db.prepare(
    `SELECT id, title, hit, len,
       substr(content, MAX(hit - 60, 1), ?4) AS window
     FROM (
       SELECT n.id AS id, n.title AS title, n.content AS content,
              instr(${foldSql('lower(n.content)', pairs, 5)}, ?3) AS hit, length(n.content) AS len
         FROM links l
           JOIN notes n ON n.id = l.source_note_id
        WHERE l.user_id = ?1 AND l.target_note_id = ?2
          AND n.deleted_at IS NULL AND n.id != ?2
        ORDER BY n.updated_at DESC LIMIT 50
     )`,
  )
    .bind(userId, target.id, foldCase(needle), needle.length + 150, ...pairs.flat())
    .all<{ id: string; title: string; hit: number; len: number; window: string }>()

  return results.map((row) => ({
    id: row.id,
    title: row.title,
    context: backlinkContext(row.window, row.hit, row.len, needle),
  }))
}


/**
 * Notes that say the target's title in their text without linking to it.
 *
 * The full-text index finds the candidates and `mentionExcerpt` confirms the literal phrase:
 * the index is tokenised and case-folded, so it can offer a note where the words only
 * happen to sit next to each other, and a mention the reader cannot see is worse than a
 * shorter list. Notes that already carry a `[[title]]` are left to the linked half of the
 * panel, since a row would otherwise show up twice with two different meanings.
 *
 * The index pass over-fetches by three because the confirmation drops rows the index should
 * not have offered, and a candidate whose mention the first window missed gets one more look
 * at its first `MENTION_RETRY_SCAN_CHARS` characters, which is where an accented or Cyrillic
 * capital that SQLite could not fold usually lives. Without the index the same answer comes
 * from scanning every body, which is what the search endpoint already falls back to.
 */
export async function findUnlinkedMentions(
  db: D1Database,
  userId: string,
  target: { id: string; title: string },
  ftsEnabled: boolean,
  limit: number,
): Promise<Array<{ id: string; title: string; context: string }>> {
  const title = target.title.trim()
  if (Array.from(title).length < LIMITS.mentionMinChars)
    return []
  const match = ftsEnabled ? buildFtsQuery([title]) : ''
  if (ftsEnabled && !match)
    return []
  const needle = title
  const pairs = caseFoldPairs(title)
  // ?1 is the match expression only when the index is in play, so every later slot shifts.
  const k = ftsEnabled ? 1 : 0
  const { results } = await db
    .prepare(
      `SELECT id, title, hit, len,
         substr(content, MAX(hit - 60, 1), ?${4 + k}) AS window
       FROM (
         SELECT n.id AS id, n.title AS title, n.content AS content,
                instr(${foldSql('lower(n.content)', pairs, 6 + k)}, ?${3 + k}) AS hit, length(n.content) AS len
           ${ftsEnabled ? 'FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id AND n.user_id = notes_fts.user_id' : 'FROM notes n'}
          ${ftsEnabled ? 'WHERE notes_fts MATCH ?1 AND notes_fts.user_id = ?2 AND n.user_id = ?2' : 'WHERE n.user_id = ?1'}
            ${ftsEnabled ? '' : `AND instr(${foldSql('lower(n.content)', pairs, 6 + k)}, ?${3 + k}) > 0`}
            AND n.deleted_at IS NULL
            AND n.id != ?${2 + k}
            AND NOT EXISTS (
              SELECT 1 FROM links l
               WHERE l.user_id = ?${1 + k} AND l.source_note_id = n.id AND l.target_note_id = ?${2 + k}
            )
         ORDER BY n.updated_at DESC, n.id ASC
         LIMIT ?${5 + k}
       )`,
    )
    .bind(...(ftsEnabled
      ? [match, userId, target.id, foldCase(needle), needle.length + 150, limit * 3, ...pairs.flat()]
      : [userId, target.id, foldCase(needle), needle.length + 150, limit * 3, ...pairs.flat()]))
    .all<{ id: string; title: string; hit: number; len: number; window: string }>()

  const found = new Map<string, string>()
  const missed: Array<{ id: string; len: number }> = []
  for (const row of results) {
    const context = mentionExcerpt(row.window, row.hit, row.len, needle)
    if (context === null) missed.push({ id: row.id, len: row.len })
    else found.set(row.id, context)
  }

  if (missed.length) {
    const placeholders = missed.map((_, index) => `?${index + 3}`).join(', ')
    const { results: heads } = await db.prepare(
      `SELECT id, title, length(content) AS len, substr(content, 1, ?2) AS window
         FROM notes WHERE user_id = ?1 AND id IN (${placeholders})`,
    ).bind(userId, MENTION_RETRY_SCAN_CHARS, ...missed.map((row) => row.id))
      .all<{ id: string; title: string; len: number; window: string }>()
    for (const head of heads) {
      if (found.size >= limit) break
      const context = mentionExcerpt(head.window, 0, head.len, needle)
      if (context !== null) found.set(head.id, context)
    }
  }

  const order = new Map(results.map((row, index) => [row.id, index]))
  return [...found.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .slice(0, limit)
    .map(([id, context]) => ({ id, title: results.find((row) => row.id === id)?.title ?? '', context }))
}

export async function rewriteInboundWikiLinks(
  db: D1Database,
  userId: string,
  targetNoteId: string,
  fromTitle: string,
  toTitle: string,
  ftsEnabled: boolean,
  forceInline = false,
  budgetNotes = Number.POSITIVE_INFINITY,
): Promise<{ rewritten: number; skipped: number; deferred: number; remaining: number }> {
  const previousKey = normalizeLinkKey(fromTitle)
  const { results: candidates } = await db.prepare(
    `SELECT DISTINCT n.id FROM links l
      JOIN notes n ON n.id = l.source_note_id AND n.user_id = l.user_id
     WHERE l.user_id = ?1 AND l.target_note_id = ?2 AND l.target_key = ?3
       AND n.id <> ?2 AND n.deleted_at IS NULL`,
  ).bind(userId, targetNoteId, previousKey).all<{ id: string }>()
  if (!candidates.length) return { rewritten: 0, skipped: 0, deferred: 0, remaining: 0 }
  if (!forceInline && candidates.length > INLINE_REWRITE_LIMIT) {
    await db.batch([
      rewriteQueueStatement(db, userId, 'note-title', targetNoteId, fromTitle, toTitle),
    ])
    return { rewritten: 0, skipped: 0, deferred: candidates.length, remaining: 0 }
  }
  let rewritten = 0
  let skipped = 0

  const candidateIds = candidates.map((c) => c.id)
  const plan = Number.isFinite(budgetNotes) ? candidateIds.slice(0, budgetNotes) : candidateIds
  const remaining = candidateIds.length - plan.length
  type CandidateNoteRecord = {
    id: string
    title: string
    content: string
    content_hash: string
    rev: number
    updated_at: number
    deleted_at: number | null
  }
  // Load and rewrite in small windows: a hub note referenced by thousands of others must
  // not pin every candidate body in the isolate before the first write happens.
  for (let start = 0; start < plan.length; start += REWRITE_LOAD_CHUNK) {
    const windowIds = plan.slice(start, start + REWRITE_LOAD_CHUNK)
    const placeholders = windowIds.map((_, idx) => `?${idx + 2}`).join(', ')
    const { results: loaded } = await db.prepare(
      `SELECT id, title, content, content_hash, rev, updated_at, deleted_at
         FROM notes WHERE user_id = ?1 AND id IN (${placeholders})`,
    ).bind(userId, ...windowIds).all<CandidateNoteRecord>()
    const notesToRewrite = loaded.filter((note) => note.deleted_at === null
      && replaceWikiLinkTarget(note.content, fromTitle, toTitle) !== note.content)
    skipped += loaded.length - notesToRewrite.length
    for (let i = 0; i < notesToRewrite.length; i += REWRITE_CONCURRENCY) {
      const batch = notesToRewrite.slice(i, i + REWRITE_CONCURRENCY)
      const outcomes = await Promise.all(
        batch.map(async (initialNote) => {
          let currentNote: CandidateNoteRecord | null = initialNote
          for (let attempt = 0; attempt < 5; attempt++) {
            if (!currentNote || currentNote.deleted_at !== null) return false
            const content = replaceWikiLinkTarget(currentNote.content, fromTitle, toTitle)
            if (content === currentNote.content) return true
            const hash = await sha256Hex(content)
            const { words, chars } = countText(content)
            const now = Math.max(Date.now(), currentNote.updated_at + 1)
            const nextRev = currentNote.rev + 1
            const guard = `EXISTS (SELECT 1 FROM notes
              WHERE id = ?1 AND user_id = ?2 AND rev = ?3
                AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
            const guardValues = [currentNote.id, userId, nextRev, hash, currentNote.title, now] as const
            const statements: D1PreparedStatement[] = [
              db.prepare(
                `UPDATE notes SET content = ?1, excerpt = ?2, word_count = ?3, char_count = ?4,
                   content_hash = ?5, rev = ?6, updated_at = ?7
                  WHERE id = ?8 AND user_id = ?9 AND rev = ?10 AND content_hash = ?11`,
              ).bind(content, deriveExcerpt(content), words, chars, hash, nextRev, now,
                currentNote.id, userId, currentNote.rev, currentNote.content_hash),
              db.prepare(
                `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${shiftSqlPlaceholders(guard, 7)}`,
              ).bind(newId(), currentNote.id, userId, currentNote.title, currentNote.content,
                utf8ByteLength(currentNote.content), now, ...guardValues),
              db.prepare(
                `DELETE FROM note_versions WHERE note_id = ?1
                   AND ${shiftSqlPlaceholders(guard, 1)}
                   AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
              ).bind(currentNote.id, ...guardValues, LIMITS.versionsPerNote),
            ]
            statements.push(...buildNoteDerivedStatements({
              db,
              userId,
              noteId: currentNote.id,
              title: currentNote.title,
              content,
              ftsEnabled,
              expectedRev: nextRev,
              expectedContentHash: hash,
              expectedTitle: currentNote.title,
              expectedUpdatedAt: now,
            }).statements)
            statements.push(noteIndexQueueStatement(db, userId, currentNote.id, 'embed', now))
            statements.push(
              db.prepare(
                `INSERT INTO changes (user_id, entity, entity_id, op, at)
                 SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}`,
              ).bind(userId, currentNote.id, now, ...guardValues),
            )
            const [updated] = await db.batch(statements)
            if (updated?.meta.changes) {
              return true
            }
            currentNote = await db.prepare(
              `SELECT id, title, content, content_hash, rev, updated_at, deleted_at
                 FROM notes WHERE id = ?1 AND user_id = ?2`,
            ).bind(currentNote.id, userId).first<CandidateNoteRecord>()
          }
          return false
        }),
      )
    for (const success of outcomes) {
      if (success) rewritten++
      else skipped++
    }
    }
  }
  return { rewritten, skipped, deferred: 0, remaining }
}
