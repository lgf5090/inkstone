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
import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from '@shared/assistant'
import type { SyncResponse } from '@shared/types'
import { parseRepeatRule, type TaskTag, type TodoTask, type TodoTimeEntry } from '@shared/todos/model'
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
 * The task columns the sync delta reads.
 *
 * Deliberately the row, not a `TodoTask`: the delta's clock is `updated_at`, and a tombstoned row
 * (`deleted_at` set) is the only way this read learns a task was removed. The mapping into the
 * shared task shape happens below, with tags, steps and reminders attached once per page.
 */
interface TodoSyncRow {
  id: string
  title: string
  description: string
  status: string
  priority: string
  due_at: number | null
  project_id: string | null
  list_id: string | null
  /** The task's own icon, or null while it wears its list's. */
  icon: string | null
  /** The task's own colour, or null while it wears its list's. */
  color: string | null
  starred: number
  repeat_rule: string | null
  note_id: string | null
  conversation_id: string | null
  planned_for: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
  rev: number
  deleted_at: number | null
  archived_at: number | null
}

const TODO_SYNC_COLUMNS = `id, title, description, status, priority, due_at, project_id, list_id, icon, color, starred,
  repeat_rule, note_id, conversation_id, planned_for, created_at, updated_at, completed_at, rev, deleted_at, archived_at`

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
        `SELECT ${TODO_SYNC_COLUMNS} FROM todos_tasks
          WHERE user_id = ?1 AND updated_at > ?2
          ORDER BY updated_at ASC, id ASC`,
      )
      .bind(this.userId, since)
      .all<TodoSyncRow>()
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
        `SELECT ${TODO_SYNC_COLUMNS} FROM todos_tasks
          WHERE user_id = ?1 AND deleted_at IS NULL
          ORDER BY updated_at ASC, id ASC`,
      )
      .bind(this.userId)
      .all<TodoSyncRow>()
    const rows = results ?? []
    const newest = rows.reduce((max, row) => Math.max(max, row.updated_at), 0)
    return { todos: await this.todosWithDetails(rows), deleted: [], cursor: Math.max(newest, Date.now()) }
  }

  /** Tags, step counts, pending reminders and the time ledger for one page of tasks, one query each. */
  private async todosWithDetails(rows: TodoSyncRow[]): Promise<TodoTask[]> {
    if (!rows.length) return []
    const ids = rows.map((row) => row.id)
    const chunks = chunkIds(ids)
    const [tagPages, stepPages, reminderPages, timePages] = await Promise.all([
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
      Promise.all(chunks.map((chunk) => this.db
        .prepare(
          `SELECT task_id, remind_at FROM todos_reminders
            WHERE user_id = ?1 AND fired_at IS NULL
              AND task_id IN (${placeholders(chunk.length, 2)})
            ORDER BY remind_at ASC`,
        )
        .bind(this.userId, ...chunk)
        .all<{ task_id: string; remind_at: number }>())),
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
    ])
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
    const reminders = new Map<string, number[]>()
    for (const page of reminderPages) {
      for (const row of page.results ?? []) {
        const bucket = reminders.get(row.task_id) ?? []
        bucket.push(row.remind_at)
        reminders.set(row.task_id, bucket)
      }
    }
    const timeEntries = new Map<string, TodoTimeEntry[]>()
    for (const page of timePages) {
      for (const row of page.results ?? []) {
        const bucket = timeEntries.get(row.task_id) ?? []
        bucket.push(toTimeEntry(row))
        timeEntries.set(row.task_id, bucket)
      }
    }
    return rows.map((row) => {
      const pending = reminders.get(row.id) ?? []
      const step = steps.get(row.id)
      return {
        id: row.id,
        title: row.title,
        description: row.description ?? '',
        status: taskStatus(row.status),
        priority: taskPriority(row.priority),
        dueAt: row.due_at,
        projectId: row.project_id,
        listId: row.list_id,
        icon: row.icon,
        color: row.color,
        tags: tags.get(row.id) ?? [],
        starred: row.starred === 1,
        repeat: parseRepeatRule(parseJson(row.repeat_rule)),
        reminders: pending,
        remindAt: pending[0] ?? null,
        remindedAt: null,
        plannedFor: row.planned_for ?? null,
        noteId: row.note_id,
        conversationId: row.conversation_id,
        timeEntries: timeEntries.get(row.id) ?? [],
        stepTotal: step?.total ?? 0,
        stepDone: step?.done ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        rev: row.rev,
        deletedAt: row.deleted_at,
        archivedAt: row.archived_at,
      }
    })
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

function taskPriority(value: string): TaskPriority {
  return TASK_PRIORITIES.includes(value as TaskPriority) ? value as TaskPriority : 'medium'
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
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
