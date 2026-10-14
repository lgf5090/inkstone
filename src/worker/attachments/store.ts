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

/** The columns a listing reads. `sha256` is only the read path's, so the list spells its own set. */
const ATTACHMENT_LIST_COLUMNS = 'id, user_id, note_id, filename, mime, size, width, height, storage, created_at'

/**
 * One attachment, by id alone.
 *
 * The share read has no account to scope by until it has the row: the caller decides who may see it by
 * comparing `user_id` against the session, and an anonymous request against a slug that names this row's
 * owner. Widening this to a `user_id` filter would break the second case, not the first.
 */
export function attachmentById(db: D1Database, id: string): Promise<AttachmentRow | null> {
  return db.prepare(
    `SELECT id, user_id, note_id, filename, mime, size, sha256, width, height, storage, created_at
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

  /** One keyset page of the account's files, newest first, with whether another page follows. */
  async listPage(cursor: AttachmentListCursor | null): Promise<AttachmentListPage> {
    const statement = cursor
      ? this.db.prepare(
          `SELECT ${ATTACHMENT_LIST_COLUMNS}
             FROM attachments WHERE user_id = ?1
              AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))
            ORDER BY created_at DESC, id DESC LIMIT ?4`,
        ).bind(this.userId, cursor.createdAt, cursor.id, ATTACHMENT_LIST_PAGE_SIZE + 1)
      : this.db.prepare(
          `SELECT ${ATTACHMENT_LIST_COLUMNS}
             FROM attachments WHERE user_id = ?1
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
      `SELECT id, user_id, filename, mime, storage FROM attachments WHERE id = ?1 AND user_id = ?2`,
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
}
