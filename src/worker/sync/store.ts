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
import { TASK_STATUSES, type TaskStatus } from '@shared/assistant'
import type { SyncResponse } from '@shared/types'
import { type TaskRef, type TaskTag, type TodoTask, type TodoTimeEntry } from '@shared/todos/model'
import {
  TASK_REMINDER_TIMES,
  TASK_TIME_ROLLUP,
  reminderTimesOf,
  toTask,
  type TaskRow,
} from '../assistant/store'
import { toTimeEntry, type TodoTimeEntryRow } from '../todos/schema'
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

/**
 * The task read both sync answers share.
 *
 * It spells the select exactly as the route listing does — every column the row carries, plus the two
 * derived columns a task face reads — and serialises through the same `toTask`. The stream used to keep a
 * hand-written column list of its own, and that list had quietly lost `position`, `start_at`,
 * `time_estimate_ms` and the ledger's rollups: an offline device was told a task had no start date, no
 * place in the reader's own order, and no stopwatch running. One serializer leaves nothing to remember.
 */
const TODO_SYNC_SELECT = `SELECT *, ${TASK_REMINDER_TIMES}, ${TASK_TIME_ROLLUP} FROM todos_tasks`

/** One end of a `todos_task_links` row, joined to the task it points at. */
interface TodoDepSyncRow {
  key: string
  id: string
  title: string
  status: string
  created_at: number
}

interface TodoTagSyncRow {
  task_id: string
  id: string
  name: string
  color: string | null
  created_at: number
  updated_at: number
}

export interface TodoSyncPage {
  todos: TodoTask[]
  deleted: string[]
  cursor: number
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
   * The task delta: every row written after `since`, tombstones included.
   *
   * The cursor is the newest `updated_at` on the page rather than the change sequence: task writes do
   * not record change rows, and their own write stamp is the only ordering they share. A deleted task
   * keeps its row (`deleted_at`), which is what makes a deletion observable here at all. Purges are
   * the one removal this stream cannot see; a purge is an explicit second gesture from the trash and
   * the next full snapshot settles it.
   */
  async todosDelta(since: number): Promise<TodoSyncPage> {
    const { results } = await this.db
      .prepare(
        `${TODO_SYNC_SELECT}
          WHERE user_id = ?1 AND updated_at > ?2
          ORDER BY updated_at ASC, id ASC`,
      )
      .bind(this.userId, since)
      .all<TaskRow>()
    const rows = results ?? []
    const cursor = rows.reduce((newest, row) => Math.max(newest, row.updated_at), since)
    const deleted = rows.filter((row) => row.deleted_at !== null).map((row) => row.id)
    const live = rows.filter((row) => row.deleted_at === null)
    return { todos: await this.todosWithDetails(live), deleted, cursor }
  }

  /**
   * Every live task, for the first sync after a fresh install or a cleared cache.
   *
   * The cursor starts at the later of the newest row and the server clock, so a task written while
   * this response is in flight is picked up by the next delta rather than waiting for a full sync.
   */
  async todosSnapshot(): Promise<TodoSyncPage> {
    const { results } = await this.db
      .prepare(
        `${TODO_SYNC_SELECT}
          WHERE user_id = ?1 AND deleted_at IS NULL
          ORDER BY updated_at ASC, id ASC`,
      )
      .bind(this.userId)
      .all<TaskRow>()
    const rows = results ?? []
    const newest = rows.reduce((max, row) => Math.max(max, row.updated_at), 0)
    return { todos: await this.todosWithDetails(rows), deleted: [], cursor: Math.max(newest, Date.now()) }
  }

  /** Tags, step counts, the time ledger and both ends of the dependency graph for one page of tasks. */
  private async todosWithDetails(rows: TaskRow[]): Promise<TodoTask[]> {
    if (!rows.length) return []
    const ids = rows.map((row) => row.id)
    const chunks = chunkIds(ids)
    const [tagPages, stepPages, timePages, dependsDownPages, dependsUpPages] = await Promise.all([
      Promise.all(chunks.map((chunk) => this.db
        .prepare(
          `SELECT l.task_id, t.id, t.name, t.color, t.created_at, t.updated_at
             FROM todos_tag_links l
             JOIN todos_tags t ON t.user_id = l.user_id AND t.id = l.tag_id
            WHERE l.user_id = ?1 AND l.task_id IN (${placeholders(chunk.length, 2)})
            ORDER BY t.name COLLATE NOCASE`,
        )
        .bind(this.userId, ...chunk)
        .all<TodoTagSyncRow>())),
      Promise.all(chunks.map((chunk) => this.db
        .prepare(
          `SELECT task_id, COUNT(*) AS total,
                  SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END) AS done
             FROM todos_steps
            WHERE user_id = ?1 AND task_id IN (${placeholders(chunk.length, 2)})
            GROUP BY task_id`,
        )
        .bind(this.userId, ...chunk)
        .all<{ task_id: string; total: number; done: number | null }>())),
      // The time ledger rides with the page it belongs to: every ledger write bumps its task's
      // `updated_at` (assistant/store.ts `touchTaskStatement`), so the whole set of one task's
      // intervals is restated whenever any of them changes, and a receiving device replaces rather
      // than merges. That is what makes a deleted span propagate without a second tombstone stream.
      Promise.all(chunks.map((chunk) => this.db
        .prepare(
          `SELECT id, task_id, start_at, end_at, day, source, created_at, updated_at
             FROM todos_time_entries
            WHERE user_id = ?1 AND task_id IN (${placeholders(chunk.length, 2)})
            ORDER BY start_at ASC, id ASC`,
        )
        .bind(this.userId, ...chunk)
        .all<TodoTimeEntryRow>())),
      // Which task waits on which, read from both ends. The partner's title and live status travel with
      // the link for the same reason the ledger restates whole: a receiving device replaces a row's
      // dependencies rather than merging them, so an offline reader is never shown a waiting task as
      // free to go. Trashed partners are left out — a row on its way to being gone is not what you are
      // waiting for, and it is not something to report either.
      Promise.all(chunks.map((chunk) => this.db
        .prepare(
          `SELECT l.task_id AS key, t.id, t.title, t.status, l.created_at
             FROM todos_task_links l
             JOIN todos_tasks t ON t.user_id = l.user_id AND t.id = l.depends_on_id
            WHERE l.user_id = ?1 AND l.task_id IN (${placeholders(chunk.length, 2)})
              AND t.deleted_at IS NULL
            ORDER BY l.created_at ASC, l.depends_on_id ASC`,
        )
        .bind(this.userId, ...chunk)
        .all<TodoDepSyncRow>())),
      Promise.all(chunks.map((chunk) => this.db
        .prepare(
          `SELECT l.depends_on_id AS key, t.id, t.title, t.status, l.created_at
             FROM todos_task_links l
             JOIN todos_tasks t ON t.user_id = l.user_id AND t.id = l.task_id
            WHERE l.user_id = ?1 AND l.depends_on_id IN (${placeholders(chunk.length, 2)})
              AND t.deleted_at IS NULL
            ORDER BY l.created_at ASC, l.task_id ASC`,
        )
        .bind(this.userId, ...chunk)
        .all<TodoDepSyncRow>())),
    ])
    const dependsOn = new Map<string, TaskRef[]>()
    const blocks = new Map<string, TaskRef[]>()
    for (const [pages, into] of [[dependsDownPages, dependsOn], [dependsUpPages, blocks]] as const) {
      for (const page of pages) {
        for (const row of page.results ?? []) {
          const bucket = into.get(row.key) ?? []
          bucket.push({ id: row.id, title: row.title, status: taskStatus(row.status) })
          into.set(row.key, bucket)
        }
      }
    }
    const tags = new Map<string, TaskTag[]>()
    for (const page of tagPages) {
      for (const row of page.results ?? []) {
        const bucket = tags.get(row.task_id) ?? []
        bucket.push({
          id: row.id,
          name: row.name,
          color: row.color,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          openCount: 0,
        })
        tags.set(row.task_id, bucket)
      }
    }
    const steps = new Map<string, { total: number; done: number }>()
    for (const page of stepPages) {
      for (const row of page.results ?? [])
        steps.set(row.task_id, { total: row.total, done: row.done ?? 0 })
    }
    const timeEntries = new Map<string, TodoTimeEntry[]>()
    for (const page of timePages) {
      for (const row of page.results ?? []) {
        const bucket = timeEntries.get(row.task_id) ?? []
        bucket.push(toTimeEntry(row))
        timeEntries.set(row.task_id, bucket)
      }
    }
    return rows.map((row) => ({
      ...toTask(row, {
        tags: tags.get(row.id) ?? [],
        dependsOn: dependsOn.get(row.id) ?? [],
        blocks: blocks.get(row.id) ?? [],
        stepTotal: steps.get(row.id)?.total ?? 0,
        stepDone: steps.get(row.id)?.done ?? 0,
        // The pending list rides in on the row's own packed column, the way every other task read
        // carries it, rather than as a second query per page.
        reminders: reminderTimesOf(row.reminder_times),
      }),
      timeEntries: timeEntries.get(row.id) ?? [],
    }))
  }

  /**
   * The full-snapshot response body.
   *
   * Kept on the store because every statement it runs is a scoped read and the three loads stay in
   * one `Promise.all`, as before; only `cursor` (decided by the route from the change bounds) and
   * the keyset `after` come in as parameters, and the row mapping is the shared `to*` helpers.
   */
  async fullSnapshot(cursor: number, after: string): Promise<SyncResponse> {
    const [rows, folders, tags, todoPage] = await Promise.all([
      this.snapshotNotes(after),
      !after ? this.snapshotFolders() : Promise.resolve([] as FolderRow[]),
      !after ? this.snapshotTags() : Promise.resolve([] as TagRow[]),
      // Tasks have no keyset page of their own: the first page carries the whole live set, and a
      // client that was here before merges it by id.
      !after ? this.todosSnapshot() : Promise.resolve(null),
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
      ...(todoPage ? { todos: todoPage.todos, todosDeleted: [], todosCursor: todoPage.cursor } : {}),
      serverTime: Date.now(),
    }
  }
}

function placeholders(count: number, start: number): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(', ')
}

/** Ids in the batches a D1 statement can bind; the task detail reads are keyed by them. */
function chunkIds(ids: readonly string[]): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += 80)
    chunks.push(ids.slice(index, index + 80))
  return chunks
}

/**
 * The row's own vocabulary, read from the shared lists rather than spelled out again here.
 *
 * A status written by hand was a status the sync could not carry: `cancelled` reached this decoder as
 * an unknown word and left the other device as an open task — not dropped, which would be visible, but
 * rewritten. The fallback stays: a word from a future version of the app still reads as the plain
 * default rather than throwing away the page.
 */
function taskStatus(value: string): TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus) ? value as TaskStatus : 'todo'
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
