import { extensionFor } from '../lib/image'
import { attachmentScope, type AttachmentScope } from './scopes'

export interface StoredAttachmentKey {
  id: string
  user_id: string
  mime: string
  filename: string
  /**
   * The key the object was written under; null for rows that predate the hub.
   *
   * Required rather than optional on purpose. A caller that leaves it out of its `SELECT` gets an
   * object key from the pre-hub branch, which resolves for every old row and for none of the new
   * ones — a failure that shows up as files that simply cannot be opened any more.
   */
  object_key: string | null
}


export type AttachmentObjectStorage = 'r2' | 'kv'

/**
 * The object key a row's bytes live under.
 *
 * The persisted key wins. Deriving it from mutable columns instead would mean a rename or a
 * re-file can move an object out from under its own row, which is how the pre-hub layout ended up
 * recomputed identically in eight places that each had to agree with the writer by luck.
 *
 * A null `object_key` is not missing data: it marks a row written before the hub, whose bytes sit in
 * the flat unprefixed layout. Those rows keep resolving the old way, so no backfill has to
 * reproduce the extension rule in SQL and no object has to move. New uploads persist their key.
 */
export function attachmentObjectKey(row: StoredAttachmentKey): string {
  const extension = extensionFor(row.mime, row.filename)
  if (!row.object_key) return `${row.user_id}/${row.id}.${extension}`
  return row.object_key
}

/** The columns needed to choose a key for an object that has no row to read one back from. */
export type NewAttachmentKeyRow = Pick<StoredAttachmentKey, 'user_id' | 'id' | 'mime' | 'filename'>

/** The key a scope's newest object will be written under, and the only place a prefix is chosen. */
export function newAttachmentObjectKey(
  scope: AttachmentScope,
  row: NewAttachmentKeyRow,
): string {
  const extension = extensionFor(row.mime, row.filename)
  return `${attachmentScope(scope).prefix}/${row.user_id}/${row.id}.${extension}`
}

export function memoAttachmentObjectKey(row: NewAttachmentKeyRow): string {
  return newAttachmentObjectKey('memos', row)
}

export function memoThumbnailObjectKey(row: NewAttachmentKeyRow): string {
  const extension = extensionFor(row.mime, row.filename)
  return `memos/${row.user_id}/${row.id}-thumb.${extension}`
}


export function attachmentCleanupTarget(storage: AttachmentObjectStorage, key: string): string {
  return `${storage}:${key}`
}

export function parseAttachmentCleanupTarget(value: string): {
  storage: AttachmentObjectStorage
  key: string
} | null {
  if (value.startsWith('kv:') && value.length > 3) return { storage: 'kv', key: value.slice(3) }
  if (value.startsWith('r2:') && value.length > 3) return { storage: 'r2', key: value.slice(3) }
  return null
}
