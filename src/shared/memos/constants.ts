import { LIMITS } from '../constants'
import type { MemoDisplayPreferences, MemoPreferences, MemoVisibility } from './types'

export const MEMOS_APP_PATH = '/memos'
export const MEMOS_API_PREFIX = '/api/memos'

export const MEMO_PAGE_SIZE = 16
export const MEMO_MAX_PAGE_SIZE = 100
export const MEMO_COMMENT_PAGE_SIZE = 16
export const MEMO_PUBLIC_PAGE_SIZE = 16

export const MEMO_DEFAULT_VISIBILITY: MemoVisibility = 'private'
export const MEMO_DEFAULT_REACTIONS = ['👍', '👎', '❤️', '🎉', '😄', '😕', '😢', '😡'] as const

export const MEMO_TAG_SEPARATOR = '/'
export const MEMO_TAGS_MAX = 64
export const MEMO_TAG_NAME_MAX_LENGTH = LIMITS.tagNameMaxLength

export const MEMO_CONTENT_MAX_BYTES = LIMITS.contentMaxBytes
export const MEMO_ATTACHMENT_MAX_BYTES = LIMITS.attachmentMaxBytes
export const MEMO_ATTACHMENT_QUOTA_BYTES = LIMITS.attachmentQuotaBytes
export const MEMO_ATTACHMENT_UPLOADS_PER_HOUR = LIMITS.attachmentUploadsPerHour

export const MEMO_FILTER_MAX_BYTES = 8 * 1024
export const MEMO_FILTER_MAX_DEPTH = 32
export const MEMO_FILTER_REGEX_MAX_LENGTH = 256
export const MEMO_FILTER_SCAN_LIMIT = 20_000

export const MEMO_DRAFT_VERSION = 1
export const MEMO_DRAFT_DEBOUNCE_MS = 500
export const MEMO_SYNC_POLL_MS = 25_000

export const MEMO_SHARE_EXPIRY_DAYS = [0, 1, 7, 30] as const

export const MEMO_PAT_PREFIX = 'memo_pat_'
export const MEMO_PAT_BYTES = 32

export const MEMO_WEBHOOK_SECRET_PREFIX = 'whsec_'
export const MEMO_WEBHOOK_TIMEOUT_MS = 10_000
export const MEMO_WEBHOOK_MAX_BYTES = 64 * 1024

export const MEMO_IMPORT_CHUNK_BYTES = 2 * 1024 * 1024
export const MEMO_IMPORT_MAX_ENTRIES = 1_000_000
export const MEMO_IMPORT_MANIFEST_MAX_BYTES = 1024 * 1024
export const MEMO_IMPORT_RECORD_MAX_BYTES = 4 * 1024 * 1024
export const MEMO_IMPORT_CONTENT_MAX_BYTES = 64 * 1024 * 1024
export const MEMO_IMPORT_EXPANDED_MAX_BYTES = 64 * 1024 * 1024
export const MEMO_IMPORT_EXPANSION_RATIO = 64
export const MEMO_IMPORT_SESSION_TTL_MS = 30 * 60 * 1000

export const MEMO_LINK_METADATA_TTL_MS = 24 * 60 * 60 * 1000
export const MEMO_LINK_METADATA_BATCH_MAX = 10

export const MEMO_AI_TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024
export const MEMO_AI_TRANSCRIBE_PER_HOUR = 20

export const MEMO_TAG_RULE_MAX_LENGTH = 256
export const MEMO_TAG_RULE_MAX_COUNT = 100
export const MEMO_REACTIONS_MAX = 32

export const MEMO_DISPLAY_DEFAULTS: MemoDisplayPreferences = {
  columns: 'auto',
  compact: false,
  linkPreview: true,
  timeBasis: 'created',
  order: 'desc',
}

export const MEMO_PREFERENCES_DEFAULTS: MemoPreferences = {
  defaultVisibility: MEMO_DEFAULT_VISIBILITY,
  enableDoubleClickEdit: true,
  saveMediaMetadata: true,
  reactions: [...MEMO_DEFAULT_REACTIONS],
  tagRules: [],
  enableLinkPreview: true,
  enableReverseGeocoding: false,
}
