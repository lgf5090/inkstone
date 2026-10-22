/**
 * Every read and write the files HTTP routes make against D1.
 *
 * The shape follows `notes/store.ts` and `assistant/store.ts`: a store built per request from the
 * account it serves, methods that take already-validated input and hand back rows or the answer the
 * route needs, and nothing in between that knows about HTTP. Storing and reading the bytes themselves
 * is not here: that is `attachments/storage.ts` and `attachments/backend.ts`, which take the whole
 * `Env` because an upload lands in R2 or KV and in D1 at once.
 *
 * Two rules hold throughout:
 *  - every statement binds `user_id`, so one account's files cannot surface in another's listing. The
 *    two statements the anonymous share read uses are the deliberate exceptions: an attachment is looked
 *    up by id before anyone knows who is asking, and the caller compares the row's `user_id` against the
 *    session, while the share lookup is scoped by the `user_id` that row just named.
 *  - a mutation's statements stay in the one D1 batch they are written in today. The cleanup row, the
 *    mapping delete and the attachment delete only mean "this file left the account exactly once" while
 *    they land together.
 */

import type { AttachmentObjectStorage } from './keys'
import { attachmentCleanupTarget, attachmentObjectKey } from './keys'

export interface AttachmentRow {
  id: string
  user_id: string
  note_id: string | null
  filename: string
  mime: string
  size: number
  sha256: string
  object_key: string | null
  width: number | null
  height: number | null
  storage: AttachmentObjectStorage
  created_at: number
}


/** A row as the share read needs it: the note body is scanned for the id the reader asked for. */
export interface ShareAssetRow {
  slug: string
  password_hash: string | null
  content: string
}

/** The last row of a page, in the order the listing sorted it. */
export interface AttachmentListCursor {
  createdAt: number
  id: string
}

export interface AttachmentListPage {
  /** The page, with the extra row the store asked for already dropped. */
  rows: AttachmentRow[]
  /** Whether one more row was waiting behind the page, which is what makes `nextCursor`. */
  hasMore: boolean
}

/** Attachments per keyset page while listing them for the client. */
const ATTACHMENT_LIST_PAGE_SIZE = 500
/** Rows per page while the prune walks the account. */
const ATTACHMENT_SCAN_PAGE_SIZE = 100
/** Statements per prune batch: three per attachment, so a full page is split rather than sent whole. */
const PRUNE_STATEMENT_LIMIT = 100

/** The row a prune walk stops at: newest first, so a file landing mid-walk is left for the next run. */
export interface PruneBoundary {
  created_at: number
  id: string
}

export interface PruneStart {
  boundary: PruneBoundary
  /** `changes.seq` for notes at the moment the walk began; 0 when the account has written nothing. */
  scanCursor: number
}

export interface PruneOutcome {
  removed: number
  freedBytes: number
}

/** The columns a listing reads. `sha256` is only the read path's, so the list spells its own set. */
const ATTACHMENT_LIST_COLUMNS = 'id, user_id, note_id, filename, mime, size, width, height, object_key, storage, created_at'


/**
 * One attachment, by id alone.
 *
 * The share read has no account to scope by until it has the row: the caller decides who may see it by
 * comparing `user_id` against the session, and an anonymous request against a slug that names this row's
 * owner. Widening this to a `user_id` filter would break the second case, not the first.
 */
export function attachmentById(db: D1Database, id: string): Promise<AttachmentRow | null> {
  return db.prepare(
    `SELECT id, user_id, note_id, filename, mime, size, sha256, object_key, width, height, storage, created_at
       FROM attachments WHERE id = ?1`,
  ).bind(id).first<AttachmentRow>()
}

/**
 * The share that could vouch for an asset, as the row's owner published it.
 *
 * `userId` is the attachment row's own, never the caller's: the join keeps a share from lending a note
 * that belongs to a different account than the one that made it.
 */
export async function shareForAsset(
  db: D1Database,
  slug: string,
  userId: string,
): Promise<ShareAssetRow | null> {
  return db.prepare(
    `SELECT s.slug, s.password_hash, n.content
       FROM shares s
       JOIN notes n ON n.id = s.note_id AND n.user_id = s.user_id
      WHERE s.slug = ?1 AND s.user_id = ?2 AND n.deleted_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > ?3)`,
  )
    .bind(slug, userId, Date.now())
    .first<ShareAssetRow>()
}

export class AttachmentsStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /** The newest attachment whose name matches, compared case-insensitively. */
  async byFilename(filename: string): Promise<AttachmentRow | null> {
    return this.db.prepare(
      `SELECT ${ATTACHMENT_LIST_COLUMNS}
         FROM attachments WHERE user_id = ?1 AND lower(filename) = ?2
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
      .bind(this.userId, filename)
      .first<AttachmentRow>()
  }

  /**
   * One keyset page of the notebook's files, newest first, with whether another page follows.
   *
   * Narrowed to `scope = 'notes'` because task uploads share this table: without it the notebook's
   * own listing shows files a task is holding, and the reader can delete one from a screen that
   * never tells them a task will lose it.
   */
  async listPage(cursor: AttachmentListCursor | null): Promise<AttachmentListPage> {
    const statement = cursor
      ? this.db.prepare(
          `SELECT ${ATTACHMENT_LIST_COLUMNS}
             FROM attachments WHERE user_id = ?1 AND scope = 'notes'
              AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
            ORDER BY created_at DESC, id DESC LIMIT ?4`,
        ).bind(this.userId, cursor.createdAt, cursor.id, ATTACHMENT_LIST_PAGE_SIZE + 1)
      : this.db.prepare(
          `SELECT ${ATTACHMENT_LIST_COLUMNS}
             FROM attachments WHERE user_id = ?1 AND scope = 'notes'
            ORDER BY created_at DESC, id DESC LIMIT ?2`,
        ).bind(this.userId, ATTACHMENT_LIST_PAGE_SIZE + 1)
    const { results } = await statement.all<AttachmentRow>()
    return {
      rows: results.slice(0, ATTACHMENT_LIST_PAGE_SIZE),
      hasMore: results.length > ATTACHMENT_LIST_PAGE_SIZE,
    }
  }

  /** Whether a note the upload wants to hang off is one this account still has. */
  async noteIsLive(noteId: string): Promise<boolean> {
    const owned = await this.db.prepare(
      `SELECT id FROM notes WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
    )
      .bind(noteId, this.userId)
      .first<{ id: string }>()
    return Boolean(owned)
  }

  /** The row a deletion is answered from: the object it has to release and the account it belongs to. */
  async forDeletion(id: string): Promise<AttachmentRow | null> {
    return this.db.prepare(
      `SELECT id, user_id, filename, mime, object_key, storage FROM attachments WHERE id = ?1 AND user_id = ?2`,
    )
      .bind(id, this.userId)
      .first<AttachmentRow>()
  }

  /**
   * Queue the object for cleanup, drop the import mapping, drop the row, in one batch.
   *
   * The cleanup row is written from the attachment itself (`SELECT ... FROM attachments WHERE id AND
   * user_id`), so an object key cannot be queued for a file that is not this account's. False means the
   * row was gone before this batch ran.
   */
  async delete(row: AttachmentRow): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
         SELECT ?1, user_id, ?2 FROM attachments WHERE id = ?3 AND user_id = ?4`,
      ).bind(attachmentCleanupTarget(row.storage, attachmentObjectKey(row)), Date.now(), row.id, this.userId),
      this.db.prepare(
        `DELETE FROM import_mappings
          WHERE user_id = ?1 AND entity = 'attachment' AND target_id = ?2`,
      ).bind(this.userId, row.id),
      this.db.prepare(`DELETE FROM attachments WHERE id = ?1 AND user_id = ?2`).bind(row.id, this.userId),
    ])
    return Boolean(results.at(-1)?.meta.changes)
  }

  /**
   * Where a prune walk starts and which note change it has to stay ahead of.
   *
   * The two reads land in one batch, as they did in the route: the boundary and the note `changes.seq`
   * are decided together, and taking them apart would let a note edit slip between the two, which makes
   * the freshness guard judge a cursor that is already behind the walk.
   */
  async pruneStart(): Promise<PruneStart | null> {
    const [boundaryResult, cursorResult] = await this.db.batch([
      this.db.prepare(
        `SELECT created_at, id FROM attachments
          WHERE user_id = ?1 AND scope = 'notes' ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).bind(this.userId),
      this.db.prepare(
        `SELECT seq FROM changes WHERE user_id = ?1 AND entity = 'note'
          ORDER BY seq DESC LIMIT 1`,
      ).bind(this.userId),
    ])
    const boundary = (boundaryResult as D1Result<{ created_at: number; id: string }>).results[0]
    if (!boundary) return null
    return {
      boundary,
      scanCursor: (cursorResult as D1Result<{ seq: number }>).results[0]?.seq ?? 0,
    }
  }

  /** Every id the walk will consider, oldest first up to and including the boundary row. */
  async idsThroughBoundary(boundary: PruneBoundary): Promise<Set<string>> {
    const ids = new Set<string>()
    let cursor: AttachmentListCursor | null = null
    while (true) {
      const rows = await this.scanIdPage(boundary, cursor)
      if (!rows.length) break
      for (const row of rows) ids.add(row.id)
      const last = rows[rows.length - 1]!
      cursor = { createdAt: last.created_at, id: last.id }
      if (rows.length < ATTACHMENT_SCAN_PAGE_SIZE) break
    }
    return ids
  }

  /**
   * Delete what no note or retained version names, one batched chunk at a time.
   *
   * A page of rows is not one batch: three statements per attachment would put a full page's 300 writes
   * in a single `batch`, so the chunk is capped at `PRUNE_STATEMENT_LIMIT` exactly as the route capped
   * it. The `stale` flag rides into every statement, so a note edit that lands mid-page turns this
   * page's deletes into no-ops rather than racing the reference scan.
   */
  async pruneUnreferenced(
    { boundary, scanCursor }: PruneStart,
    referenced: ReadonlyMap<string, number>,
  ): Promise<PruneOutcome> {
    let removed = 0
    let freedBytes = 0
    let statements: D1PreparedStatement[] = []
    const operations: Array<
      { kind: 'queue' | 'mapping' } | { kind: 'delete'; file: AttachmentRow }
    > = []

    const flush = async () => {
      if (!statements.length) return
      const results = await this.db.batch(statements)
      results.forEach((result, index) => {
        const operation = operations[index]
        if (operation?.kind === 'delete' && result.meta.changes) {
          removed += 1
          freedBytes += operation.file.size
        }
      })
      statements = []
      operations.length = 0
    }

    let pageCursor: AttachmentListCursor | null = null
    while (true) {
      const files = await this.scanPage(boundary, pageCursor)
      if (!files.length) break

      // One freshness probe per page replaces the NOT EXISTS subquery that used to run for
      // every attachment and every statement; a change landing mid-page only defers the
      // remaining rows to the next prune, which is what the guard already tolerated.
      const stale = await this.pruneStale(scanCursor)

      for (const file of files) {
        if (referenced.has(file.id)) continue
        const guard = `id = ?1 AND user_id = ?2 AND scope = 'notes' AND ?6 = 0`
        const needed = 3
        if (statements.length + needed > PRUNE_STATEMENT_LIMIT) await flush()
        statements.push(
          this.db.prepare(
            `INSERT OR IGNORE INTO attachment_cleanup (object_key, user_id, created_at)
             SELECT ?4, user_id, ?5 FROM attachments WHERE ${guard}`,
          ).bind(
            file.id,
            this.userId,
            scanCursor,
            attachmentCleanupTarget(file.storage, attachmentObjectKey(file)),
            Date.now(),
            stale,
          ),
        )
        operations.push({ kind: 'queue' })
        statements.push(
          this.db.prepare(
            `DELETE FROM import_mappings
              WHERE user_id = ?1 AND entity = 'attachment' AND target_id = ?2
                AND EXISTS (
                  SELECT 1 FROM attachments a WHERE a.id = ?2 AND a.user_id = ?1 AND ?4 = 0
                )`,
          ).bind(this.userId, file.id, scanCursor, stale),
        )
        operations.push({ kind: 'mapping' })
        statements.push(
          this.db.prepare(`DELETE FROM attachments WHERE id = ?1 AND user_id = ?2 AND scope = 'notes' AND ?3 = 0`)
            .bind(file.id, this.userId, stale),
        )
        operations.push({ kind: 'delete', file })
      }
      const last: AttachmentRow = files[files.length - 1]!
      pageCursor = { createdAt: last.created_at, id: last.id }
      if (files.length < ATTACHMENT_SCAN_PAGE_SIZE) break
    }
    await flush()
    return { removed, freedBytes }
  }

  /**
   * One ascending page of the ids only, bounded above by the walk's boundary row.
   *
   * Narrower than `scanPage` on purpose: this pass decides what may be unreferenced, and the whole
   * listing payload would cross the wire for nothing.
   */
  private async scanIdPage(
    boundary: PruneBoundary,
    cursor: AttachmentListCursor | null,
  ): Promise<Array<{ created_at: number; id: string }>> {
    const query: D1PreparedStatement = cursor
      ? this.db.prepare(
          `SELECT created_at, id FROM attachments WHERE user_id = ?1 AND scope = 'notes'
            AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
            AND (created_at > ?4 OR (created_at = ?4 AND id > ?5))
           ORDER BY created_at ASC, id ASC LIMIT ?6`,
        ).bind(
          this.userId,
          boundary.created_at,
          boundary.id,
          cursor.createdAt,
          cursor.id,
          ATTACHMENT_SCAN_PAGE_SIZE,
        )
      : this.db.prepare(
          `SELECT created_at, id FROM attachments WHERE user_id = ?1 AND scope = 'notes'
            AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
           ORDER BY created_at ASC, id ASC LIMIT ?4`,
        ).bind(this.userId, boundary.created_at, boundary.id, ATTACHMENT_SCAN_PAGE_SIZE)
    return (await query.all<{ created_at: number; id: string }>()).results
  }

  /** One ascending page of whole rows, on the same walk and the same boundary. */
  private async scanPage(boundary: PruneBoundary, cursor: AttachmentListCursor | null): Promise<AttachmentRow[]> {
    const query: D1PreparedStatement = cursor
      ? this.db.prepare(
          `SELECT ${ATTACHMENT_LIST_COLUMNS}
             FROM attachments WHERE user_id = ?1 AND scope = 'notes'
              AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
              AND (created_at > ?4 OR (created_at = ?4 AND id > ?5))
            ORDER BY created_at ASC, id ASC LIMIT ?6`,
        ).bind(
          this.userId,
          boundary.created_at,
          boundary.id,
          cursor.createdAt,
          cursor.id,
          ATTACHMENT_SCAN_PAGE_SIZE,
        )
      : this.db.prepare(
          `SELECT ${ATTACHMENT_LIST_COLUMNS}
             FROM attachments WHERE user_id = ?1 AND scope = 'notes'
              AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3))
            ORDER BY created_at ASC, id ASC LIMIT ?4`,
        ).bind(this.userId, boundary.created_at, boundary.id, ATTACHMENT_SCAN_PAGE_SIZE)
    return (await query.all<AttachmentRow>()).results
  }

  /** 1 when a note change landed after `scanCursor`, i.e. the prune must hold off. */
  private async pruneStale(scanCursor: number): Promise<number> {
    const row = await this.db.prepare(
      `SELECT EXISTS (
         SELECT 1 FROM changes WHERE user_id = ?1 AND entity = 'note' AND seq > ?2
       ) AS fresh`,
    ).bind(this.userId, scanCursor).first<{ fresh: number }>()
    return row?.fresh ? 1 : 0
  }
}
