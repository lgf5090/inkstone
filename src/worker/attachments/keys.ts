import { extensionFor } from '../lib/image'

export interface StoredAttachmentKey {
  id: string
  user_id: string
  mime: string
  filename: string
}

export type AttachmentObjectStorage = 'r2' | 'kv'

export function attachmentObjectKey(row: StoredAttachmentKey): string {
  return `${row.user_id}/${row.id}.${extensionFor(row.mime, row.filename)}`
}

export function memoAttachmentObjectKey(row: StoredAttachmentKey): string {
  return `memo/${row.user_id}/${row.id}.${extensionFor(row.mime, row.filename)}`
}

export function memoThumbnailObjectKey(row: StoredAttachmentKey): string {
  return `memo/${row.user_id}/${row.id}-thumb.${extensionFor(row.mime, row.filename)}`
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
