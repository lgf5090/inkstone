/** Defaults and validation for the CloudDrive settings stored as `CloudDrive_settings` rows. */
import { CLOUDDRIVE_LIMITS } from './model'

export const CLOUDDRIVE_PREVIEW_TYPES = [
  'text', 'image', 'video', 'audio', 'pdf', 'office', 'archive', 'ofd', 'native', 'none',
] as const
export type CloudDrivePreviewType = (typeof CLOUDDRIVE_PREVIEW_TYPES)[number]

export interface CloudDrivePreviewRule {
  id: string
  priority: number
  type: CloudDrivePreviewType
  extensions: string[]
}

export const DEFAULT_PREVIEW_EXTENSIONS = {
  text: [
    'txt', 'md', 'markdown', 'log', 'json', 'json5', 'jsonc', 'ndjson', 'js', 'mjs', 'cjs',
    'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'styl', 'html', 'htm', 'xhtml', 'xml',
    'xsl', 'xslt', 'vue', 'svelte', 'astro', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env',
    'properties', 'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'sql', 'go', 'rs', 'java',
    'kt', 'kts', 'swift', 'rb', 'php', 'py', 'pl', 'pm', 'lua', 'scala', 'groovy', 'dart', 'c',
    'cpp', 'cc', 'cxx', 'h', 'hpp', 'hh', 'cs', 'vb', 'm', 'mm', 'proto', 'graphql', 'gql',
    'prisma', 'tex', 'bib', 'diff', 'patch', 'ics',
  ],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'svg', 'ico', 'heic', 'heif', 'jxl'],
  video: ['mp4', 'webm', 'm4v', 'm3u8', 'mov', 'mkv', 'avi', 'wmv', 'flv'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba', 'mid', 'midi'],
} as const

export const DEFAULT_PREVIEW_RULES: readonly CloudDrivePreviewRule[] = [
  { id: 'image', priority: 90, type: 'image', extensions: [...DEFAULT_PREVIEW_EXTENSIONS.image] },
  { id: 'video', priority: 90, type: 'video', extensions: [...DEFAULT_PREVIEW_EXTENSIONS.video] },
  { id: 'audio', priority: 90, type: 'audio', extensions: [...DEFAULT_PREVIEW_EXTENSIONS.audio] },
  { id: 'pdf', priority: 95, type: 'pdf', extensions: ['pdf'] },
  { id: 'office', priority: 85, type: 'office', extensions: ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp'] },
  { id: 'archive', priority: 80, type: 'archive', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz'] },
  { id: 'ofd', priority: 95, type: 'ofd', extensions: ['ofd'] },
  { id: 'text', priority: 10, type: 'text', extensions: [...DEFAULT_PREVIEW_EXTENSIONS.text] },
]

export interface CloudDriveSettings {
  quotaDefaultBytes: number | null
  uploadMaxFileBytes: number
  uploadPartSizeBytes: number
  uploadDistributedMinBytes: number
  uploadConcurrentParts: number
  shareAllowMemberShares: boolean
  shareDefaultExpiryDays: number
  shareMaxExpiryDays: number
  trashRetentionDays: number
  webdavEnabled: boolean
  webdavUsername: string
  webdavPasswordHash: string
  storageDisplayQuotaBytes: number | null
  syncAllowMemberSync: boolean
  adminOwnerCanViewMemberFiles: boolean
  previewTextExtensions: string[]
  previewImageExtensions: string[]
  previewVideoExtensions: string[]
  previewAudioExtensions: string[]
  previewRules: CloudDrivePreviewRule[]
}

export type CloudDrivePublicSettings = Omit<CloudDriveSettings, 'webdavPasswordHash'> & {
  webdavHasPassword: boolean
}

export const DEFAULT_CLOUDDRIVE_SETTINGS: CloudDriveSettings = {
  quotaDefaultBytes: null,
  uploadMaxFileBytes: 5 * 1024 * 1024 * 1024,
  uploadPartSizeBytes: 16 * 1024 * 1024,
  uploadDistributedMinBytes: 32 * 1024 * 1024,
  uploadConcurrentParts: 3,
  shareAllowMemberShares: true,
  shareDefaultExpiryDays: 7,
  shareMaxExpiryDays: 365,
  trashRetentionDays: 30,
  webdavEnabled: false,
  webdavUsername: '',
  webdavPasswordHash: '',
  storageDisplayQuotaBytes: null,
  syncAllowMemberSync: true,
  adminOwnerCanViewMemberFiles: false,
  previewTextExtensions: [...DEFAULT_PREVIEW_EXTENSIONS.text],
  previewImageExtensions: [...DEFAULT_PREVIEW_EXTENSIONS.image],
  previewVideoExtensions: [...DEFAULT_PREVIEW_EXTENSIONS.video],
  previewAudioExtensions: [...DEFAULT_PREVIEW_EXTENSIONS.audio],
  previewRules: DEFAULT_PREVIEW_RULES.map((rule) => ({ ...rule, extensions: [...rule.extensions] })),
}

const SETTING_KEYS: Record<keyof CloudDriveSettings, string> = {
  quotaDefaultBytes: 'quota.defaultUserBytes',
  uploadMaxFileBytes: 'upload.maxFileBytes',
  uploadPartSizeBytes: 'upload.partSizeBytes',
  uploadDistributedMinBytes: 'upload.distributedMinBytes',
  uploadConcurrentParts: 'upload.concurrentParts',
  shareAllowMemberShares: 'share.allowMemberShares',
  shareDefaultExpiryDays: 'share.defaultExpiryDays',
  shareMaxExpiryDays: 'share.maxExpiryDays',
  trashRetentionDays: 'trash.retentionDays',
  webdavEnabled: 'webdav.enabled',
  webdavUsername: 'webdav.username',
  webdavPasswordHash: 'webdav.passwordHash',
  storageDisplayQuotaBytes: 'storage.displayQuotaBytes',
  syncAllowMemberSync: 'sync.allowMemberSync',
  adminOwnerCanViewMemberFiles: 'admin.ownerCanViewMemberFiles',
  previewTextExtensions: 'preview.textExtensions',
  previewImageExtensions: 'preview.imageExtensions',
  previewVideoExtensions: 'preview.videoExtensions',
  previewAudioExtensions: 'preview.audioExtensions',
  previewRules: 'preview.rules',
}

export function cloudDriveSettingKey(key: keyof CloudDriveSettings): string {
  return SETTING_KEYS[key]
}

function numberOrNull(value: unknown, min: number, max: number): number | null | undefined {
  if (value === null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < min || number > max) return undefined
  return Math.round(number)
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return fallback
}

function stringList(value: unknown, fallback: readonly string[], max: number): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (!source) return [...fallback]
  const cleaned = source
    .map((item) => String(item).trim().toLocaleLowerCase().replace(/^\./, ''))
    .filter((item) => item.length > 0 && /^[a-z0-9][a-z0-9+_-]{0,31}$/.test(item))
  return [...new Set(cleaned)].slice(0, max)
}

export function parsePreviewRules(value: unknown): CloudDrivePreviewRule[] {
  if (!Array.isArray(value)) return []
  const rules: CloudDrivePreviewRule[] = []
  const ids = new Set<string>()
  for (const entry of value.slice(0, CLOUDDRIVE_LIMITS.previewRulesMax)) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.slice(0, 64) : ''
    const type = CLOUDDRIVE_PREVIEW_TYPES.includes(record.type as CloudDrivePreviewType)
      ? record.type as CloudDrivePreviewType
      : null
    const priority = numberOrNull(record.priority, 0, 100)
    const extensions = stringList(record.extensions, [], CLOUDDRIVE_LIMITS.previewExtensionsMax)
    if (!id || ids.has(id) || !type || priority === undefined || priority === null || extensions.length === 0) continue
    ids.add(id)
    rules.push({ id, priority, type, extensions })
  }
  return rules.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
}

export function parseCloudDriveSettings(rows: Record<string, string>): CloudDriveSettings {
  const get = (key: keyof CloudDriveSettings) => rows[SETTING_KEYS[key]]
  const result: CloudDriveSettings = {
    quotaDefaultBytes: numberOrNull(get('quotaDefaultBytes'), 0, 10 * 1024 ** 4) ?? DEFAULT_CLOUDDRIVE_SETTINGS.quotaDefaultBytes,
    uploadMaxFileBytes: numberOrNull(get('uploadMaxFileBytes'), 1024 * 1024, 5 * 1024 ** 4) ?? DEFAULT_CLOUDDRIVE_SETTINGS.uploadMaxFileBytes,
    uploadPartSizeBytes: numberOrNull(get('uploadPartSizeBytes'), CLOUDDRIVE_LIMITS.partSizeMinBytes, CLOUDDRIVE_LIMITS.partSizeMaxBytes) ?? DEFAULT_CLOUDDRIVE_SETTINGS.uploadPartSizeBytes,
    uploadDistributedMinBytes: numberOrNull(get('uploadDistributedMinBytes'), 8 * 1024 * 1024, 5 * 1024 ** 4) ?? DEFAULT_CLOUDDRIVE_SETTINGS.uploadDistributedMinBytes,
    uploadConcurrentParts: numberOrNull(get('uploadConcurrentParts'), 1, 8) ?? DEFAULT_CLOUDDRIVE_SETTINGS.uploadConcurrentParts,
    shareAllowMemberShares: bool(get('shareAllowMemberShares'), DEFAULT_CLOUDDRIVE_SETTINGS.shareAllowMemberShares),
    shareDefaultExpiryDays: numberOrNull(get('shareDefaultExpiryDays'), 0, 3650) ?? DEFAULT_CLOUDDRIVE_SETTINGS.shareDefaultExpiryDays,
    shareMaxExpiryDays: numberOrNull(get('shareMaxExpiryDays'), 1, 3650) ?? DEFAULT_CLOUDDRIVE_SETTINGS.shareMaxExpiryDays,
    trashRetentionDays: numberOrNull(get('trashRetentionDays'), 1, 365) ?? DEFAULT_CLOUDDRIVE_SETTINGS.trashRetentionDays,
    webdavEnabled: bool(get('webdavEnabled'), DEFAULT_CLOUDDRIVE_SETTINGS.webdavEnabled),
    webdavUsername: typeof get('webdavUsername') === 'string' ? get('webdavUsername')!.slice(0, 64) : '',
    webdavPasswordHash: typeof get('webdavPasswordHash') === 'string' ? get('webdavPasswordHash')! : '',
    storageDisplayQuotaBytes: numberOrNull(get('storageDisplayQuotaBytes'), 0, 10 * 1024 ** 4) ?? null,
    syncAllowMemberSync: bool(get('syncAllowMemberSync'), DEFAULT_CLOUDDRIVE_SETTINGS.syncAllowMemberSync),
    adminOwnerCanViewMemberFiles: bool(get('adminOwnerCanViewMemberFiles'), false),
    previewTextExtensions: stringList(get('previewTextExtensions'), DEFAULT_PREVIEW_EXTENSIONS.text, CLOUDDRIVE_LIMITS.previewExtensionsMax),
    previewImageExtensions: stringList(get('previewImageExtensions'), DEFAULT_PREVIEW_EXTENSIONS.image, CLOUDDRIVE_LIMITS.previewExtensionsMax),
    previewVideoExtensions: stringList(get('previewVideoExtensions'), DEFAULT_PREVIEW_EXTENSIONS.video, CLOUDDRIVE_LIMITS.previewExtensionsMax),
    previewAudioExtensions: stringList(get('previewAudioExtensions'), DEFAULT_PREVIEW_EXTENSIONS.audio, CLOUDDRIVE_LIMITS.previewExtensionsMax),
    previewRules: parsePreviewRules(safeJson(get('previewRules'))) || [],
  }
  if (result.previewRules.length === 0) {
    result.previewRules = DEFAULT_PREVIEW_RULES.map((rule) => ({ ...rule, extensions: [...rule.extensions] }))
  }
  return result
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export function publicCloudDriveSettings(settings: CloudDriveSettings): CloudDrivePublicSettings {
  const { webdavPasswordHash, ...rest } = settings
  return { ...rest, webdavHasPassword: webdavPasswordHash.length > 0 }
}

export interface CloudDriveSettingsPatch {
  quotaDefaultBytes?: number | null
  uploadMaxFileBytes?: number
  uploadPartSizeBytes?: number
  uploadDistributedMinBytes?: number
  uploadConcurrentParts?: number
  shareAllowMemberShares?: boolean
  shareDefaultExpiryDays?: number
  shareMaxExpiryDays?: number
  trashRetentionDays?: number
  webdavEnabled?: boolean
  webdavUsername?: string
  webdavPassword?: string
  storageDisplayQuotaBytes?: number | null
  syncAllowMemberSync?: boolean
  adminOwnerCanViewMemberFiles?: boolean
  previewTextExtensions?: string[]
  previewImageExtensions?: string[]
  previewVideoExtensions?: string[]
  previewAudioExtensions?: string[]
  previewRules?: CloudDrivePreviewRule[]
}

/** Returns the rows to upsert for a patch, or a human-readable problem. */
export function normalizeCloudDriveSettingsPatch(patch: CloudDriveSettingsPatch): { rows: Record<string, string> } | { error: string } {
  const rows: Record<string, string> = {}
  const put = (key: keyof CloudDriveSettings, value: unknown) => {
    rows[SETTING_KEYS[key]] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  if (patch.quotaDefaultBytes !== undefined) {
    const value = numberOrNull(patch.quotaDefaultBytes, 0, 10 * 1024 ** 4)
    if (value === undefined) return { error: 'Invalid quota' }
    put('quotaDefaultBytes', value)
  }
  if (patch.uploadMaxFileBytes !== undefined) {
    const value = numberOrNull(patch.uploadMaxFileBytes, 1024 * 1024, 5 * 1024 ** 4)
    if (value === undefined || value === null) return { error: 'Invalid maximum file size' }
    put('uploadMaxFileBytes', value)
  }
  if (patch.uploadPartSizeBytes !== undefined) {
    const value = numberOrNull(patch.uploadPartSizeBytes, CLOUDDRIVE_LIMITS.partSizeMinBytes, CLOUDDRIVE_LIMITS.partSizeMaxBytes)
    if (value === undefined || value === null) return { error: 'Invalid part size' }
    put('uploadPartSizeBytes', value)
  }
  if (patch.uploadDistributedMinBytes !== undefined) {
    const value = numberOrNull(patch.uploadDistributedMinBytes, 8 * 1024 * 1024, 5 * 1024 ** 4)
    if (value === undefined || value === null) return { error: 'Invalid distributed threshold' }
    put('uploadDistributedMinBytes', value)
  }
  if (patch.uploadConcurrentParts !== undefined) {
    const value = numberOrNull(patch.uploadConcurrentParts, 1, 8)
    if (value === undefined || value === null) return { error: 'Invalid concurrency' }
    put('uploadConcurrentParts', value)
  }
  if (patch.shareAllowMemberShares !== undefined) put('shareAllowMemberShares', patch.shareAllowMemberShares)
  if (patch.shareDefaultExpiryDays !== undefined) {
    const value = numberOrNull(patch.shareDefaultExpiryDays, 0, 3650)
    if (value === undefined || value === null) return { error: 'Invalid share expiry' }
    put('shareDefaultExpiryDays', value)
  }
  if (patch.shareMaxExpiryDays !== undefined) {
    const value = numberOrNull(patch.shareMaxExpiryDays, 1, 3650)
    if (value === undefined || value === null) return { error: 'Invalid share expiry' }
    put('shareMaxExpiryDays', value)
  }
  if (patch.trashRetentionDays !== undefined) {
    const value = numberOrNull(patch.trashRetentionDays, 1, 365)
    if (value === undefined || value === null) return { error: 'Invalid trash retention' }
    put('trashRetentionDays', value)
  }
  if (patch.webdavEnabled !== undefined) put('webdavEnabled', patch.webdavEnabled)
  if (patch.webdavUsername !== undefined) put('webdavUsername', patch.webdavUsername.slice(0, 64))
  if (patch.storageDisplayQuotaBytes !== undefined) {
    const value = numberOrNull(patch.storageDisplayQuotaBytes, 0, 10 * 1024 ** 4)
    if (value === undefined) return { error: 'Invalid display quota' }
    put('storageDisplayQuotaBytes', value)
  }
  if (patch.syncAllowMemberSync !== undefined) put('syncAllowMemberSync', patch.syncAllowMemberSync)
  if (patch.adminOwnerCanViewMemberFiles !== undefined) put('adminOwnerCanViewMemberFiles', patch.adminOwnerCanViewMemberFiles)
  for (const key of ['previewTextExtensions', 'previewImageExtensions', 'previewVideoExtensions', 'previewAudioExtensions'] as const) {
    if (patch[key] === undefined) continue
    const fallback = key === 'previewTextExtensions' ? DEFAULT_PREVIEW_EXTENSIONS.text
      : key === 'previewImageExtensions' ? DEFAULT_PREVIEW_EXTENSIONS.image
        : key === 'previewVideoExtensions' ? DEFAULT_PREVIEW_EXTENSIONS.video
          : DEFAULT_PREVIEW_EXTENSIONS.audio
    put(key, stringList(patch[key], fallback, CLOUDDRIVE_LIMITS.previewExtensionsMax))
  }
  if (patch.previewRules !== undefined) {
    if (patch.previewRules.length > CLOUDDRIVE_LIMITS.previewRulesMax) return { error: 'Too many preview rules' }
    const rules = parsePreviewRules(patch.previewRules)
    if (rules.length !== patch.previewRules.length) return { error: 'Invalid preview rule' }
    put('previewRules', rules)
  }
  return { rows }
}
