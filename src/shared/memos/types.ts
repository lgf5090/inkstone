import type { PublicUser } from '../types'

export const MEMO_VISIBILITIES = ['private', 'protected', 'public'] as const
export type MemoVisibility = (typeof MEMO_VISIBILITIES)[number]

export const MEMO_STATES = ['normal', 'archived'] as const
export type MemoState = (typeof MEMO_STATES)[number]

export const MEMO_ORDER_FIELDS = ['created', 'updated'] as const
export type MemoOrderField = (typeof MEMO_ORDER_FIELDS)[number]
export type MemoOrderDirection = 'asc' | 'desc'

export interface MemoProperties {
  hasLink: boolean
  hasCode: boolean
  hasTaskList: boolean
  hasIncompleteTasks: boolean
  hasLocation: boolean
}

export interface MemoLocation {
  placeholder: string
  latitude: number
  longitude: number
}

export interface MemoMediaCaptureTime {
  local: string
  offsetMinutes: number
}

export interface MemoMediaLocation {
  latitude: number
  longitude: number
  altitude?: number
}

export interface MemoPhotoMetadata {
  width: number | null
  height: number | null
  captureTime?: MemoMediaCaptureTime
  location?: MemoMediaLocation
  cameraMake?: string
  cameraModel?: string
  lensModel?: string
  fNumber?: number
  exposureTimeSeconds?: number
  iso?: number
  focalLengthMm?: number
  orientation?: number
}

export interface MemoVideoMetadata {
  durationSeconds?: number
}

export interface MemoMediaMetadata {
  photo?: MemoPhotoMetadata
  video?: MemoVideoMetadata
}

export type MemoMotionRole = 'still' | 'video' | 'container'

export interface MemoMotion {
  groupId: string
  role: MemoMotionRole
}

export interface MemoAttachment {
  id: string
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  url: string
  thumbnailUrl: string | null
  motion: MemoMotion | null
  mediaMetadata: MemoMediaMetadata | null
  createdAt: number
}

export interface MemoReactionUser {
  id: string
  name: string
  avatarUrl: string
}

export interface MemoReactionSummary {
  type: string
  count: number
  reacted: boolean
  users?: MemoReactionUser[]
}

export interface MemoRelation {
  memoId: string
  relatedMemoId: string
  relatedSnippet?: string
  createdAt: number
}

export interface Memo {
  id: string
  content: string
  title: string
  snippet: string
  tags: string[]
  visibility: MemoVisibility
  state: MemoState
  pinned: boolean
  spaceId: string | null
  parentId: string | null
  location: MemoLocation | null
  properties: MemoProperties
  attachments: MemoAttachment[]
  reactions: MemoReactionSummary[]
  relations: MemoRelation[]
  commentCount: number
  rev: number
  createdAt: number
  updatedAt: number
  creator?: PublicUser
}

export interface MemoListQuery {
  state?: MemoState
  spaceId?: string | null
  parentId?: string | null
  filter?: string
  orderBy?: MemoOrderField
  order?: MemoOrderDirection
  cursor?: string | null
  limit?: number
  tz?: string
}

export interface MemoListResponse {
  items: Memo[]
  nextCursor: string | null
}

export interface MemoCreateInput {
  id?: string
  content: string
  visibility?: MemoVisibility
  spaceId?: string | null
  parentId?: string | null
  location?: MemoLocation | null
  attachmentIds?: string[]
  relatedMemoIds?: string[]
  createdAt?: number
  updatedAt?: number
}

export interface MemoPatchInput {
  rev: number
  content?: string
  visibility?: MemoVisibility
  spaceId?: string | null
  pinned?: boolean
  state?: MemoState
  location?: MemoLocation | null
  attachmentIds?: string[]
  relatedMemoIds?: string[]
  createdAt?: number
  updatedAt?: number
}

export interface MemoCommentInput {
  content: string
  attachmentIds?: string[]
  createdAt?: number
}

export interface MemoReactionInput {
  type: string
}

export interface MemoShare {
  id: string
  memoId: string
  expiresAt: number | null
  createdAt: number
  url?: string
}

export interface MemoShareCreateInput {
  expiresAt?: number | null
}

export interface MemoSpace {
  id: string
  title: string
  description: string
  icon: string
  memoCount?: number
  createdAt: number
  updatedAt: number
}

export interface MemoSpaceInput {
  title: string
  description?: string
  icon?: string
}

export interface MemoView {
  id: string
  title: string
  filter: string
  icon: string
  createdAt: number
  updatedAt: number
}

export interface MemoViewInput {
  title: string
  filter: string
  icon?: string
}

export interface MemoViewValidation {
  ok: boolean
  error?: {
    message: string
    position: number | null
  }
}

export interface MemoTypeCounts {
  link: number
  code: number
  todo: number
  undo: number
}

export interface MemoStats {
  total: number
  archived: number
  comments: number
  attachmentBytes: number
  tagCounts: Record<string, number>
  typeCounts: MemoTypeCounts
  dayCounts: Record<string, number>
}

export type MemoTagRuleMode = 'exact' | 'regex'

export interface MemoTagRule {
  pattern: string
  mode: MemoTagRuleMode
  backgroundColor: string | null
  blurContent: boolean
}

export interface MemoPreferences {
  defaultVisibility: MemoVisibility
  enableDoubleClickEdit: boolean
  saveMediaMetadata: boolean
  reactions: string[]
  tagRules: MemoTagRule[]
  enableLinkPreview: boolean
  enableReverseGeocoding: boolean
}

export type MemoPreferencesPatch = Partial<MemoPreferences>

export interface MemoDisplayPreferences {
  columns: 1 | 2 | 3 | 'auto'
  compact: boolean
  linkPreview: boolean
  timeBasis: MemoOrderField
  order: MemoOrderDirection
}

export interface MemoDraft {
  version: 1
  content: string
  attachmentIds: string[]
  location: MemoLocation | null
  spaceId: string | null
  visibility: MemoVisibility
  updatedAt: number
}

export interface MemoToken {
  id: string
  description: string
  prefix: string
  expiresAt: number | null
  createdAt: number
  lastUsedAt: number | null
}

export interface MemoTokenCreateInput {
  description?: string
  expiresAt?: number | null
}

export interface MemoTokenCreateResult {
  token: string
  tokenInfo: MemoToken
}

export interface MemoWebhook {
  id: string
  title: string
  url: string
  signingSecretSet: boolean
  createdAt: number
  updatedAt: number
}

export interface MemoWebhookInput {
  title: string
  url: string
}

export interface MemoWebhookCreateResult {
  webhook: MemoWebhook
  signingSecret: string
}

export interface MemoLinkMetadata {
  url: string
  title: string
  description: string
  image: string
}

export interface MemoTranscriptionResult {
  text: string
}

export type MemoImportConflictPolicy = 'skip' | 'replace' | 'duplicate'

export interface MemoImportIssue {
  code: string
  message: string
  path?: string
}

export interface MemoImportPlan {
  exporter: string
  exportTime: number | null
  memoCount: number
  attachmentCount: number
  newCount: number
  renamedCount: number
  existingCount: number
  warnings: MemoImportIssue[]
}

export interface MemoImportReport {
  created: number
  updated: number
  skipped: number
  failed: number
  failures: MemoImportIssue[]
  warnings: MemoImportIssue[]
}

export interface MemoImportSession {
  id: string
  filename: string
  totalSize: number
  received: number
  chunkSize: number
  expiresAt: number
}

export interface MemoImportChunkResult {
  received: number
}

export interface MemoChangesResponse {
  revision: number
  changed: boolean
}

export type MemoChangeKind =
  | 'memo'
  | 'comment'
  | 'attachment'
  | 'reaction'
  | 'share'
  | 'space'
  | 'view'

export type MemoApiErrorCode =
  | 'memo_not_found'
  | 'memo_forbidden'
  | 'memo_conflict'
  | 'memo_invalid_filter'
  | 'memo_filter_too_large'
  | 'memo_share_not_found'
  | 'memo_share_expired'
  | 'memo_attachment_too_large'
  | 'memo_attachment_quota'
  | 'memo_attachment_in_use'
  | 'memo_import_invalid'
  | 'memo_import_too_large'
  | 'memo_import_conflict'
  | 'memo_ai_unavailable'
  | 'memo_webhook_invalid'
  | 'memo_webhook_target'
  | 'memo_pat_invalid'
  | 'memo_pat_expired'
