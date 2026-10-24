/**
 * The D1 statements behind the share hub's organizer: the folder and tag records a published link is
 * filed under, and the writes that move a link between them.
 *
 * `share_folders` and `share_tags` are the hub's own tables (see `hub-schema.ts`) and deliberately not
 * the note-side `folders`/`tags`: a link's filing is a decision about *publishing*, so a note being
 * moved about the notebook must not move a published collection's readership with it. The row shapes
 * mirror those tables so the hub behaves like the rest of the app — a folder tree ordered by
 * `position`, sibling names unique, tags unique per account — and every statement here carries
 * `user_id` twice when it addresses a record by id, so a foreign id matches nothing rather than
 * answering as somebody else's data.
 *
 * Two columns of the `shares` row are written from here (`folder_id`, `tags`) plus `is_enabled`, and
 * the tag list is stored as the JSON array of *names* `parseShareTags`/`serializeShareTags` describe.
 * A tag rename or delete therefore has to touch those arrays: the alternative — a stored array that
 * keeps naming a tag the account no longer has — is a filter and a published page that quietly stop
 * matching.
 */

import { ApiError } from '../lib/errors'
import { parseShareTags, serializeShareTags, type ShareRow } from './store'
import { shareTagElementSql } from './selection-sql'

/** One `share_folders` row, as the table stores it. */
export interface ShareFolderRow {
  id: string
  user_id: string
  parent_id: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  created_at: number
  updated_at: number
}

/** One `share_tags` row, as the table stores it. */
export interface ShareTagRow {
  id: string
  user_id: string
  name: string
  color: string | null
  is_pinned: number
  created_at: number
}

/** The columns the tree walk needs, so a depth or sibling check costs one narrow read. */
export interface ShareFolderOrderRow {
  id: string
  parent_id: string | null
  position: number
  created_at: number
}

/** The columns an organizer write needs from a `shares` row, in the shape the audit diff reads. */
export interface ShareOrganizeSnapshot {
  note_id: string
  slug: string
  folder_id: string | null
  tags: string | null
  is_enabled: number
  expires_at: number | null
  password_hash: string | null
}

export interface ShareFolderCreate {
  id: string
  parentId: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  now: number
}

export interface ShareTagCreate {
  id: string
  name: string
  color: string | null
  now: number
}

/** A chunk of statements small enough for one D1 batch, which is also the unit a write commits in. */
const STATEMENT_CHUNK = 50

const FOLDER_COLUMNS = 'id, user_id, parent_id, name, icon, color, position, created_at, updated_at'
const TAG_COLUMNS = 'id, user_id, name, color, is_pinned, created_at'

/** The folder columns a patch may write, as literal SQL fragments: the only interpolation in this file. */
const FOLDER_PATCH_SQL: Record<ShareFolderPatchColumn, string> = {
  name: 'name = ?',
  parent_id: 'parent_id = ?',
  icon: 'icon = ?',
  color: 'color = ?',
  position: 'position = ?',
}

export type ShareFolderPatchColumn = 'name' | 'parent_id' | 'icon' | 'color' | 'position'

/** The share columns a batch organize may write, same rule: names never come from the request. */
export type ShareOrganizeColumn = 'folder_id' | 'tags' | 'is_enabled'

const SHARE_PATCH_SQL: Record<ShareOrganizeColumn, string> = {
  folder_id: 'folder_id = ?',
  tags: 'tags = ?',
  is_enabled: 'is_enabled = ?',
}

export class ShareOrganizerStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  // --- folders -------------------------------------------------------------

  /** The account's whole folder tree, in the order the hub lists it. */
  async listFolders(): Promise<ShareFolderRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${FOLDER_COLUMNS} FROM share_folders WHERE user_id = ?1 ORDER BY position ASC, created_at ASC, id ASC`)
      .bind(this.userId)
      .all<ShareFolderRow>()
    return results ?? []
  }

  /** One folder of this account; a foreign or missing id reads as `null`, which the route answers 404. */
  async folderRow(id: string): Promise<ShareFolderRow | null> {
    const row = await this.db
      .prepare(`SELECT ${FOLDER_COLUMNS} FROM share_folders WHERE id = ?1 AND user_id = ?2`)
      .bind(id, this.userId)
      .first<ShareFolderRow>()
    return row ?? null
  }

  /** The tree as the depth, cycle and sibling-name rules need it: id, parent, position, created. */
  async folderOrderRows(): Promise<ShareFolderOrderRow[]> {
    const { results } = await this.db
      .prepare(`SELECT id, parent_id, position, created_at FROM share_folders WHERE user_id = ?1`)
      .bind(this.userId)
      .all<ShareFolderOrderRow>()
    return results ?? []
  }

  async countFolders(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM share_folders WHERE user_id = ?1`)
      .bind(this.userId)
      .first<{ n: number }>()
    return Number(row?.n ?? 0)
  }

  /**
   * Creates one folder.
   *
   * The sibling-name test runs before the insert so the answer is a 409 the hub can show rather than a
   * constraint message out of the database, and the insert itself is still wrapped: between the two a
   * second device can file the same name, and that race has to read the same way as the plain case.
   */
  async createFolder(input: ShareFolderCreate): Promise<ShareFolderRow> {
    const taken = await this.db
      .prepare(
        `SELECT id FROM share_folders
          WHERE user_id = ?1 AND IFNULL(parent_id, '') = IFNULL(?2, '') AND lower(name) = lower(?3)`,
      )
      .bind(this.userId, input.parentId, input.name)
      .first<{ id: string }>()
    if (taken) throw ApiError.conflict('A folder with this name already exists in the same place')
    try {
      await this.db
        .prepare(
          `INSERT INTO share_folders (${FOLDER_COLUMNS})
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          input.id,
          this.userId,
          input.parentId,
          input.name,
          input.icon,
          input.color,
          input.position,
          input.now,
          input.now,
        )
        .run()
    } catch (error) {
      throw uniqueSiblingError(error)
    }
    const row = await this.folderRow(input.id)
    if (!row) throw ApiError.conflict('The folder could not be created. Try again')
    return row
  }

  /**
   * Writes the named columns of one folder, guarded by the owner bind.
   *
   * Returns `null` when nothing matched: the id was not this account's, or it went away mid-request.
   * The caller already read the row it is patching, so a `null` here is the concurrent-move case.
   */
  async patchFolder(
    id: string,
    columns: Partial<Record<ShareFolderPatchColumn, string | number | null>>,
    updatedAt: number,
  ): Promise<ShareFolderRow | null> {
    const names = Object.keys(columns) as ShareFolderPatchColumn[]
    if (!names.length) return this.folderRow(id)
    let bind = 1
    const sets: string[] = []
    const values: Array<string | number | null> = []
    for (const name of names) {
      // The placeholder numbers are spelled out of a module-local fragment, never out of the request.
      sets.push(FOLDER_PATCH_SQL[name].replace('?', `?${bind}`))
      values.push(columns[name] ?? null)
      bind += 1
    }
    sets.push(`updated_at = ?${bind}`)
    values.push(updatedAt)
    bind += 1
    try {
      await this.db
        .prepare(`UPDATE share_folders SET ${sets.join(', ')} WHERE id = ?${bind} AND user_id = ?${bind + 1}`)
        .bind(...values, id, this.userId)
        .run()
    } catch (error) {
      throw uniqueSiblingError(error)
    }
    return this.folderRow(id)
  }

  /**
   * Deletes one folder, in one batch, with no link left pointing at it.
   *
   * The two detach rules are chosen, not incidental: a nested folder moves up into the folder that
   * held it (what the note-side organizer does), while the links filed in the deleted folder go to
   * *unfiled* rather than to the parent. A note that moves up stays in the same tree the owner built;
   * a link that moved up would join a published set the owner never put it in, because
   * `shares.folder_id` is also what a collection directory shows. Clearing it is the one answer that
   * cannot make a page gain a member on its own.
   */
  async deleteFolder(folder: ShareFolderRow): Promise<boolean> {
    const now = Date.now()
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE shares SET folder_id = NULL WHERE folder_id = ?1 AND user_id = ?2`)
        .bind(folder.id, this.userId),
      this.db
        .prepare(`UPDATE share_folders SET parent_id = ?3, updated_at = ?4 WHERE parent_id = ?1 AND user_id = ?2`)
        .bind(folder.id, this.userId, folder.parent_id, now),
      this.db
        .prepare(`DELETE FROM share_folders WHERE id = ?1 AND user_id = ?2`)
        .bind(folder.id, this.userId),
    ])
    return Boolean(results.at(-1)?.meta.changes)
  }

  // --- tags ----------------------------------------------------------------

  /** The account's tags, pinned first and then by name: the order the hub's sidebar lists. */
  async listTags(): Promise<ShareTagRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${TAG_COLUMNS} FROM share_tags WHERE user_id = ?1 ORDER BY is_pinned DESC, name ASC, id ASC`)
      .bind(this.userId)
      .all<ShareTagRow>()
    return results ?? []
  }

  async tagRow(id: string): Promise<ShareTagRow | null> {
    const row = await this.db
      .prepare(`SELECT ${TAG_COLUMNS} FROM share_tags WHERE id = ?1 AND user_id = ?2`)
      .bind(id, this.userId)
      .first<ShareTagRow>()
    return row ?? null
  }

  /** A tag by its exact stored name; the name is what a share's tag array carries. */
  async tagByName(name: string): Promise<ShareTagRow | null> {
    const row = await this.db
      .prepare(`SELECT ${TAG_COLUMNS} FROM share_tags WHERE user_id = ?1 AND name = ?2`)
      .bind(this.userId, name)
      .first<ShareTagRow>()
    return row ?? null
  }

  /** The stored names, of the ones asked for: what an organize request is resolved against. */
  async existingTagNames(names: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>()
    for (const chunk of chunked(names)) {
      if (!chunk.length) continue
      const { results } = await this.db
        .prepare(`SELECT name FROM share_tags WHERE user_id = ?1 AND name IN (${inList(2, chunk.length)})`)
        .bind(this.userId, ...chunk)
        .all<{ name: string }>()
      for (const row of results ?? []) found.add(row.name)
    }
    return found
  }

  async countTags(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM share_tags WHERE user_id = ?1`)
      .bind(this.userId)
      .first<{ n: number }>()
    return Number(row?.n ?? 0)
  }

  async createTag(input: ShareTagCreate): Promise<ShareTagRow> {
    const taken = await this.tagByName(input.name)
    if (taken) throw ApiError.conflict('A tag with this name already exists')
    try {
      await this.db
        .prepare(`INSERT INTO share_tags (${TAG_COLUMNS}) VALUES (?1, ?2, ?3, ?4, 0, ?5)`)
        .bind(input.id, this.userId, input.name, input.color, input.now)
        .run()
    } catch (error) {
      if (isUniqueViolation(error)) throw ApiError.conflict('A tag with this name already exists')
      throw error
    }
    const row = await this.tagRow(input.id)
    if (!row) throw ApiError.conflict('The tag could not be created. Try again')
    return row
  }

  /** Writes one tag's colour and pin. A rename is not this statement's business — see `renameTag`. */
  async patchTag(
    id: string,
    input: { color: string | null; isPinned: boolean },
  ): Promise<ShareTagRow | null> {
    await this.db
      .prepare(`UPDATE share_tags SET color = ?1, is_pinned = ?2 WHERE id = ?3 AND user_id = ?4`)
      .bind(input.color, input.isPinned ? 1 : 0, id, this.userId)
      .run()
    return this.tagRow(id)
  }

  /**
   * Renames a tag and carries the name across to every link that stores it.
   *
   * `shares.tags` holds names rather than ids, so a rename that only moved the record would leave the
   * old spelling on the links — a filter and a published page that stop matching the very tag they were
   * built for. The links are rewritten in the same chunked batches the delete uses.
   */
  async renameTag(
    tag: ShareTagRow,
    name: string,
    color: string | null,
  ): Promise<{ renamed: boolean; rewritten: number }> {
    const taken = await this.tagByName(name)
    if (taken && taken.id !== tag.id) throw ApiError.conflict(`A tag named "${name}" already exists`)
    const rewritten = await this.replaceTagNameEverywhere(tag.name, name)
    try {
      await this.db
        .prepare(`UPDATE share_tags SET name = ?1, color = ?2 WHERE id = ?3 AND user_id = ?4`)
        .bind(name, color, tag.id, this.userId)
        .run()
    } catch (error) {
      // The links already carry the new name, so a record that refused to move would be the worse half
      // of a rename: undo what was written and answer with the conflict instead. The undo is best-effort
      // — if it fails too, the original error is what the owner hears, and a link list naming a tag that
      // still exists under its old spelling is one the next rename finishes.
      await this.replaceTagNameEverywhere(name, tag.name)
      if (isUniqueViolation(error)) throw ApiError.conflict(`A tag named "${name}" already exists`)
      throw error
    }
    return { renamed: true, rewritten }
  }

  /**
   * Deletes a tag record and takes its name out of every link that carried it.
   *
   * The links are rewritten first and the record deleted after, because the rewrite is the part that has
   * to know the name: once the row is gone, nothing left in the account says what to look for. A link
   * that kept naming a deleted tag would match nothing anyway (`resolveShareTarget` answers `none` for a
   * target with no record), but it would go on *showing* a tag nobody can select or delete again. Every
   * statement is owner-scoped, so a foreign id detaches nothing.
   */
  async deleteTag(tag: ShareTagRow): Promise<{ removed: boolean; rewritten: number }> {
    const rewritten = await this.replaceTagNameEverywhere(tag.name, null)
    const result = await this.db
      .prepare(`DELETE FROM share_tags WHERE id = ?1 AND user_id = ?2`)
      .bind(tag.id, this.userId)
      .run()
    return { removed: Boolean(result.meta.changes), rewritten }
  }

  /**
   * Replaces one tag name across the account's links, or removes it when `to` is null.
   *
   * Read-then-write per row rather than one SQL rewrite: `json_each` can find the element but SQLite
   * has no in-place array element replace, and a `replace()` over the raw JSON text is a substring
   * test wearing a name's clothes — it would rename `report` inside `monthly-report`. The selection
   * predicate is the hub's own element rule, so the rows touched are exactly the rows that carry it.
   */
  async replaceTagNameEverywhere(from: string, to: string | null): Promise<number> {
    const { results } = await this.db
      .prepare(
        `SELECT note_id, tags FROM shares WHERE user_id = ?1 AND ${shareTagElementSql('shares', '?2')}`,
      )
      .bind(this.userId, from)
      .all<{ note_id: string; tags: string | null }>()
    const rows = results ?? []
    if (!rows.length) return 0
    const writes: Array<{ noteId: string; tags: string }> = []
    for (const row of rows) {
      const names = parseShareTags(row.tags)
      const next: string[] = []
      for (const name of names) {
        if (name !== from) {
          next.push(name)
          continue
        }
        if (to !== null && !next.includes(to)) next.push(to)
      }
      const json = serializeShareTags(next)
      if (json !== (row.tags ?? serializeShareTags(names))) writes.push({ noteId: row.note_id, tags: json })
    }
    return this.applyTagLists(writes)
  }

  /** Writes each link's whole tag list, chunked so one request cannot outgrow a D1 batch. */
  async applyTagLists(writes: Array<{ noteId: string; tags: string }>): Promise<number> {
    let applied = 0
    for (const chunk of chunked(writes, STATEMENT_CHUNK)) {
      if (!chunk.length) continue
      const results = await this.db.batch(
        chunk.map((entry) =>
          this.db
            .prepare(`UPDATE shares SET tags = ?1 WHERE note_id = ?2 AND user_id = ?3`)
            .bind(entry.tags, entry.noteId, this.userId),
        ),
      )
      applied += results.reduce((total, result) => total + (result.meta.changes ?? 0), 0)
    }
    return applied
  }

  // --- the links themselves ----------------------------------------------

  /** The links a set of notes has, for the before/after an audit entry is built from. */
  async organizeSnapshots(noteIds: readonly string[]): Promise<Map<string, ShareOrganizeSnapshot>> {
    const found = new Map<string, ShareOrganizeSnapshot>()
    for (const chunk of chunked(noteIds)) {
      if (!chunk.length) continue
      const { results } = await this.db
        .prepare(
          `SELECT note_id, slug, folder_id, tags, is_enabled, expires_at, password_hash
             FROM shares WHERE user_id = ?1 AND note_id IN (${inList(2, chunk.length)})`,
        )
        .bind(this.userId, ...chunk)
        .all<ShareOrganizeSnapshot>()
      for (const row of results ?? []) found.set(row.note_id, row)
    }
    return found
  }

  /** The one link of one of this account's notes, or `null` for "no link here". */
  async liveShare(noteId: string): Promise<ShareRow | null> {
    const row = await this.db
      .prepare(`SELECT * FROM shares WHERE note_id = ?1 AND user_id = ?2`)
      .bind(noteId, this.userId)
      .first<ShareRow>()
    return row ?? null
  }

  /**
   * Writes the filing columns of the notes named, in one statement per chunk.
   *
   * Only the columns the caller named are written — a batch organize that carries tags and no folder
   * leaves every link's folder alone — and `note_id IN (...)` plus the owner bind means a foreign or
   * revoked note simply is not in the count that comes back.
   */
  async patchShares(
    noteIds: readonly string[],
    columns: Partial<Record<ShareOrganizeColumn, string | number | null>>,
  ): Promise<number> {
    const names = Object.keys(columns) as ShareOrganizeColumn[]
    if (!names.length || !noteIds.length) return 0
    const sets = names.map((name, index) => SHARE_PATCH_SQL[name].replace('?', `?${index + 1}`))
    const values = names.map((name) => columns[name] ?? null)
    let applied = 0
    for (const chunk of chunked(noteIds)) {
      if (!chunk.length) continue
      const firstIdBind = names.length + 1
      const idBinds = chunk.map((_, index) => `?${firstIdBind + index}`).join(', ')
      const userBind = firstIdBind + chunk.length
      const result = await this.db
        .prepare(
          `UPDATE shares SET ${sets.join(', ')} WHERE user_id = ?${userBind} AND note_id IN (${idBinds})`,
        )
        .bind(...values, ...chunk, this.userId)
        .run()
      applied += result.meta.changes ?? 0
    }
    return applied
  }

  /**
   * Revokes the links of the notes named.
   *
   * The passcode sessions go first, addressed by the subquery over the still-present rows: a session
   * that outlived its link would keep serving an attachment path for a page nobody can reach any more.
   */
  async revokeShares(noteIds: readonly string[]): Promise<number> {
    let removed = 0
    for (const chunk of chunked(noteIds)) {
      if (!chunk.length) continue
      const list = inList(2, chunk.length)
      const results = await this.db.batch([
        this.db
          .prepare(
            `DELETE FROM share_asset_sessions
              WHERE slug IN (SELECT slug FROM shares WHERE user_id = ?1 AND note_id IN (${list}))`,
          )
          .bind(this.userId, ...chunk),
        this.db
          .prepare(`DELETE FROM shares WHERE user_id = ?1 AND note_id IN (${list})`)
          .bind(this.userId, ...chunk),
      ])
      removed += results.at(-1)?.meta.changes ?? 0
    }
    return removed
  }

  /**
   * The links of this account's notes that a hand-picked collection may hold.
   *
   * Only ids that answer are kept, so a member list cannot name a note the account does not own; the
   * caller reports how many of what it asked for actually landed.
   */
  async shareHoldingNotes(noteIds: readonly string[]): Promise<string[]> {
    const held: string[] = []
    for (const chunk of chunked(noteIds)) {
      if (!chunk.length) continue
      const { results } = await this.db
        .prepare(
          `SELECT s.note_id FROM shares s JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
            WHERE s.user_id = ?1 AND n.deleted_at IS NULL AND s.note_id IN (${inList(2, chunk.length)})`,
        )
        .bind(this.userId, ...chunk)
        .all<{ note_id: string }>()
      for (const row of results ?? []) held.push(row.note_id)
    }
    return held
  }
}

function uniqueSiblingError(error: unknown): unknown {
  if (isUniqueViolation(error)) {
    return ApiError.conflict('A folder with this name already exists in the same place')
  }
  return error
}

/** Whether a database error is a constraint the hub already answers with a 409. */
export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('UNIQUE') || message.includes('constraint')
}

/** An `IN (...)` list whose placeholders start at `firstBind`, which is how every statement here is numbered. */
function inList(firstBind: number, count: number): string {
  return Array.from({ length: count }, (_, index) => `?${firstBind + index}`).join(', ')
}

function chunked<T>(items: readonly T[], size = STATEMENT_CHUNK): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}
