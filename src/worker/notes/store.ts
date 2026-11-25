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
  likePattern,
  normalizeLinkKey,
  parseFrontMatter,
  setFrontMatterValue,
  sortTagNames,
} from '@shared/markdown-utils'
import { utf8ByteLength } from '@shared/text-utils'
import type { NotePropertyTablePage } from '@shared/types'
import {
  NOTE_COLUMNS_FULL,
  NOTE_COLUMNS_NOTAGS,
  TAG_SEP_CODE,
  attachNoteTags,
  noteTagsQueryForPage,
  splitTags,
  tagScopePredicate,
  toNoteSummary,
  type NoteRow,
  type NoteTagRow,
} from '../db/rows'
import {
  FTS_QUEUE_CONFLICT_SQL,
  LINK_TARGET_SUBQUERY,
  buildNoteDerivedStatements,
  shiftSqlPlaceholders,
} from '../db/writes'
import { FTS_NOTE_MATCH_SQL } from '../db/fts'
import { aiDeleteNeededSql, noteIndexQueueStatement } from '../mcp/ai-search'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'
import { versionRetentionOffsetSql } from './version-policy'
import { trashPurgeStatements } from './notes-purge'
import type {
  NoteCreateInput,
  NoteDuplicateInput,
  NoteMergeInput,
  NoteMergeResult,
  NoteMutationResult,
  NotePatchInput,
  NotePatchResult,
  NoteRestoreInput,
  NotesListPage,
  NotesListQuery,
  NoteTrashInput,
  NoteVersionMetaRow,
  NoteVersionRow,
  NoteWriteResult,
  VersionRestoreInput,
} from './notes-types'

export type {
  NoteCreateInput,
  NoteDuplicateInput,
  NoteMergeInput,
  NoteMergeResult,
  NoteMutationResult,
  NotePatchColumns,
  NotePatchInput,
  NotePatchResult,
  NoteRestoreInput,
  NotesListCursor,
  NotesListPage,
  NotesListQuery,
  NoteTrashInput,
  NoteVersionMetaRow,
  NoteVersionRow,
  NoteWriteResult,
  ParsedNotesListCursor,
  VersionRestoreInput,
} from './notes-types'
export { trashPurgeStatements } from './notes-purge'
export {
  findLinkedBacklinks,
  findUnlinkedMentions,
  linkMentionInNote,
  rewriteInboundWikiLinks,
  type LinkMentionOutcome,
} from './notes-links'

/** How long a note's previous text is kept only when the edit was big or asked for it. */
const SNAPSHOT_INTERVAL_MS = LIMITS.versionSnapshotIntervalMs

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
    if (view === 'pinned') where += ' AND n.is_pinned = 1'
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

  async propertyTablePage(afterId: string, limit: number, query = ''): Promise<NotePropertyTablePage> {
    const binds: unknown[] = [this.userId, afterId, limit + 1]
    let titleFilter = ''
    if (query) {
      binds.push(likePattern(query))
      titleFilter = ` AND n.title LIKE ?${binds.length} ESCAPE '\\'`
    }
    const noteRows = (await this.db.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n
        WHERE n.user_id = ?1 AND n.id > ?2 AND n.deleted_at IS NULL AND n.is_encrypted = 0${titleFilter}
        ORDER BY n.id ASC LIMIT ?3`,
    ).bind(...binds).all<NoteRow>()).results
    const page = noteRows.slice(0, limit)
    if (!page.length) return { rows: [], nextCursor: null }
    const ids = page.map((row) => row.id)
    const placeholders = ids.map(() => '?').join(', ')
    const propertyRows = (await this.db.prepare(
      `SELECT note_id, key, key_key, ordinal, kind, is_array, value_text, value_number, value_boolean, value_date
         FROM note_properties WHERE user_id = ? AND note_id IN (${placeholders})
         ORDER BY note_id ASC, key_key ASC, ordinal ASC`,
    ).bind(this.userId, ...ids).all<{
      note_id: string
      key: string
      key_key: string
      ordinal: number
      kind: string
      is_array: number
      value_text: string | null
      value_number: number | null
      value_boolean: number | null
      value_date: number | null
    }>()).results
    const grouped = new Map<string, Map<string, typeof propertyRows>>()
    for (const row of propertyRows) {
      let note = grouped.get(row.note_id)
      if (!note) {
        note = new Map()
        grouped.set(row.note_id, note)
      }
      const values = note.get(row.key_key) ?? []
      values.push(row)
      note.set(row.key_key, values)
    }
    const rows = page.map((note) => {
      const properties: Record<string, unknown> = {}
      for (const values of grouped.get(note.id)?.values() ?? []) {
        const first = values[0]!
        const decoded = values.map((row) => row.kind === 'number'
          ? row.value_number
          : row.kind === 'boolean'
            ? row.value_boolean === 1
            : row.value_text ?? '')
        properties[first.key] = first.is_array === 1
          ? values.length === 1 && decoded[0] === '' ? [] : decoded
          : decoded[0]
      }
      return { note: toNoteSummary(note), properties }
    })
    return { rows, nextCursor: noteRows.length > limit ? page[page.length - 1]!.id : null }
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
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 0, ?9, 0, ?10, ?11, ?12, ?12
        WHERE ?3 IS NULL OR EXISTS (
          SELECT 1 FROM folders WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL
        )`,
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

  async merge(input: NoteMergeInput): Promise<NoteMergeResult> {
    const { target, sources, now } = input
    const targetTags = sortTagNames([...new Set([...splitTags(target.tag_names), ...extractTags(target.content)])])
    const mergedTags = sortTagNames([...new Set([
      ...targetTags,
      ...sources.flatMap((source) => [...splitTags(source.tag_names), ...extractTags(source.content)]),
    ])])
    const sections = [
      target.content.trimEnd(),
      ...sources.map((source) => {
        const title = source.title.replace(/\s+/g, ' ').trim()
        const body = parseFrontMatter(source.content).body.trim()
        return `## ${title}${body ? `\n\n${body}` : ''}`
      }),
    ].filter(Boolean)
    let content = sections.join('\n\n---\n\n')
    if (JSON.stringify(mergedTags) !== JSON.stringify(targetTags))
      content = setFrontMatterValue(content, 'tags', mergedTags)
    if (utf8ByteLength(content) > LIMITS.contentMaxBytes)
      return { row: target, changeSeq: undefined, applied: false, merged: 0, tooLarge: true }

    const contentHash = await sha256Hex(content)
    const { words, chars } = countText(content)
    const sourceIds = sources.map((source) => source.id)
    const sourceKeys = sources.map((source) => normalizeLinkKey(source.title))
    const sourceValues = sources.flatMap((source) => [source.id, this.userId, source.rev])
    const sourceChecks = sources.map(() =>
      'EXISTS (SELECT 1 FROM notes WHERE id = ? AND user_id = ? AND rev = ? AND deleted_at IS NULL)').join(' AND ')
    const sourceIdsJson = JSON.stringify(sourceIds)
    const idPlaceholders = sourceIds.map(() => '?').join(', ')
    const keyPlaceholders = sourceKeys.map(() => '?').join(', ')
    const targetKey = normalizeLinkKey(target.title)
    const guardedMove = (table: string, column: string) => this.db.prepare(
      `UPDATE ${table} SET ${column} = ? WHERE user_id = ? AND ${column} IN (${idPlaceholders})
        AND (${sourceChecks})`,
    ).bind(target.id, this.userId, ...sourceIds, ...sourceValues)

    const retargetLinks = this.db.prepare(
      `UPDATE links SET target_note_id = ?, target_key = ?, target_title = ?
        WHERE user_id = ? AND (target_note_id IN (${idPlaceholders}) OR target_key IN (${keyPlaceholders}))
          AND (${sourceChecks})`,
    ).bind(target.id, targetKey, target.title, this.userId, ...sourceIds, ...sourceKeys, ...sourceValues)
    const prefixStatements = [
      guardedMove('attachments', 'note_id'),
      guardedMove('note_versions', 'note_id'),
      guardedMove('chat_artifacts', 'note_id'),
      guardedMove('chat_conversations', 'note_id'),
      guardedMove('chat_memories', 'note_id'),
      guardedMove('chat_runs', 'note_id'),
      this.db.prepare(
        `UPDATE blog_pages SET published_at = NULL WHERE user_id = ? AND note_id IN (${idPlaceholders})
          AND (${sourceChecks})`,
      ).bind(this.userId, ...sourceIds, ...sourceValues),
      this.db.prepare(
        `UPDATE blog_posts SET status = 'withdrawn' WHERE user_id = ? AND note_id IN (${idPlaceholders})
          AND (${sourceChecks})`,
      ).bind(this.userId, ...sourceIds, ...sourceValues),
    ]
    const suffixStatements = [
      retargetLinks,
      this.db.prepare(
        `UPDATE notes SET deleted_at = ?, updated_at = ?, rev = rev + 1
          WHERE user_id = ? AND deleted_at IS NULL AND id IN (${idPlaceholders}) AND (${sourceChecks})`,
      ).bind(now, now, this.userId, ...sourceIds, ...sourceValues),
      this.db.prepare(`DELETE FROM note_properties WHERE user_id = ? AND note_id IN (${idPlaceholders})`)
        .bind(this.userId, ...sourceIds),
      this.db.prepare(`DELETE FROM ai_note_embeddings WHERE user_id = ? AND note_id IN (${idPlaceholders})`)
        .bind(this.userId, ...sourceIds),
      this.db.prepare(`DELETE FROM rewrite_queue WHERE user_id = ? AND source_id IN (${idPlaceholders})`)
        .bind(this.userId, ...sourceIds),
      ...trashPurgeStatements(this.db, this.userId, sourceIdsJson, now, this.ftsEnabled),
    ]
    const patched = await this.patch({
      current: target,
      expectedRev: target.rev,
      columns: {
        content,
        content_hash: contentHash,
        excerpt: deriveExcerpt(content),
        word_count: words,
        char_count: chars,
      },
      title: target.title,
      content,
      contentHash,
      now,
      contentChanged: true,
      titleChanged: false,
      derive: target.deleted_at === null,
      snapshot: { preserve: true, bigChange: true },
      extraGuard: { sql: sourceChecks, values: sourceValues },
      prefixStatements,
      suffixStatements,
    })
    return {
      row: patched.next,
      changeSeq: patched.changeSeq,
      applied: patched.applied,
      merged: patched.applied ? sources.length : 0,
      tooLarge: false,
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
           WHERE note_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT ${LIMITS.versionsPerNoteMax}`,
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
         AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ${versionRetentionOffsetSql('?3')})`,
    ).bind(id, ...mutationValues)
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
      sets.push(`${column} = ?`)
    }
    binds.push(now)
    sets.push('updated_at = ?')
    binds.push(nextRev)
    sets.push('rev = ?')
    binds.push(id, this.userId, input.expectedRev)

    const extraGuard = input.extraGuard
    const extraValues = extraGuard?.values ?? []
    const mutationGuard = `EXISTS (SELECT 1 FROM notes
      WHERE id = ?1 AND user_id = ?2 AND rev = ?3
        AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
    const mutationValues = [id, this.userId, nextRev, input.contentHash, input.title, now] as const

    const changesFolder = Object.prototype.hasOwnProperty.call(input.columns, 'folder_id')
    const folderGuard = changesFolder
      ? ' AND (? IS NULL OR EXISTS (SELECT 1 FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL))'
      : ''
    if (changesFolder) binds.push(input.columns.folder_id, this.userId)
    const update = this.db.prepare(
      `UPDATE notes SET ${sets.join(', ')}
        WHERE id = ? AND user_id = ? AND rev = ?${folderGuard}${extraGuard ? ` AND (${extraGuard.sql})` : ''}`,
    ).bind(...binds, ...extraValues)

    const prefixStatements = input.prefixStatements ?? []
    const suffixStatements = input.suffixStatements ?? []
    const statements: D1PreparedStatement[] = [...prefixStatements, update]
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
             AND EXISTS (SELECT 1 FROM note_versions WHERE id = ?8)
             AND ${shiftSqlPlaceholders(mutationGuard, 1)}
             AND id IN (
               SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ${versionRetentionOffsetSql('?3')})`,
        ).bind(id, ...mutationValues, snapshotId),
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

    if ((input.contentChanged || input.titleChanged) && input.indexable !== false) {
      statements.push(noteIndexQueueStatement(this.db, this.userId, id, 'embed', now))
    }

    // Whether another note already answers to either title decides the wiki-link rewrite, so
    // it rides along with the mutation instead of costing the rename path its own round trip.
    let ambiguityIndex = -1
    if (input.titleChanged) {
      ambiguityIndex = prefixStatements.length + statements.length
      statements.push(this.db.prepare(
        `SELECT 1 AS found FROM notes
          WHERE user_id = ?1 AND id <> ?2 AND deleted_at IS NULL AND title_key IN (?3, ?4)
          LIMIT 1`,
      ).bind(this.userId, id, normalizeLinkKey(current.title), normalizeLinkKey(input.title)))
    }

    if (input.sealing) {
      const previousKey = normalizeLinkKey(current.title)
      const guarded = (sql: string, values: unknown[]) => this.db.prepare(
        `${sql} AND ${shiftSqlPlaceholders(mutationGuard, values.length)}`,
      ).bind(...values, ...mutationValues)
      statements.push(
        guarded(`DELETE FROM note_versions WHERE note_id = ?1 AND user_id = ?2`, [id, this.userId]),
        guarded(`DELETE FROM ai_note_embeddings WHERE user_id = ?1 AND note_id = ?2`, [this.userId, id]),
        guarded(`DELETE FROM ai_index_queue WHERE user_id = ?1 AND note_id = ?2`, [this.userId, id]),
        guarded(`DELETE FROM fts_index_queue WHERE user_id = ?1 AND note_id = ?2`, [this.userId, id]),
        guarded(`DELETE FROM links WHERE user_id = ?1 AND (source_note_id = ?2 OR target_note_id = ?2 OR target_key = ?3)`,
          [this.userId, id, previousKey]),
        guarded(`DELETE FROM rewrite_queue WHERE user_id = ?1 AND source_id = ?2`, [this.userId, id]),
        guarded(`DELETE FROM share_asset_sessions WHERE slug IN (
          SELECT slug FROM shares WHERE note_id = ?1 AND user_id = ?2
        )`, [id, this.userId]),
        guarded(`UPDATE shares SET is_enabled = 0 WHERE user_id = ?1 AND note_id = ?2`, [this.userId, id]),
        guarded(`UPDATE blog_pages SET published_at = NULL WHERE user_id = ?1 AND note_id = ?2`, [this.userId, id]),
        guarded(`UPDATE blog_posts SET status = 'withdrawn' WHERE user_id = ?1 AND note_id = ?2`, [this.userId, id]),
      )
      if (this.ftsEnabled) {
        statements.push(guarded(`DELETE FROM notes_fts WHERE ${FTS_NOTE_MATCH_SQL} AND user_id = ?2`, [id, this.userId]))
      }
    }

    statements.push(...suffixStatements)
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
      applied: Boolean(results[prefixStatements.length]?.meta.changes),
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

  async hasOtherNoteWithTitle(title: string, exceptId: string): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS found FROM notes
        WHERE user_id = ?1 AND id <> ?2 AND deleted_at IS NULL AND title_key = ?3
        LIMIT 1`,
    ).bind(this.userId, exceptId, normalizeLinkKey(title)).first()
    return Boolean(row)
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
    const derived = current.is_encrypted === 1
      ? []
      : buildNoteDerivedStatements({
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
      ...(current.is_encrypted === 1 ? [] : [noteIndexQueueStatement(this.db, this.userId, current.id, 'embed', now)]),
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
      // The chat's side of the same cascade. These four columns are written by the assistant, so the
      // notes store names their tables directly — the dependency already runs the other way (the
      // assistant reads `notes`), both apps share this one database, and nothing but this batch can make
      // the cleanup land with the delete. `tests/worker-layering.test.ts` forbids SQL in a route and a
      // store importing a route; it does not forbid this, and every statement keeps `user_id`.
      //
      // Which columns are nulled and which are deleted is per column, not per table:
      //  - an artifact and a conversation keep their own text, so only the pointer to the gone note is
      //    dropped; deleting the row would destroy writing the reader never asked to lose;
      //  - `chat_note_writes` exists only to say "this note came from that thread", so with the note gone
      //    the row has no remaining meaning and is deleted rather than left pointing at nothing;
      //  - a memory is a fact the reader kept; the note it was once written out as is a detail, so the
      //    pointer goes and the memory stays.
      // `updated_at` is deliberately untouched on the two lists that sort by it: a note being purged is
      // not the reader editing their memory or reopening a thread, and it should not reorder either list.
      this.db.prepare(
        `UPDATE chat_artifacts SET note_id = NULL
          WHERE user_id = ?1 AND note_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
      ).bind(this.userId, id, id, this.userId, current.rev),
      this.db.prepare(
        `UPDATE chat_conversations SET note_id = NULL
          WHERE user_id = ?1 AND note_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
      ).bind(this.userId, id, id, this.userId, current.rev),
      this.db.prepare(
        `DELETE FROM chat_note_writes
          WHERE user_id = ?1 AND note_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
      ).bind(this.userId, id, id, this.userId, current.rev),
      this.db.prepare(
        `UPDATE chat_memories SET note_id = NULL
          WHERE user_id = ?1 AND note_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
      ).bind(this.userId, id, id, this.userId, current.rev),
      // The run row is the account's history of what a schedule did, so it stays while the pointer to the
      // note that no longer exists goes.
      this.db.prepare(
        `UPDATE chat_runs SET note_id = NULL
          WHERE user_id = ?1 AND note_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
      ).bind(this.userId, id, id, this.userId, current.rev),
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
