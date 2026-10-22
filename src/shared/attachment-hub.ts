/**
 * The attachment hub's wire contract.
 *
 * One shape for all four applications: the scope travels as a path segment, and everything else —
 * filtering, organising, counting usage — is the same request in every application. What differs
 * per application is server-side only (which table, which object prefix, which content holds the
 * references), so a client that works for one works for all four.
 */

export const ATTACHMENT_HUB_SCOPES = ['notes', 'todos', 'memos', 'chat', 'email'] as const

export type AttachmentHubScope = (typeof ATTACHMENT_HUB_SCOPES)[number]

export function isAttachmentHubScope(value: unknown): value is AttachmentHubScope {
  return (
    typeof value === 'string' &&
    (ATTACHMENT_HUB_SCOPES as readonly string[]).includes(value)
  )
}

/** A file as the hub presents it. `url` is served by the owning application's existing door. */
export interface HubAttachment {
  id: string
  scope: AttachmentHubScope
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  url: string
  thumbnailUrl?: string | null
  folderId: string | null
  isStarred: boolean
  isPinned: boolean
  tags: string[]
  /** Where the file is used, for the "insert into" action and the inspector's back-link. */
  ownerId: string | null
  createdAt: number
}

export interface HubAttachmentWithUsage extends HubAttachment {
  references: number
}

export type HubAttachmentType = 'image' | 'pdf' | 'document' | 'media' | 'archive' | 'code'

export type HubAttachmentSizeRange = 'small' | 'medium' | 'large'

export type HubAttachmentSort =
  | 'date_desc'
  | 'date_asc'
  | 'name_asc'
  | 'name_desc'
  | 'size_desc'
  | 'size_asc'

export interface HubAttachmentListParams {
  folderId?: string | null
  /** `'unfiled'` asks for the files no folder has claimed. */
  type?: HubAttachmentType
  sizeRange?: HubAttachmentSizeRange
  minBytes?: number
  maxBytes?: number
  tag?: string
  starred?: boolean
  pinned?: boolean
  extension?: string
  search?: string
  sort?: HubAttachmentSort
  /** Opaque: the server's own position marker, never parsed on the client. */
  cursor?: string
  /** Files nothing references any more. Filtered server-side, because a page-sized filter lies. */
  unreferenced?: boolean
  limit?: number
}

export interface HubAttachmentStats {
  totalCount: number
  totalBytes: number
  totalQuotaBytes: number
  imageBytes: number
  documentBytes: number
  mediaBytes: number
  archiveBytes: number
  codeBytes: number
  otherBytes: number
  unreferencedCount: number
  folderCount: number
  tagCount: number
  extensionBreakdown: Record<string, { count: number; bytes: number }>
  largestFiles: HubAttachmentWithUsage[]
}

export interface HubAttachmentListResponse {
  files: HubAttachmentWithUsage[]
  nextCursor: string | null
  stats: HubAttachmentStats
}

export interface HubFolder {
  id: string
  parentId: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  createdAt: number
  updatedAt: number
}

export interface HubTag {
  id: string
  name: string
  color: string | null
  isPinned: boolean
  createdAt: number
}

/** The place a file is used, named the way its own application names it. */
export interface HubAttachmentOwner {
  id: string
  title: string
}

export type HubBatchAction = 'move' | 'star' | 'pin' | 'tag' | 'delete'

export interface HubBatchRequest {
  action: HubBatchAction
  ids: string[]
  folderId?: string | null
  isStarred?: boolean
  isPinned?: boolean
  addTags?: string[]
  removeTags?: string[]
}

export interface HubPruneResult {
  removed: number
  freedBytes: number
  cleanupPending: boolean
  /** False when this scope has no registered way to tell used from unused, so nothing was deleted. */
  supported: boolean
}
