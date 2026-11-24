export const OFFICE_FILE_TYPES = ['sheets', 'docs', 'slides', 'bases', 'boards', 'pdfs'] as const

export type OfficeFileType = (typeof OFFICE_FILE_TYPES)[number]

export const OFFICE_LIMITS = {
  titleMax: 120,
  filesPerUser: 500,
  /** Snapshots and assets together: the ceiling one account's Office content may occupy. */
  bytesPerUser: 512 * 1024 * 1024,
  foldersMaxPerUser: 2_000,
  folderDepthMax: 12,
  tagsMaxPerUser: 5_000,
  versionsPerFile: 20,
  batchLimit: 200,
  snapshotBytes: 10 * 1024 * 1024,
  pdfSnapshotBytes: 50 * 1024 * 1024,
  assetBytes: 10 * 1024 * 1024,
  listLimit: 200,
  autosaveDelayMs: 1200,
  aiReadChars: 20_000,
  aiPlanBytes: 256 * 1024,
} as const

/**
 * Where Univer's history panel asks for versions. It is a shared constant because it is a contract:
 * the client registers the plugin with this prefix and the worker mounts its routes on it.
 */
export const OFFICE_HISTORY_PATH = '/universer-api/history'

export const OFFICE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const OFFICE_FILE_MIMES = ['application/pdf', 'text/plain', 'text/csv'] as const
export const OFFICE_ASSET_MIMES = [...OFFICE_IMAGE_MIMES, ...OFFICE_FILE_MIMES] as const
export type OfficeAssetMime = (typeof OFFICE_ASSET_MIMES)[number]

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
}

export function isOfficeFileType(value: unknown): value is OfficeFileType {
  return typeof value === 'string' && (OFFICE_FILE_TYPES as readonly string[]).includes(value)
}

export function isOfficeAssetMime(value: unknown): value is string {
  return typeof value === 'string' && (OFFICE_ASSET_MIMES as readonly string[]).includes(value)
}

export function officeAssetExtension(mime: string): string | null {
  return EXTENSION_BY_MIME[mime] ?? null
}

export function isOfficeAssetId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** The snapshot key for one immutable revision. */
export function officeSnapshotKey(userId: string, fileId: string, rev: number): string {
  return `office/txt/${userId}/${fileId}/${rev}.json`
}

/** Images keep their own prefix; other attachments use `office/files`. */
export function officeImageKey(userId: string, sha256: string, extension: string): string {
  return `office/images/${userId}/${sha256}.${extension}`
}

export function officeFileKey(userId: string, sha256: string, extension: string): string {
  return `office/files/${userId}/${sha256}.${extension}`
}

export function officeAssetKey(input: {
  userId: string
  sha256: string
  mime: string
}): string | null {
  const extension = officeAssetExtension(input.mime)
  if (!extension) return null
  return input.mime.startsWith('image/')
    ? officeImageKey(input.userId, input.sha256, extension)
    : officeFileKey(input.userId, input.sha256, extension)
}

/**
 * A title the UI may show and the API may store. Control characters are refused rather than
 * stripped: a name that differs from what the reader typed is a different name.
 */
export function normalizeOfficeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value.trim().replace(/\s+/g, ' ')
  if (!title || title.length > OFFICE_LIMITS.titleMax) return null
  if (/[\u0000-\u001f\u007f]/.test(title)) return null
  return title
}

export function officeSnapshotLimit(type: OfficeFileType): number {
  return type === 'pdfs' ? OFFICE_LIMITS.pdfSnapshotBytes : OFFICE_LIMITS.snapshotBytes
}

export function isOfficeFolderName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const name = value.trim()
  return Boolean(name) && name.length <= OFFICE_LIMITS.titleMax && !/[\u0000-\u001f\u007f/\\]/.test(name)
}

export function isOfficeTagName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const name = value.trim().replace(/^#+/, '')
  return Boolean(name) && name.length <= 60 && !/[\u0000-\u001f\u007f]/.test(name)
}