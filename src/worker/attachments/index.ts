/** Object storage entry points shared with other worker modules. */
export {
  attachmentQuotaBytesForEnv,
  deleteAttachmentObjects,
  hasAttachmentStorage,
  putAttachmentObject,
  readAttachmentObject,
  readAttachmentObjectRange,
  readAttachmentObjectStream,
  selectAttachmentStorage,
} from './backend'
export type { AttachmentObjectMetadata, AttachmentObjectStream } from './backend'
export { drainAttachmentCleanup } from './cleanup'
export {
  attachmentCleanupTarget,
  memoAttachmentObjectKey,
  memoThumbnailObjectKey,
} from './keys'
export type { AttachmentObjectStorage, StoredAttachmentKey } from './keys'
export { sanitizeAttachmentFilename, withAttachmentQuotaLease } from './storage'
