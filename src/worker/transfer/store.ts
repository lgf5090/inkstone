/**
 * Every read and write the transfer HTTP routes make against D1.
 *
 * The shape follows `notes/store.ts`, `tags/store.ts` and `attachments/store.ts`: a store built per
 * request from the account it serves, methods that take already-validated input and hand back rows,
 * counts or identifiers, and nothing in between that knows about HTTP. Two rules hold throughout:
 *  - every statement binds `user_id`. The one exception is spelled out next to it: an attachment read
 *    addresses ids a restore brought in from another account's export, which is only answerable across
 *    accounts, and the caller checks each returned row's `user_id` against its own account;
 *  - a mutation's statements stay in the one D1 batch they are written in today. Chunk sizes and the
 *    order of statements inside a batch decide what a partially applied restore looks like, so they
 *    are copied rather than tidied.
 *
 * What stays with the route: form parsing and size limits, the `ApiError` codes and message strings,
 * the warning list and its cap, the storage-key reading that turns cleanup object keys into ids, the
 * byte persistence and rollback in `attachments/storage.ts`, and the drains and cursor broadcast that
 * ride `waitUntil`.
 */

import type { AttachmentObjectStorage } from '../attachments/keys'
import { runBatched } from '../db/writes'

/** The attachment columns a restore compares against before it decides to re-store bytes. */
export interface ExistingAttachmentRow {
  id: string
  user_id: string
  filename: string
  mime: string
  size: number
  sha256: string
  storage: AttachmentObjectStorage
}

/** One restore decision the route has made: which source id now answers to which stored row. */
export interface ImportMappingWrite {
  sourceId: string
  targetId: string
}

/** A note link an imported attachment has to be re-parented to. */
export interface AttachmentNoteLink {
  id: string
  noteId: string | null
}

/** Ids per lookup chunk: D1 binds every placeholder, so a restore's id list is paged. */
const LOOKUP_CHUNK = 80
/** Attachment links per batch: one statement per row, and a batch cannot grow without bound. */
const LINK_BATCH = 100

export class TransferStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
    /**
     * Whether this database has the FTS index.
     *
     * A property of the connection, decided once per request by `db/fts.ts`; the note writes queued
     * from here index only when it is set.
     */
    readonly ftsEnabled: boolean,
  ) {}

  /**
   * The two lookups a restored attachment needs — the import mapping for this hash, and the oldest
   * attachment that already carries it — in one round trip. They used to run as separate queries for
   * every entry of a restore.
   */
  async restoredAttachment(sha256: string): Promise<{ mapped?: ExistingAttachmentRow, byHash?: ExistingAttachmentRow }> {
    const [mapping, hash] = await this.db.batch([
      this.db.prepare(
        `SELECT a.id, a.user_id, a.filename, a.mime, a.size, a.sha256, a.storage
           FROM import_mappings m
           JOIN attachments a ON a.id = m.target_id AND a.user_id = m.user_id
          WHERE m.user_id = ?1 AND m.entity = 'attachment' AND m.source_id = ?2`,
      ).bind(this.userId, sha256),
      this.db.prepare(
        `SELECT id, user_id, filename, mime, size, sha256, storage
           FROM attachments
          WHERE user_id = ?1 AND sha256 = ?2
          ORDER BY created_at ASC, id ASC LIMIT 1`,
      ).bind(this.userId, sha256),
    ])
    return {
      mapped: mapping?.results?.[0] as ExistingAttachmentRow | undefined,
      byHash: hash?.results?.[0] as ExistingAttachmentRow | undefined,
    }
  }

  /**
   * Which attachment id this account already restored for each source hash.
   *
   * A note cannot be written before the attachments its body links to exist, so the restore asks for
   * every hash its manifest names and the caller refuses the note when one is missing.
   */
  async attachmentTargetsByHash(hashes: readonly string[]): Promise<Map<string, string>> {
    const targets = new Map<string, string>()
    for (let offset = 0; offset < hashes.length; offset += LOOKUP_CHUNK) {
      const chunk = hashes.slice(offset, offset + LOOKUP_CHUNK)
      const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
      const { results } = await this.db.prepare(
        `SELECT m.source_id, m.target_id FROM import_mappings m
          JOIN attachments a ON a.id = m.target_id AND a.user_id = m.user_id
         WHERE m.user_id = ?1 AND m.entity = 'attachment'
           AND m.source_id IN (${placeholders})`,
      ).bind(this.userId, ...chunk).all<{ source_id: string; target_id: string }>()
      for (const row of results) targets.set(row.source_id, row.target_id)
    }
    return targets
  }

  /**
   * The attachments this restore already knows about, keyed by the id the export used.
   *
   * Two sequential reads per chunk, in the order they have always run: the account's own mapping for
   * that source id, then the attachment rows whose id equals it. The second is the one statement here
   * with no `user_id` filter, because a restore carries another account's attachment ids and has to
   * learn whether one of them collides with a live row before it can pick a destination id; the caller
   * compares each row's `user_id` against its own account and treats a mismatch as "not mine".
   */
  async attachmentsByIds(ids: readonly string[]): Promise<Map<string, ExistingAttachmentRow>> {
    const attachments = new Map<string, ExistingAttachmentRow>()
    for (let offset = 0; offset < ids.length; offset += LOOKUP_CHUNK) {
      const chunk = ids.slice(offset, offset + LOOKUP_CHUNK)
      const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
      const { results: mappedRows } = await this.db.prepare(
        `SELECT m.source_id, a.id, a.user_id, a.filename, a.mime, a.size, a.sha256, a.storage
           FROM import_mappings m
           JOIN attachments a ON a.id = m.target_id AND a.user_id = m.user_id
          WHERE m.user_id = ?1 AND m.entity = 'attachment'
            AND m.source_id IN (${placeholders})`,
      )
        .bind(this.userId, ...chunk)
        .all<ExistingAttachmentRow & { source_id: string }>()
      const mapped = new Map(mappedRows.map((row) => [row.source_id, row]))

      const directPlaceholders = chunk.map((_, index) => `?${index + 1}`).join(', ')
      const { results: directRows } = await this.db.prepare(
        `SELECT id, user_id, filename, mime, size, sha256, storage
           FROM attachments WHERE id IN (${directPlaceholders})`,
      )
        .bind(...chunk)
        .all<ExistingAttachmentRow>()
      const direct = new Map(directRows.map((row) => [row.id, row]))

      for (const sourceId of chunk) {
        const row = mapped.get(sourceId) ?? direct.get(sourceId)
        if (row) attachments.set(sourceId, row)
      }
    }
    return attachments
  }

  /**
   * The cleanup-queue object keys that still hold bytes for this account.
   *
   * Scoped by `user_id` and by the key's own prefix, which the SQL matches positionally because the
   * queue table stores a backend prefix, the account and the file name as one string. Turning those
   * keys back into attachment ids is a storage-key question, not a SQL one, so the caller reads the
   * keys and does it.
   */
  async pendingCleanupObjectKeys(sourceIds: readonly string[]): Promise<string[]> {
    if (!sourceIds.length) return []
    const { results } = await this.db.prepare(
      `SELECT object_key FROM attachment_cleanup
        WHERE user_id = ?1
          AND substr(object_key, 4, length(?1) + 1) = ?1 || '/'
          AND substr(object_key, length(?1) + 5, 26) IN (
            SELECT value FROM json_each(?2)
          )
          AND substr(object_key, length(?1) + 31, 1) = '.'`,
    ).bind(this.userId, JSON.stringify(sourceIds)).all<{ object_key: string }>()
    return results.map((row) => row.object_key)
  }

  /**
   * Point restored attachments at the notes that reference them, one batch per `LINK_BATCH` rows.
   *
   * `noteId` is already the destination note id or `null`; mapping the export's own ids to it is the
   * route's business. Every statement carries `user_id`, so a link cannot re-parent another account's
   * file even when an id collides.
   */
  async setAttachmentNoteLinks(links: readonly AttachmentNoteLink[]): Promise<void> {
    for (let offset = 0; offset < links.length; offset += LINK_BATCH) {
      await this.db.batch(
        links.slice(offset, offset + LINK_BATCH).map((entry) =>
          this.db.prepare(
            `UPDATE attachments SET note_id = ?1 WHERE id = ?2 AND user_id = ?3`,
          ).bind(entry.noteId, entry.id, this.userId),
        ),
      )
    }
  }

  /**
   * Record what an export id restored to, for notes and attachments alike.
   *
   * `runBatched` keeps the statements in fixed-size batches, and the upsert means a second restore of
   * the same export re-points the mapping instead of failing on it.
   */
  async upsertImportMappings(
    entity: 'note' | 'attachment',
    mappings: readonly ImportMappingWrite[],
  ): Promise<void> {
    const now = Date.now()
    await runBatched(
      this.db,
      mappings.map(({ sourceId, targetId }) =>
        this.db.prepare(
          `INSERT INTO import_mappings (user_id, entity, source_id, target_id, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(user_id, entity, source_id) DO UPDATE SET
             target_id = excluded.target_id,
             updated_at = excluded.updated_at`,
        ).bind(this.userId, entity, sourceId, targetId, now),
      ),
    )
  }
}
