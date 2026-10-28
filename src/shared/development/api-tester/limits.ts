export const API_TESTER_STATE_VERSION = 1

export const HISTORY_LIMIT = 100
export const HISTORY_ENTRY_MAX_BYTES = 64_000

export const STATE_JSON_MAX_BYTES = 4_000_000
export const STATE_GZIP_MAX_BYTES = 1_000_000
export const STATE_CIPHERTEXT_MAX_CHARS = 1_400_000
export const VAULT_REQUEST_MAX_BYTES = 1_500_000

export const MAX_WORKSPACES = 50
export const MAX_NODES = 2_000
export const MAX_TREE_DEPTH = 12
export const MAX_NAME_CHARS = 200
export const MAX_DESCRIPTION_CHARS = 10_000
export const MAX_URL_CHARS = 8_192
export const MAX_TAGS_PER_NODE = 32
export const MAX_TAGS = 500
export const MAX_TAG_DEPTH = 6
export const MAX_TAG_NAME_CHARS = 80
export const MAX_ENVIRONMENTS = 20
export const MAX_VARIABLES_PER_ENV = 200
export const MAX_GLOBAL_VARIABLES = 200
export const MAX_KV_ITEMS = 100
export const MAX_KV_KEY_CHARS = 200
export const MAX_KV_VALUE_CHARS = 8 * 1024
export const MAX_SCRIPT_CHARS = 64 * 1024
export const MAX_TEXT_BODY_BYTES = 5 * 1024 * 1024

export const MAX_PROXY_HEADERS = 100
export const MAX_PROXY_REDIRECTS = 5
export const MAX_PROXY_RESPONSE_BYTES = 5 * 1024 * 1024
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 120_000
export const TIMEOUT_OPTIONS = [5_000, 10_000, 30_000, 60_000, 120_000] as const

export const FILE_KINDS = ['json', 'txt', 'csv', 'xml', 'html', 'image', 'bin'] as const
export type FileKind = (typeof FILE_KINDS)[number]

export const FILE_EXTENSIONS: Record<FileKind, string> = {
  json: 'json',
  txt: 'txt',
  csv: 'csv',
  xml: 'xml',
  html: 'html',
  image: 'png',
  bin: 'bin',
}

export const FILE_CONTENT_TYPES: Record<FileKind, string> = {
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  html: 'text/html; charset=utf-8',
  image: 'image/png',
  bin: 'application/octet-stream',
}

export const MAX_FILE_BYTES = 8 * 1024 * 1024
export const MAX_FILES_PER_USER = 64
export const MAX_FILE_BYTES_PER_USER = 64 * 1024 * 1024
export const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const FILE_LIST_LIMIT = 50

export const WS_TICKET_TTL_MS = 60_000
export const MAX_WS_HEADERS = 50
export const MAX_WS_FRAME_BYTES = 1024 * 1024
export const WS_IDLE_TIMEOUT_MS = 10 * 60 * 1_000

export const PROXY_RATE_LIMIT = { maxAttempts: 120, windowMs: 60_000, lockMs: 60_000 } as const
export const OAUTH_RATE_LIMIT = { maxAttempts: 20, windowMs: 60_000, lockMs: 60_000 } as const
export const WS_TICKET_RATE_LIMIT = { maxAttempts: 30, windowMs: 60_000, lockMs: 60_000 } as const
export const FILE_RATE_LIMIT = { maxAttempts: 30, windowMs: 60_000, lockMs: 60_000 } as const

export const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
}
