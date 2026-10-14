/**
 * Every read and write the folder HTTP routes make against D1.
 *
 * The shape follows `notes/store.ts` and `assistant/store.ts`: a store built per request from the
 * account it serves, methods that take already-validated input and hand back rows or the record the
 * route needs to answer with, and nothing in between that knows about HTTP. Two rules hold throughout:
 *  - every statement carries `user_id`, so one account's tree can never be read, moved or deleted
 *    through another's ids. The single exception is the id-collision probe, which answers a
 *    client-supplied id and is only meaningful across accounts;
 *  - a mutation's statements stay in one D1 batch. Folder writes are guarded on `updated_at`, and the
 *    recursive `ancestors`/`descendants` clauses inside them read the same rows they are about to
 *    change, so splitting a batch into sequential runs would let a concurrent move slip between the
 *    depth check and the update and produce a cycle the guard was written to refuse.
 *
 * The hierarchy rules themselves — parent validation, depth, subtree height, the name a new folder
 * gets, where a reordered folder lands — stay with the route, because they are decisions about the
 * request, and the errors they raise belong to the response.
 */

import { LIMITS } from '@shared/constants'
import { FOLDER_SELECT, type FolderRow } from '../db/rows'

/** The live tree reduced to what the route's hierarchy rules need. */
export interface FolderGraph {
  parents: Map<string, string | null>
  children: Map<string, string[]>
  siblingNames: Map<string, Set<string>>
}

/** One sibling's place in the order, which is all the gap-finding maths reads. */
export interface FolderOrderRow {
  id: string
  position: number
  created_at: number
}

/** A folder the route has validated, named and measured; `id`, `name` and `now` were chosen by the route. */
export interface FolderCreateInput {
  id: string
  parentId: string | null
  name: string
  /** Already passed through `normalizeOrganizerIcon`, so the store never decides what an icon means. */
  icon: string | null
  color: string | null
  now: number
}

/** The outcome of a folder write: whether the guarded statement matched, its change record and the read row. */
export interface FolderWriteResult {
  applied: boolean
  changeSeq: number | undefined
  row: FolderRow | null
}

export class FoldersStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /** Every live folder of this account, in sidebar order. */
  async listFolders(): Promise<FolderRow[]> {
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

  /**
   * One folder of this account, trashed ones included.
   *
   * The patch readback has to answer for a folder that was deleted between the guard read and this
   * one, so the filter stays as `id` + `user_id` only; every statement that decides whether a folder
   * may be changed adds `deleted_at IS NULL` itself.
   */
  async folderRow(id: string): Promise<FolderRow | null> {
    const row = await this.db
      .prepare(`SELECT ${FOLDER_SELECT} FROM folders f WHERE f.id = ?1 AND f.user_id = ?2`)
      .bind(id, this.userId)
      .first<FolderRow>()
    return row ?? null
  }

  /**
   * One live folder of this account — the shape a create with a client-supplied id answers with.
   *
   * A trashed folder is not an idempotent replay: the row exists but is not in the tree, so the create
   * continues and the unique index decides. That is the behaviour the route has always had.
   */
  async liveFolderRow(id: string): Promise<FolderRow | null> {
    const row = await this.db
      .prepare(
        `SELECT ${FOLDER_SELECT} FROM folders f WHERE f.id = ?1 AND f.user_id = ?2 AND f.deleted_at IS NULL`,
      )
      .bind(id, this.userId)
      .first<FolderRow>()
    return row ?? null
  }

  /**
   * Whether any account already owns this id.
   *
   * Deliberately the one statement here without a `user_id` filter: it answers a client-supplied id
   * collision, which is only meaningful across accounts. It reads a single column of a row the caller
   * cannot address any other way, and the caller has already failed the same id against its own folder.
   */
  async idTakenByAnyone(id: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT user_id FROM folders WHERE id = ?1`)
      .bind(id)
      .first<{ user_id: string }>()
    return row !== null
  }

  /** Parents, children and case-folded sibling names for every live folder of this account. */
  async graph(): Promise<FolderGraph> {
    const { results } = await this.db
      .prepare(`SELECT id, parent_id, name FROM folders WHERE user_id = ?1 AND deleted_at IS NULL`)
      .bind(this.userId)
      .all<{ id: string; parent_id: string | null; name: string }>()
    const parents = new Map<string, string | null>()
    const children = new Map<string, string[]>()
    const siblingNames = new Map<string, Set<string>>()
    for (const row of results) {
      parents.set(row.id, row.parent_id)
      const key = row.parent_id ?? ''
      const list = children.get(key) ?? []
      list.push(row.id)
      children.set(key, list)
      const names = siblingNames.get(key) ?? new Set<string>()
      names.add(row.name.toLocaleLowerCase())
      siblingNames.set(key, names)
    }
    return { parents, children, siblingNames }
  }

  /**
   * Create one folder, keeping the parent's existence and the depth ceiling inside the insert.
   *
   * The recursive `ancestors` walk is what lets the insert refuse a parent chain that is already too
   * deep without a second round trip, and it is bounded by `LIMITS.folderDepthMax + 1` steps so a
   * corrupted hierarchy cannot make the walk run away. The route checked the same rule against the
   * graph it read; this is the guard that holds when the graph moved in between. `position` is the
   * tail of its sibling run, so a new folder appears last without the route numbering anything.
   */
  async createFolder(input: FolderCreateInput): Promise<FolderWriteResult> {
    const insert = this.db.prepare(
      `WITH RECURSIVE ancestors(id, parent_id, depth) AS (
         SELECT id, parent_id, 1 FROM folders
          WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL
         UNION ALL
         SELECT f.id, f.parent_id, a.depth + 1
           FROM folders f JOIN ancestors a ON f.id = a.parent_id
          WHERE f.user_id = ?2 AND f.deleted_at IS NULL AND a.depth < ?9
       )
       INSERT OR IGNORE INTO folders (id, user_id, parent_id, name, icon, color, position, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6,
              COALESCE((SELECT MAX(position) FROM folders
                         WHERE user_id = ?2 AND parent_id IS ?3 AND deleted_at IS NULL), 0) + 1000,
              ?7, ?7
        WHERE (?3 IS NULL OR EXISTS (
                 SELECT 1 FROM folders WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL
               ))
          AND COALESCE((SELECT MAX(depth) FROM ancestors), 0) < ?8`,
    ).bind(
      input.id,
      this.userId,
      input.parentId,
      input.name,
      input.icon,
      input.color,
      input.now,
      LIMITS.folderDepthMax,
      LIMITS.folderDepthMax + 1,
    )
    const change = this.db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'folder', ?2, 'upsert', ?3
        WHERE EXISTS (SELECT 1 FROM folders WHERE id = ?2 AND user_id = ?1)
       RETURNING seq`,
    ).bind(this.userId, input.id, input.now)
    const readback = this.db.prepare(
      `SELECT ${FOLDER_SELECT} FROM folders f WHERE f.id = ?1 AND f.user_id = ?2`,
    ).bind(input.id, this.userId)
    const results = await this.db.batch([insert, change, readback])
    return {
      applied: Boolean(results[0]?.meta.changes),
      changeSeq: (results.at(-2) as D1Result<{ seq: number }>).results?.[0]?.seq,
      row: (results.at(-1) as D1Result<FolderRow>).results?.[0] ?? null,
    }
  }
}
