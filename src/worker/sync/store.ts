/**
 * Every read the sync HTTP route makes against D1.
 *
 * The shape follows `tags/store.ts`: a store built per request from the account it serves, methods
 * that take already-validated input and hand back rows, and nothing in between that knows about
 * HTTP. Sync only ever reads — the write path is the note/tag/folder stores, which record `changes`
 * rows as they go. Every statement here binds the account as `?1` (`user_id = ?1`), so the change
 * log, the delta pages, the facets and the snapshot can never cross accounts.
 *
 * Chunking and batch boundaries live with the store because they are transport facts of these
 * reads: ids are loaded eighty at a time (the D1 bind-variable ceiling), the delta note page and its
 * tag roll-up ride one D1 batch per chunk, and the three entity loads stay in the request's
 * `Promise.all`, exactly as the route arranged them before the move.
 */

import { LIMITS } from '@shared/constants'
import type { SyncResponse } from '@shared/types'
import {
  NOTE_COLUMNS_NOTAGS,
  attachNoteTags,
  noteTagsQueryForPage,
  tagSelectQuery,
  toFolder,
  toNoteSummary,
  toTag,
  type FolderRow,
  type NoteRow,
  type NoteTagRow,
  type TagRow,
} from '../db/rows'

const CHANGE_BOUNDS_SQL = `SELECT
  (SELECT seq FROM changes WHERE user_id = ?1 ORDER BY seq ASC LIMIT 1) AS lo,
  (SELECT seq FROM changes WHERE user_id = ?1 ORDER BY seq DESC LIMIT 1) AS hi`

const FOLDER_SELECT = `f.id, f.parent_id, f.name, f.icon, f.color, f.position, f.created_at, f.updated_at`

/** One `changes` row as the delta route consumes it. */
export interface SyncChangeRow {
  seq: number
  entity: string
  entity_id: string
  op: string
}

export class SyncStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /** The oldest and newest change seq this account owns; `null` bounds mean "no changes at all". */
  async changeBounds(): Promise<{ lo: number | null; hi: number | null } | null> {
    return await this.db
      .prepare(CHANGE_BOUNDS_SQL)
      .bind(this.userId)
      .first<{ lo: number | null; hi: number | null }>()
  }

  /** The next page of change records after `since`, oldest first. */
  async changePage(since: number): Promise<SyncChangeRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT seq, entity, entity_id, op FROM changes
          WHERE user_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3`,
      )
      .bind(this.userId, since, LIMITS.syncBatchSize)
      .all<SyncChangeRow>()
    return results ?? []
  }

  /**
   * The delta note page: the rows and their tag roll-up in one batch per chunk.
   *
   * A listing cannot pay a correlated `GROUP_CONCAT` walk per note, so the tags come back as the
   * second statement of the same batch (`noteTagsQueryForPage`) and are folded in memory.
   */
  async notesByIds(ids: string[]): Promise<NoteRow[]> {
    return await loadInChunks(ids, async (chunk) => {
      const pageFrom = `FROM notes n
          WHERE n.user_id = ?1 AND n.id IN (${placeholders(chunk.length, 2)})`
      const [page, tagRows] = await this.db.batch([
        this.db.prepare(`SELECT ${NOTE_COLUMNS_NOTAGS} ${pageFrom}`).bind(this.userId, ...chunk),
        this.db.prepare(noteTagsQueryForPage(pageFrom)).bind(this.userId, ...chunk),
      ])
      const results = (page?.results as NoteRow[] | undefined) ?? []
      attachNoteTags(results, (tagRows?.results as NoteTagRow[] | undefined) ?? [])
      return { results }
    })
  }

  /** Every live folder of this account, in listing order — the full-facet answer. */
  async foldersFull(): Promise<FolderRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${FOLDER_SELECT} FROM folders f
          WHERE f.user_id = ?1 AND f.deleted_at IS NULL
          ORDER BY f.position ASC, f.created_at ASC, f.id ASC`,
      )
      .bind(this.userId)
      .all<FolderRow>()
    return results ?? []
  }

  /** The named live folders, chunked and account-scoped like the note delta page. */
  async foldersByIds(ids: string[]): Promise<FolderRow[]> {
    return await loadInChunks(ids, (chunk) =>
      this.db.prepare(
        `SELECT ${FOLDER_SELECT} FROM folders f
          WHERE f.user_id = ?1 AND f.deleted_at IS NULL
            AND f.id IN (${placeholders(chunk.length, 2)})`,
      )
        .bind(this.userId, ...chunk)
        .all<FolderRow>(),
    )
  }

  /** Every tag of this account with its live note count, in sidebar order — the full-facet answer. */
  async tagsFull(): Promise<TagRow[]> {
    const { results } = await this.db
      .prepare(
        `${tagSelectQuery('t.user_id = ?1')} ORDER BY t.name COLLATE NOCASE`,
      )
      .bind(this.userId)
      .all<TagRow>()
    return results ?? []
  }

  /** The named tags, counts included, ordered the same way as the full listing. */
  async tagsByIds(ids: string[]): Promise<TagRow[]> {
    return await loadInChunks(ids, (chunk) =>
      this.db.prepare(
        `${tagSelectQuery(`t.user_id = ?1 AND t.id IN (${placeholders(chunk.length, 2)})`)} ORDER BY t.name COLLATE NOCASE`,
      )
        .bind(this.userId, ...chunk)
        .all<TagRow>(),
    )
  }

  /**
   * One page of the full snapshot: live notes after the keyset id, batched with their tags.
   *
   * Reads one row past the batch size; the route slices and decides `hasMore` from the overflow.
   */
  async snapshotNotes(after: string): Promise<NoteRow[]> {
    const notePageFrom = `FROM notes n WHERE n.user_id = ?1
          AND n.id > ?2 ORDER BY n.id ASC LIMIT ?3`
    const [page, tagRows] = await this.db.batch([
      this.db.prepare(
        `SELECT ${NOTE_COLUMNS_NOTAGS} ${notePageFrom}`,
      ).bind(this.userId, after, LIMITS.syncBatchSize + 1),
      this.db.prepare(noteTagsQueryForPage(notePageFrom)).bind(this.userId, after, LIMITS.syncBatchSize + 1),
    ])
    const results = (page?.results as NoteRow[] | undefined) ?? []
    attachNoteTags(results, (tagRows?.results as NoteTagRow[] | undefined) ?? [])
    return results
  }

  /** The snapshot's folder facet: sent only on the first page, hence the plain listing order. */
  async snapshotFolders(): Promise<FolderRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${FOLDER_SELECT} FROM folders f WHERE f.user_id = ?1 AND f.deleted_at IS NULL
          ORDER BY f.position ASC`,
      )
      .bind(this.userId)
      .all<FolderRow>()
    return results ?? []
  }

  /** The snapshot's tag facet, with counts, in the order the sidebar lists them. */
  async snapshotTags(): Promise<TagRow[]> {
    const { results } = await this.db
      .prepare(
        `${tagSelectQuery('t.user_id = ?1')} ORDER BY t.name COLLATE NOCASE`,
      )
      .bind(this.userId)
      .all<TagRow>()
    return results ?? []
  }

  /**
   * The full-snapshot response body.
   *
   * Kept on the store because every statement it runs is a scoped read and the three loads stay in
   * one `Promise.all`, as before; only `cursor` (decided by the route from the change bounds) and
   * the keyset `after` come in as parameters, and the row mapping is the shared `to*` helpers.
   */
  async fullSnapshot(cursor: number, after: string): Promise<SyncResponse> {
    const [rows, folders, tags] = await Promise.all([
      this.snapshotNotes(after),
      !after ? this.snapshotFolders() : Promise.resolve([] as FolderRow[]),
      !after ? this.snapshotTags() : Promise.resolve([] as TagRow[]),
    ])
    const pageNotes = rows.slice(0, LIMITS.syncBatchSize)
    const hasMore = rows.length > LIMITS.syncBatchSize

    return {
      cursor,
      full: true,
      hasMore,
      nextKey: hasMore ? pageNotes[pageNotes.length - 1]!.id : null,
      facetsFull: true,
      settingsChanged: true,
      profileChanged: true,
      siteChanged: true,
      notes: pageNotes.map(toNoteSummary),
      folders: folders.map(toFolder),
      tags: tags.map(toTag),
      deletions: [],
      serverTime: Date.now(),
    }
  }
}

function placeholders(count: number, start: number): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(', ')
}

async function loadInChunks<T>(
  ids: string[],
  load: (chunk: string[]) => Promise<{ results: T[] }>,
): Promise<T[]> {
  if (!ids.length) return []
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += 80) {
    chunks.push(ids.slice(index, index + 80))
  }
  const pages = await Promise.all(chunks.map(load))
  return pages.flatMap((page) => page.results)
}
