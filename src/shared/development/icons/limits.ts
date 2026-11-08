export const DEVELOPMENT_ICONS_CORE_SCHEMA_VERSION = 320
export const DEVELOPMENT_ICONS_SETTINGS_SCHEMA_VERSION = 321
/** Conversion outputs are their own ledger so quotas and cleanup can account for them. */
export const DEVELOPMENT_ICONS_OUTPUTS_SCHEMA_VERSION = 327
/** Records whether a job is meant to run in a queue consumer or in the browser. */
export const DEVELOPMENT_ICONS_JOB_EXECUTION_SCHEMA_VERSION = 328
export const DEVELOPMENT_ICONS_SCHEMA_VERSIONS = [
  DEVELOPMENT_ICONS_CORE_SCHEMA_VERSION,
  DEVELOPMENT_ICONS_SETTINGS_SCHEMA_VERSION,
  DEVELOPMENT_ICONS_OUTPUTS_SCHEMA_VERSION,
  DEVELOPMENT_ICONS_JOB_EXECUTION_SCHEMA_VERSION,
] as const

export const ICON_FORMATS = ['svg', 'png', 'jpg', 'webp'] as const
export const ICON_SORTS = ['created', 'updated', 'name', 'used'] as const
export const ICON_SMART_VIEWS = ['all', 'favorites', 'pinned', 'recent', 'uncategorized'] as const
export const ICON_USAGE_ACTIONS = ['copy', 'download', 'view'] as const
export const ICON_JOB_KINDS = ['png', 'ico', 'sprite_svg', 'sprite_png'] as const
export const ICON_JOB_STATUSES = ['queued', 'running', 'partial', 'done', 'failed', 'canceled'] as const
export const ICON_JOB_ITEM_STATUSES = ['queued', 'running', 'done', 'failed', 'skipped'] as const
export const ICON_IMPORT_KINDS = ['upload', 'iconify'] as const
export const ICON_IMPORT_STATUSES = ['pending', 'running', 'done', 'failed', 'canceled'] as const
export const ICON_IMPORT_ITEM_STATUSES = ['pending', 'done', 'failed', 'skipped'] as const
export const ICON_EXPORT_FORMATS = ['svg', 'png', 'ico', 'zip', 'sprite_svg', 'sprite_png'] as const
export const ICON_BATCH_ACTIONS = [
  'delete',
  'move',
  'tag',
  'favorite',
  'unfavorite',
  'pin',
  'unpin',
] as const

export const ICON_PNG_PRESETS = [24, 48, 96, 192, 512] as const
export const ICON_ICO_PRESETS = [16, 32, 48, 256] as const
export const ICON_SPRITE_SCALES = [1, 2] as const
export const ICON_SPRITE_PADDING_DEFAULT = 2
export const ICON_SPRITE_PADDING_MAX = 32
export const ICON_SPRITE_MAX_ASSETS = 500
export const ICON_SPRITE_MAX_CELL = 512
export const ICON_SPRITE_MAX_CANVAS = 4096

/** The base cell of a PNG sheet; the padding is added on each side. */
export const ICON_SPRITE_CELL = 24
/** A per-user ceiling on conversion jobs created in one minute. */
export const ICON_JOB_RATE_LIMIT = 12

export const ICON_PAGE_SIZE_DEFAULT = 60
export const ICON_PAGE_SIZE_MAX = 120
export const ICON_SEARCH_MAX_LENGTH = 64
export const ICON_CURSOR_MAX_LENGTH = 512
export const ICON_TAG_NAME_MAX = 40
export const ICON_COLLECTION_NAME_MAX = 80
export const ICON_KEYWORDS_MAX = 500
export const ICON_MAX_TAG_IDS = 50
export const ICON_MAX_BATCH_IDS = 100
export const ICON_RECENT_DAYS = 30

export const ICON_DEFAULT_QUOTA_BYTES = 512 * 1024 * 1024
export const ICON_DEFAULT_MAX_SVG_BYTES = 256 * 1024
export const ICON_DEFAULT_MAX_RASTER_BYTES = 5 * 1024 * 1024
export const ICON_DEFAULT_MAX_DIMENSION = 4096
export const ICON_DEFAULT_BATCH_LIMIT = 500
export const ICON_DEFAULT_ZIP_LIMIT_BYTES = 50 * 1024 * 1024
export const ICON_DEFAULT_ZIP_LIMIT_ENTRIES = 1000

export const ICON_HARD_QUOTA_BYTES = 2 * 1024 * 1024 * 1024
export const ICON_HARD_MAX_SVG_BYTES = 1024 * 1024
export const ICON_HARD_MAX_RASTER_BYTES = 20 * 1024 * 1024
export const ICON_HARD_MAX_DIMENSION = 8192
export const ICON_HARD_BATCH_LIMIT = 500
export const ICON_HARD_ZIP_LIMIT_BYTES = 200 * 1024 * 1024
export const ICON_HARD_ZIP_LIMIT_ENTRIES = 5000

export const ICON_MAX_PIXELS = 16_000_000
export const ICON_MAX_ZIP_RATIO = 100
export const ICON_MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
export const ICON_JOB_MAX_ITEMS = 500
export const ICON_JOB_MESSAGE_ITEMS = 50
export const ICON_EXPORT_MAX_ITEMS = 500
export const ICON_EXPORT_MAX_BYTES = 200 * 1024 * 1024
export const ICON_EXPORT_TTL_MS = 24 * 60 * 60 * 1000
export const ICON_USAGE_RETENTION_DAYS = 400
export const ICON_IMPORT_MAX_ITEMS = 10_000

export const ICON_ICONIFY_PREFIXES = [
  'lucide',
  'tabler',
  'material-symbols',
  'ph',
  'heroicons',
  'bi',
  'fe',
  'ri',
  'simple-icons',
] as const
/** How long a failed first-run seed is allowed to wait before another visit may retry it. */
export const ICON_SEED_RETRY_MS = 10 * 60 * 1000
export const ICON_SEED_IMPORT_LIMIT = 500
export const ICON_ICONIFY_SOURCE = 'https://cdn.jsdelivr.net/npm/@iconify-json'
export const ICON_ICONIFY_API = 'https://api.iconify.design'
/** Material Symbols ships one 8.5 MB `icons.json`; the ceiling has to clear the largest built-in set. */
export const ICON_ICONIFY_MAX_BYTES = 16 * 1024 * 1024
export const ICON_ICONIFY_TIMEOUT_MS = 10_000
export const ICON_ICONIFY_BATCH_ITEMS = 50
