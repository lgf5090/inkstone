/** Shared vocabulary for the CloudDrive app: paths, names, categories, listing and preferences. */

export const CLOUDDRIVE_CATEGORIES = [
  'txt',
  'images',
  'videos',
  'audios',
  'documents',
  'sheets',
  'slides',
  'archives',
  'code',
  'ebooks',
  'other',
] as const

export type CloudDriveCategory = (typeof CLOUDDRIVE_CATEGORIES)[number]

export const CLOUDDRIVE_LIMITS = {
  pathMaxBytes: 1024,
  segmentMaxBytes: 255,
  depthMax: 64,
  listLimit: 100,
  listMax: 500,
  folderListMax: 2000,
  batchMax: 200,
  tagMaxLength: 32,
  tagsPerFileMax: 50,
  previewRulesMax: 100,
  previewExtensionsMax: 200,
  zipMaxBytes: 2 * 1024 * 1024 * 1024,
  zipMaxItems: 2000,
  directUploadMaxBytes: 512 * 1024,
  partSizeMinBytes: 5 * 1024 * 1024,
  partSizeMaxBytes: 95 * 1024 * 1024,
  partsMax: 10_000,
} as const

const EXTENSIONS: Record<Exclude<CloudDriveCategory, 'other'>, readonly string[]> = {
  txt: ['txt', 'md', 'markdown', 'log', 'ini', 'cfg', 'conf', 'properties', 'env'],
  images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'svg', 'ico', 'heic', 'heif', 'jxl'],
  videos: ['mp4', 'webm', 'm4v', 'm3u8', 'mov', 'mkv', 'avi', 'wmv', 'flv'],
  audios: ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba', 'mid', 'midi'],
  documents: ['pdf', 'doc', 'docx', 'dot', 'dotx', 'rtf', 'odt', 'ott'],
  sheets: ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods', 'fods'],
  slides: ['ppt', 'pptx', 'pptm', 'ppsx', 'pps', 'odp', 'key'],
  archives: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab', 'iso', 'jar', 'apk'],
  code: [
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'html', 'htm',
    'xml', 'xsl', 'xslt', 'vue', 'svelte', 'astro', 'yaml', 'yml', 'toml', 'json', 'json5',
    'jsonc', 'ndjson', 'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'sql', 'go', 'rs',
    'java', 'kt', 'kts', 'swift', 'rb', 'php', 'py', 'pl', 'lua', 'scala', 'dart', 'c',
    'cpp', 'cc', 'cxx', 'h', 'hpp', 'cs', 'proto', 'graphql', 'gql', 'prisma', 'tex', 'bib',
    'diff', 'patch',
  ],
  ebooks: ['epub', 'mobi', 'azw3', 'azw', 'fb2', 'djvu', 'cbz', 'cbr'],
}

export function filenameOf(path: string): string {
  const trimmed = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path
  const index = trimmed.lastIndexOf('/')
  return index < 0 ? trimmed : trimmed.slice(index + 1)
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot <= 0 || dot === filename.length - 1 ? '' : filename.slice(dot + 1).toLocaleLowerCase()
}

export function categoryFor(filename: string, mime = ''): CloudDriveCategory {
  const extension = extensionOf(filename)
  for (const category of CLOUDDRIVE_CATEGORIES) {
    if (category === 'other') continue
    if (EXTENSIONS[category].includes(extension)) return category
  }
  if (mime.startsWith('image/')) return 'images'
  if (mime.startsWith('video/')) return 'videos'
  if (mime.startsWith('audio/')) return 'audios'
  if (mime === 'application/pdf') return 'documents'
  if (mime.startsWith('text/')) return 'txt'
  return 'other'
}

const WINDOWS_DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export function foldedName(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase()
}

export function cloudDriveNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'A name is required'
  if (name === '.' || name === '..') return 'The name is reserved'
  if (name.includes('/') || name.includes('\\')) return 'A name cannot contain a slash'
  if (/[\u0000-\u001f]/.test(name)) return 'The name contains a control character'
  if (/[. ]$/.test(name)) return 'The name cannot end with a dot or a space'
  if (WINDOWS_DEVICES.test(name)) return 'The name is reserved by Windows'
  if (new TextEncoder().encode(name.normalize('NFC')).byteLength > CLOUDDRIVE_LIMITS.segmentMaxBytes) {
    return 'The name is too long'
  }
  return null
}

export interface NormalizePathOptions {
  allowRoot?: boolean
}

export function normalizeCloudDrivePath(input: string, options: NormalizePathOptions = {}): string {
  const allowRoot = options.allowRoot ?? true
  let decoded = input
  try {
    decoded = decodeURIComponent(input)
  } catch {
    throw new Error('invalid_path')
  }
  let path = decoded.normalize('NFC')
  if (!path.startsWith('/')) path = `/${path}`
  path = path.replace(/\/{2,}/g, '/')
  if (path.length > 1) path = path.replace(/\/+$/, '')
  if (path === '/') {
    if (!allowRoot) throw new Error('invalid_path')
    return '/'
  }
  if (/[\u0000-\u001f]/.test(path)) throw new Error('invalid_path')
  const segments = path.slice(1).split('/')
  if (segments.length > CLOUDDRIVE_LIMITS.depthMax) throw new Error('invalid_path')
  for (const segment of segments) {
    const problem = cloudDriveNameProblem(segment)
    if (problem) throw new Error('invalid_path')
  }
  if (new TextEncoder().encode(path).byteLength > CLOUDDRIVE_LIMITS.pathMaxBytes) {
    throw new Error('invalid_path')
  }
  return path
}

export function parentPathOf(path: string): string {
  if (path === '/') return '/'
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function childPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

/** `report (1).pdf`, `report (2).pdf`; the extension stays at the end. */
export function autoSuffixName(name: string, attempt: number): string {
  if (attempt <= 0) return name
  const dot = name.lastIndexOf('.')
  const base = dot <= 0 ? name : name.slice(0, dot)
  const extension = dot <= 0 ? '' : name.slice(dot)
  return `${base} (${attempt})${extension}`
}

/** `report (restored).pdf` */
export function restoredName(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name} (restored)`
  return `${name.slice(0, dot)} (restored)${name.slice(dot)}`
}

export const CLOUDDRIVE_SORT_KEYS = ['name', 'size', 'uploaded', 'modified', 'type'] as const
export type CloudDriveSortKey = (typeof CLOUDDRIVE_SORT_KEYS)[number]
export type CloudDriveSortDirection = 'asc' | 'desc'

export const CLOUDDRIVE_VIEW_MODES = ['icon', 'list', 'gallery', 'column'] as const
export type CloudDriveViewMode = (typeof CLOUDDRIVE_VIEW_MODES)[number]

export const CLOUDDRIVE_FILENAME_DISPLAY = ['truncate', 'middle', 'wrap'] as const
export type CloudDriveFilenameDisplay = (typeof CLOUDDRIVE_FILENAME_DISPLAY)[number]

export interface CloudDrivePrefs {
  viewMode: CloudDriveViewMode
  iconSize: number
  density: number
  gap: number
  showCheckboxes: boolean
  showActions: boolean
  animation: boolean
  filenameDisplay: CloudDriveFilenameDisplay
  sortKey: CloudDriveSortKey
  sortDir: CloudDriveSortDirection
  groupBy: 'none' | 'kind' | 'date' | 'size'
  foldersFirst: boolean
  sidebarVisible: boolean
  sidebarWidth: number
  inspectorVisible: boolean
  pathBarVisible: boolean
  statusBarVisible: boolean
  lastMountId: string
  uploadConcurrency: number
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback
}

export function parseCloudDrivePrefs(value: unknown): CloudDrivePrefs {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const viewMode = CLOUDDRIVE_VIEW_MODES.includes(record.viewMode as CloudDriveViewMode)
    ? record.viewMode as CloudDriveViewMode
    : 'list'
  const filenameDisplay = CLOUDDRIVE_FILENAME_DISPLAY.includes(record.filenameDisplay as CloudDriveFilenameDisplay)
    ? record.filenameDisplay as CloudDriveFilenameDisplay
    : 'truncate'
  const sortKey = CLOUDDRIVE_SORT_KEYS.includes(record.sortKey as CloudDriveSortKey)
    ? record.sortKey as CloudDriveSortKey
    : 'name'
  const sortDir = record.sortDir === 'desc' ? 'desc' : 'asc'
  return {
    viewMode,
    iconSize: clampNumber(record.iconSize, 32, 128, 72),
    density: clampNumber(record.density, 0, 100, 50),
    gap: clampNumber(record.gap, 0, 24, 8),
    showCheckboxes: record.showCheckboxes !== false,
    showActions: record.showActions !== false,
    animation: record.animation !== false,
    filenameDisplay,
    sortKey,
    sortDir,
    groupBy: record.groupBy === 'kind' || record.groupBy === 'date' || record.groupBy === 'size' ? record.groupBy : 'none',
    foldersFirst: record.foldersFirst !== false,
    sidebarVisible: record.sidebarVisible !== false,
    sidebarWidth: clampNumber(record.sidebarWidth, 168, 360, 220),
    inspectorVisible: record.inspectorVisible === true,
    pathBarVisible: record.pathBarVisible !== false,
    statusBarVisible: record.statusBarVisible !== false,
    lastMountId: typeof record.lastMountId === 'string' ? record.lastMountId : 'primary',
    uploadConcurrency: clampNumber(record.uploadConcurrency, 1, 8, 3),
  }
}

export interface CloudDriveTagView {
  name: string
  color: string
}

export interface CloudDriveEntry {
  id: string
  kind: 'folder' | 'file'
  name: string
  path: string
  mountId: string
  mountName: string
  category: CloudDriveCategory
  mime: string
  size: number
  uploadedAt: number
  modifiedAt: number
  starredAt: number | null
  readOnly: boolean
  hasThumbnail: boolean
  storage: string
  storageKind: 'r2' | 'distributed' | 'external'
  color: string | null
  tags: CloudDriveTagView[]
  note?: string | null
  hiddenPatterns?: string[]
}

export interface CloudDriveListing {
  mountId: string
  path: string
  folders: CloudDriveEntry[]
  files: CloudDriveEntry[]
  cursor: string | null
  total: number | null
  foldersTruncated: boolean
  note?: string | null
}

export interface CloudDriveUsage {
  usedBytes: number
  trashBytes: number
  quotaBytes: number | null
  primaryAvailable: boolean
}

export interface CloudDriveMountSummary {
  id: string
  name: string
  mountPath: string
  storageId: string
  storageType: string
  readOnly: boolean
  enabled: boolean
  online: boolean
}

export interface CloudDriveBootstrap {
  user: { id: string; role: 'owner' | 'member' }
  primaryMount: CloudDriveMountSummary | null
  mounts: CloudDriveMountSummary[]
  settings: Record<string, unknown>
  usage: CloudDriveUsage
  prefsVersion: 1
  capabilities: { fsAccess: boolean; notifications: boolean }
}

export function encodeCloudDriveCursor(value: { v: string | number | null; id: string }): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export function decodeCloudDriveCursor(cursor: string): { v: string | number | null; id: string } {
  const padded = cursor.replace(/-/g, '+').replace(/_/g, '/')
  const parsed = JSON.parse(atob(padded)) as { v?: unknown; id?: unknown }
  if ((typeof parsed.v !== 'string' && typeof parsed.v !== 'number' && parsed.v !== null)
    || typeof parsed.id !== 'string') {
    throw new Error('invalid_cursor')
  }
  return { v: parsed.v, id: parsed.id }
}
