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
import { MAX_BATCH_STATEMENTS, runBatched, shiftSqlPlaceholders } from '../db/writes'

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

/** The columns a PATCH reads before deciding what may change: the guard is the row's own timestamp. */
export interface FolderStateRow {
  id: string
  parent_id: string | null
  updated_at: number
}

/** The columns a folder PATCH writes. `updated_at` and the guard are added by `patchFolder`. */
export interface FolderPatchColumns {
  name?: string
  icon?: string | null
  color?: string | null
  parent_id?: string | null
  position?: number
}

/**
 * One folder edit the route has decided: which columns differ, where the folder is going and which
 * sibling it is going before.
 *
 * `parentId` is bound even when unchanged, because the recursive `ancestors` walk and the
 * `before_folder` existence check both read slot `?3`; `beforeId` is the same whether or not the
 * request reordering asked for one.
 */
export interface FolderPatchInput {
  id: string
  /** The row the route read, which supplies the `updated_at` the update is matched against. */
  current: FolderStateRow
  parentId: string | null
  columns: FolderPatchColumns
  updatedAt: number
  beforeId: string | null
}

/** The rows a promotion read returns: siblings and children of one folder, in one pass. */
export interface FolderPromotionRow extends FolderOrderRow {
  parent_id: string | null
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

  /** The live folder's guard columns — all a PATCH needs before it decides what to write. */
  async folderState(id: string): Promise<FolderStateRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, parent_id, updated_at FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
      )
      .bind(id, this.userId)
      .first<FolderStateRow>()
    return row ?? null
  }

  /** One parent's children in display order, which is the only thing the position maths reads. */
  async siblingOrder(parentId: string | null): Promise<FolderOrderRow[]> {
    const { results } = await this.db.prepare(
      `SELECT id, position, created_at FROM folders
        WHERE user_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL
        ORDER BY position ASC, created_at ASC, id ASC`,
    ).bind(this.userId, parentId).all<FolderOrderRow>()
    return results
  }

  /**
   * Siblings and children of one folder, the read the promotion maths needs in a single pass.
   *
   * `parent_id IS ?2 OR parent_id = ?3` covers both lists at once: the folder keeps its own place in
   * its parent's run, and its children are the ones that move up when it is deleted.
   */
  async promotionRows(folder: { parent_id: string | null; id: string }): Promise<FolderPromotionRow[]> {
    const { results } = await this.db.prepare(
      `SELECT id, parent_id, position, created_at FROM folders
        WHERE user_id = ?1 AND deleted_at IS NULL
          AND (parent_id IS ?2 OR parent_id = ?3)`,
    ).bind(this.userId, folder.parent_id, folder.id).all<FolderPromotionRow>()
    return results
  }

  /**
   * Renumber a sibling run to whole thousands, so the next insertion can find a gap again.
   *
   * Two statements per moved row — the update and its change record — chunked at
   * `MAX_BATCH_STATEMENTS`, because a run long enough to need this is long enough to outgrow one
   * batch. Rows already at the wanted position are skipped, which is what keeps a reorder that
   * changed nothing from broadcasting a change for everything.
   */
  async normalizeSiblings(siblings: FolderOrderRow[]): Promise<void> {
    const now = Date.now()
    const statements: D1PreparedStatement[] = []
    for (let index = 0; index < siblings.length; index++) {
      const sibling = siblings[index]!
      const position = (index + 1) * 1000
      if (sibling.position === position) continue
      statements.push(
        this.db.prepare(
          `UPDATE folders SET position = ?3, updated_at = MAX(updated_at + 1, ?4)
            WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
        ).bind(sibling.id, this.userId, position, now),
        this.db.prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?2, 'folder', ?1, 'upsert', ?3
            WHERE EXISTS (SELECT 1 FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL)`,
        ).bind(sibling.id, this.userId, now),
      )
    }
    await runBatched(this.db, statements, MAX_BATCH_STATEMENTS)
  }

  /**
   * Apply one folder edit, with the hierarchy guards that decide whether it is allowed at all.
   *
   * `sets` is the update's column list in the order the route wrote it, and the whole statement's
   * parameters are counted by hand: `?1` is the folder, `?2` the account and `?3` the destination
   * parent, so every column bind shifts by three. The recursive `descendants` and `ancestors` walks
   * are what make a single statement refuse both a move into one's own subtree and a move that would
   * push the tree past `LIMITS.folderDepthMax`, and the `before_folder` existence check refuses a
   * reorder whose neighbour has gone away. Everything is guarded on the `updated_at` the route read,
   * so a concurrent edit shows up as `applied: false` instead of a lost update.
   */
  async patchFolder(input: FolderPatchInput): Promise<FolderWriteResult> {
    const sets: string[] = []
    const binds: unknown[] = []
    for (const [column, value] of Object.entries(input.columns)) {
      binds.push(value)
      sets.push(`${column} = ?${binds.length}`)
    }
    binds.push(input.updatedAt)
    sets.push(`updated_at = ?${binds.length}`)
    const shiftedSets = sets.map((set) => shiftSqlPlaceholders(set, 3))

    const update = this.db.prepare(
      `WITH RECURSIVE
         descendants(id, depth) AS (
           SELECT id, 1 FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
           UNION ALL
           SELECT f.id, d.depth + 1 FROM folders f JOIN descendants d ON f.parent_id = d.id
            WHERE f.user_id = ?2 AND f.deleted_at IS NULL AND d.depth < ?${binds.length + 5}
         ),
         ancestors(id, parent_id, depth) AS (
           SELECT id, parent_id, 1 FROM folders WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL
           UNION ALL
           SELECT f.id, f.parent_id, a.depth + 1 FROM folders f JOIN ancestors a ON f.id = a.parent_id
            WHERE f.user_id = ?2 AND f.deleted_at IS NULL AND a.depth < ?${binds.length + 5}
         )
       UPDATE OR IGNORE folders SET ${shiftedSets.join(', ')}
        WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
          AND updated_at = ?${binds.length + 4}
          AND (?3 IS NULL OR EXISTS (
            SELECT 1 FROM folders WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL
          ))
          AND NOT EXISTS (SELECT 1 FROM descendants WHERE id = ?3)
          AND COALESCE((SELECT MAX(depth) FROM ancestors), 0)
              + COALESCE((SELECT MAX(depth) FROM descendants), 1) <= ?${binds.length + 5}
          AND (?${binds.length + 6} IS NULL OR EXISTS (
            SELECT 1 FROM folders before_folder
             WHERE before_folder.id = ?${binds.length + 6}
               AND before_folder.user_id = ?2 AND before_folder.parent_id IS ?3
               AND before_folder.deleted_at IS NULL
          ))`,
    ).bind(
      input.id,
      this.userId,
      input.parentId,
      ...binds,
      input.current.updated_at,
      LIMITS.folderDepthMax,
      input.beforeId,
    )
    const change = this.db.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'folder', ?2, 'upsert', ?3
        WHERE EXISTS (SELECT 1 FROM folders WHERE id = ?2 AND user_id = ?1 AND updated_at = ?3)
       RETURNING seq`,
    ).bind(this.userId, input.id, input.updatedAt)
    const readback = this.db.prepare(
      `SELECT ${FOLDER_SELECT} FROM folders f WHERE f.id = ?1 AND f.user_id = ?2`,
    ).bind(input.id, this.userId)
    const results = await this.db.batch([update, change, readback])
    return {
      applied: Boolean(results[0]?.meta.changes),
      changeSeq: (results.at(-2) as D1Result<{ seq: number }>).results?.[0]?.seq,
      row: (results.at(-1) as D1Result<FolderRow>).results?.[0] ?? null,
    }
  }
}
