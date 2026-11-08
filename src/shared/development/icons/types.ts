export type IconFormat = 'svg' | 'png' | 'jpg' | 'webp'

export type IconCollectionSource = 'upload' | 'iconify' | 'local'

export type IconColorMode = 'mono' | 'multi' | 'unknown'

export type IconSmartView = 'all' | 'favorites' | 'pinned' | 'recent' | 'uncategorized'

export type IconSort = 'created' | 'updated' | 'name' | 'used'

export type IconUsageAction = 'copy' | 'download' | 'view'

export type IconPngSize = 24 | 48 | 96 | 192 | 512

export type IconIcoSize = 16 | 32 | 48 | 256

export type IconSpriteScale = 1 | 2

export type IconJobKind = 'png' | 'ico' | 'sprite_svg' | 'sprite_png'

export type IconJobStatus = 'queued' | 'running' | 'partial' | 'done' | 'failed' | 'canceled'

export type IconJobItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped'

export type IconImportKind = 'upload' | 'iconify'

export type IconImportStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled'

export type IconImportItemStatus = 'pending' | 'done' | 'failed' | 'skipped'

export type IconExportFormat = 'svg' | 'png' | 'ico' | 'zip' | 'sprite_svg' | 'sprite_png'

export type IconBatchAction = 'delete' | 'move' | 'tag' | 'favorite' | 'unfavorite' | 'pin' | 'unpin'

export type IconCodegenTab =
  | 'svg'
  | 'data-url'
  | 'jsx'
  | 'react'
  | 'vue'
  | 'svelte'
  | 'angular'
  | 'component'
  | 'ts-import'

export interface IconCollection {
  id: string
  name: string
  slug: string
  description: string
  source: IconCollectionSource
  license: string
  homepage: string
  sortOrder: number
  createdAt: number
  updatedAt: number
  count?: number
}

export interface IconTag {
  id: string
  name: string
  color: string
  parentId: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type IconTagSummary = Pick<IconTag, 'id' | 'name' | 'color'>

export interface IconAssetSummary {
  id: string
  name: string
  collectionId: string | null
  format: IconFormat
  width: number | null
  height: number | null
  bytes: number
  sha256: string
  thumbUrl: string
  thumb2xUrl: string
  rawUrl: string
  tags: IconTagSummary[]
  favorited: boolean
  pinned: boolean
  colorMode: IconColorMode
  updatedAt: number
}

export interface IconAssetDetail extends IconAssetSummary {
  mime: string
  viewBox: string | null
  keywords: string
  license: string
  sourceUrl: string
  sanitized: boolean
  createdAt: number
  useCount: number
  lastUsedAt: number | null
}

export interface IconUserState {
  favorited: boolean
  pinned: boolean
  pinnedAt: number | null
  useCount: number
  lastUsedAt: number | null
}

export interface IconCounts {
  all: number
  favorites: number
  pinned: number
  recent: number
  uncategorized: number
  collections: Record<string, number>
  tags: Record<string, number>
  formats: Record<string, number>
  styles: Record<string, number>
  colorModes: Record<string, number>
}

export interface IconSettings {
  quotaBytes: number
  maxSvgBytes: number
  maxRasterBytes: number
  maxDimension: number
  batchLimit: number
  zipLimitBytes: number
  zipLimitEntries: number
}

export interface IconLimits {
  hardQuotaBytes: number
  hardMaxSvgBytes: number
  hardMaxRasterBytes: number
  hardMaxDimension: number
  hardBatchLimit: number
  hardZipLimitBytes: number
  hardZipLimitEntries: number
}

export interface IconUsageSummary {
  usedBytes: number
  quotaBytes: number
  assetsBytes: number
  outputsBytes: number
  exportsBytes: number
  overQuota: boolean
}

export interface IconBootstrap {
  collections: IconCollection[]
  tags: IconTag[]
  counts: IconCounts
  settings: IconSettings
  limits: IconLimits
  usage: IconUsageSummary
  isOwner: boolean
  schemaVersions: readonly number[]
}

export interface IconPage<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
  total?: number
}

export interface IconSvgResponse {
  body: string
  width: number
  height: number
  viewBox: string
}

export interface IconPngJobOptions {
  kind: 'png'
  sizes: IconPngSize[]
}

export interface IconIcoJobOptions {
  kind: 'ico'
  sizes: IconIcoSize[]
}

export interface IconSpriteSvgJobOptions {
  kind: 'sprite_svg'
  padding: number
}

export interface IconSpritePngJobOptions {
  kind: 'sprite_png'
  padding: number
  scales: IconSpriteScale[]
  scss: boolean
}

export type IconJobOptions =
  | IconPngJobOptions
  | IconIcoJobOptions
  | IconSpriteSvgJobOptions
  | IconSpritePngJobOptions

export interface IconJob {
  id: string
  kind: IconJobKind
  status: IconJobStatus
  /** `queue` when a consumer will run it; `browser` when the client converts and uploads the outputs. */
  mode: 'queue' | 'browser'
  options: IconJobOptions
  totalItems: number
  processedItems: number
  failedItems: number
  error: string
  manifestUrl: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface IconJobItem {
  assetId: string
  status: IconJobItemStatus
  outputs: Record<string, string>
  attempts: number
  error: string
}

export interface IconImport {
  id: string
  kind: IconImportKind
  status: IconImportStatus
  prefix: string
  totalItems: number
  processedItems: number
  failedItems: number
  skippedItems: number
  bytesTotal: number
  error: string
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}

export interface IconImportItem {
  itemKey: string
  filename: string
  status: IconImportItemStatus
  assetId: string | null
  error: string
}

export interface IconExport {
  id: string
  format: IconExportFormat
  filename: string
  bytes: number
  assetCount: number
  status: 'pending' | 'done' | 'failed' | 'expired'
  error: string
  createdAt: number
  expiresAt: number
  downloadUrl: string
}

export interface IconUploadResult {
  asset: IconAssetDetail
  deduped: boolean
}
