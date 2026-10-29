export const IMGBED_CHANNEL_TYPES = [
  'telegram',
  'cfr2',
  's3',
  'discord',
  'huggingface',
  'webdav',
] as const

export type ImgbedChannelType = (typeof IMGBED_CHANNEL_TYPES)[number]
export type ImgbedSource = ImgbedChannelType | 'external'

export const IMGBED_CHANNEL_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  Telegram: 'Telegram',
  TelegramNew: 'Telegram',
  cfr2: 'Cloudflare R2',
  CloudflareR2: 'Cloudflare R2',
  s3: 'S3',
  S3: 'S3',
  discord: 'Discord',
  Discord: 'Discord',
  huggingface: 'HuggingFace',
  HuggingFace: 'HuggingFace',
  webdav: 'WebDAV',
  WebDAV: 'WebDAV',
  external: 'External',
  External: 'External',
}

export function imgbedChannelLabel(source: string | null | undefined): string {
  if (!source) return ''
  return IMGBED_CHANNEL_LABELS[source] ?? source
}

const ENV_CHANNEL_DISPLAY: Record<string, string> = {
  Telegram_env: 'Telegram',
  R2_env: 'Cloudflare R2',
  S3_env: 'S3',
  Discord_env: 'Discord',
  HuggingFace_env: 'HuggingFace',
  WebDAV_env: 'WebDAV',
}

export function imgbedChannelDisplayName(name: string | null | undefined): string {
  if (!name) return ''
  return ENV_CHANNEL_DISPLAY[name] ?? name
}

export const IMGBED_CATEGORIES = [
  'images',
  'videos',
  'audios',
  'txt',
  'documents',
  'archives',
  'other',
] as const

export type ImgbedCategory = (typeof IMGBED_CATEGORIES)[number]

export const IMGBED_LIST_TYPES = ['None', 'White', 'Block'] as const
export type ImgbedListType = (typeof IMGBED_LIST_TYPES)[number]

export const IMGBED_LABELS = ['None', 'everyone', 'teen', 'adult'] as const
export type ImgbedLabel = (typeof IMGBED_LABELS)[number]

export const IMGBED_NAME_TYPES = ['default', 'index', 'origin', 'short'] as const
export type ImgbedNameType = (typeof IMGBED_NAME_TYPES)[number]

export const IMGBED_TOKEN_SCOPES = ['list', 'upload', 'delete', 'manage'] as const
export type ImgbedTokenScope = (typeof IMGBED_TOKEN_SCOPES)[number]

export const IMGBED_LINK_FORMATS = ['originUrl', 'mdUrl', 'htmlUrl', 'bbUrl'] as const
export type ImgbedLinkFormat = (typeof IMGBED_LINK_FORMATS)[number]

export const IMGBED_MAX_FILE_SIZE_MB = 5120
export const IMGBED_CHUNK_THRESHOLD_MB = 20
export const IMGBED_PART_SIZE_MB = 16
export const IMGBED_TAG_MAX_LENGTH = 512
export const IMGBED_AI_TAG_MAX_LENGTH = 24
export const IMGBED_PATH_MAX_LENGTH = 512
export const IMGBED_LIST_MAX = 10000

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic',
])
const VIDEO_EXTENSIONS = new Set([
  'mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', '3gp', 'mpeg', 'mpg', 'ts', 'flv', 'wmv', 'rmvb',
])
const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'ape',
])
const TXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml', 'csv', 'tsv', 'log', 'ini', 'conf',
  'html', 'htm', 'css', 'js', 'mjs', 'ts', 'sh', 'py', 'sql',
])
const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp',
])
const ARCHIVE_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz',
])

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp', mpeg: 'video/mpeg',
  mpg: 'video/mpeg', ts: 'video/mp2t', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
  rmvb: 'application/vnd.rn-realmedia-vbr',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wma: 'audio/x-ms-wma', ape: 'audio/ape',
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json',
  xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', csv: 'text/csv',
  tsv: 'text/tab-separated-values', log: 'text/plain', ini: 'text/plain', conf: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  mjs: 'text/javascript', sh: 'text/x-shellscript', py: 'text/x-python',
  sql: 'text/plain', pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation', zip: 'application/zip',
  rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', tar: 'application/x-tar',
  gz: 'application/gzip', tgz: 'application/gzip', bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
}

export function extensionOf(fileName: string): string {
  return /\.([A-Za-z0-9]{1,8})$/.exec(fileName)?.[1]?.toLowerCase() ?? ''
}

export function mimeFromExtension(fileName: string): string {
  return MIME_BY_EXTENSION[extensionOf(fileName)] ?? 'application/octet-stream'
}

export function resolveFileType(fileName: string, reported: string | undefined | null): string {
  const normalized = (reported ?? '').trim().toLowerCase().split(';', 1)[0] ?? ''
  if (normalized && normalized !== 'application/octet-stream') return normalized
  return mimeFromExtension(fileName)
}

export function fileTypeCategory(fileType: string): 'image' | 'video' | 'audio' | 'other' {
  if (fileType.startsWith('image/')) return 'image'
  if (fileType.startsWith('video/')) return 'video'
  if (fileType.startsWith('audio/')) return 'audio'
  return 'other'
}

export function categoryFor(fileType: string, fileName: string): ImgbedCategory {
  const ext = extensionOf(fileName)
  if (IMAGE_EXTENSIONS.has(ext) || fileType.startsWith('image/')) return 'images'
  if (VIDEO_EXTENSIONS.has(ext) || fileType.startsWith('video/')) return 'videos'
  if (AUDIO_EXTENSIONS.has(ext) || fileType.startsWith('audio/')) return 'audios'
  if (TXT_EXTENSIONS.has(ext) || fileType.startsWith('text/')) return 'txt'
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'documents'
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archives'
  return 'other'
}

export function extensionFor(fileType: string, fileName: string): string {
  return extensionOf(fileName) || extensionFromMime(fileType) || 'bin'
}

function extensionFromMime(fileType: string): string {
  switch (fileType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/gif': return 'gif'
    case 'image/webp': return 'webp'
    case 'image/svg+xml': return 'svg'
    case 'image/avif': return 'avif'
    case 'application/pdf': return 'pdf'
    case 'text/plain': return 'txt'
    case 'application/json': return 'json'
    case 'application/zip': return 'zip'
    default: return ''
  }
}

const UNSAFE_PATH_CHARS = /[\\:*?"'<>| ()\[\]{}#%^`~;@&=+$,]/g

export function sanitizeFolderPath(input: string): string {
  let folder = String(input ?? '')
  if (/%[0-9a-fA-F]{2}/.test(folder)) {
    try { folder = decodeURIComponent(folder) } catch {  }
  }
  return folder
    .replace(/\.\./g, '_')
    .split('/')
    .map((segment) => segment === '.' ? '_' : segment)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((segment) => segment.replace(UNSAFE_PATH_CHARS, '_'))
    .filter(Boolean)
    .join('/')
}

export function sanitizeFileName(input: string): string {
  const name = String(input ?? '').split('/').pop() ?? ''
  return name.replace(UNSAFE_PATH_CHARS, '_').replace(/[\u0000-\u001f]/g, '_').trim()
}

export interface FolderValidation {
  valid: boolean
  error?: string
}

export function validateFolderPath(input: string): FolderValidation {
  const path = String(input ?? '').trim()
  if (!path || path === '/') return { valid: true }
  if (!path.startsWith('/')) return { valid: false, error: 'path_must_start_with_slash' }
  if (path.includes('..')) return { valid: false, error: 'path_traversal' }
  if (/\/\.(\/|$)/.test(path)) return { valid: false, error: 'single_dot_segment' }
  if (path.includes('//')) return { valid: false, error: 'consecutive_slash' }
  if (UNSAFE_PATH_CHARS.test(path)) return { valid: false, error: 'invalid_characters' }
  if (path.length > IMGBED_PATH_MAX_LENGTH) return { valid: false, error: 'path_too_long' }
  return { valid: true }
}

export function directoryOf(fileId: string): string {
  const index = fileId.lastIndexOf('/')
  return index < 0 ? '' : fileId.slice(0, index + 1)
}

export function baseNameOf(fileId: string): string {
  return fileId.slice(fileId.lastIndexOf('/') + 1)
}

export function buildShortId(random: () => number, length = 8): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let index = 0; index < length; index++) out += alphabet[Math.floor(random() * alphabet.length)]
  return out
}

export interface BuildFileIdInput {
  fileName: string
  fileType: string
  folder: string
  nameType: ImgbedNameType
  now?: number
  random?: () => number
  exists: (id: string) => Promise<boolean>
}

export async function buildFileId(input: BuildFileIdInput): Promise<string> {
  const now = input.now ?? Date.now()
  const random = input.random ?? Math.random
  const fileType = resolveFileType(input.fileName, input.fileType)
  const ext = extensionFor(fileType, input.fileName)
  const name = sanitizeFileName(input.fileName)
  const folder = sanitizeFolderPath(input.folder)
  const prefix = folder ? `${folder}/` : ''
  const unique = `${now}${Math.floor(random() * 10_000)}`
  const candidate = (base: string) => `${prefix}${base}`

  if (input.nameType === 'short') {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const id = candidate(`${buildShortId(random)}.${ext}`)
      if (!(await input.exists(id))) return id
    }
    throw new Error('short_id_collision')
  }
  if (input.nameType === 'origin') {
    const first = candidate(name)
    if (name && !(await input.exists(first))) return first
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const originExt = dot > 0 ? name.slice(dot) : ''
    for (let counter = 1; counter <= 1000; counter++) {
      const id = candidate(`${stem}(${counter})${originExt}`)
      if (!(await input.exists(id))) return id
    }
    throw new Error('origin_id_collision')
  }
  const base = input.nameType === 'index' ? `${unique}.${ext}` : `${unique}_${name}`
  if (!(await input.exists(candidate(base)))) return candidate(base)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const baseExt = dot > 0 ? base.slice(dot) : ''
  for (let counter = 1; counter <= 1000; counter++) {
    const id = candidate(`${stem}(${counter})${baseExt}`)
    if (!(await input.exists(id))) return id
  }
  throw new Error('file_id_collision')
}

const TAG_RE = /^[\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af-]+(?:\/[\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af-]+)*$/u

export function normalizeTag(tag: string): string | null {
  const value = String(tag ?? '').trim().toLowerCase()
  if (!value || value.length > IMGBED_TAG_MAX_LENGTH || !TAG_RE.test(value)) return null
  return value
}

export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = []
  for (const tag of tags) {
    const normalized = normalizeTag(tag)
    if (normalized && !out.includes(normalized)) out.push(normalized)
  }
  return out
}

export function parseSearchQuery(input: string): { keywords: string; includeTags: string[]; excludeTags: string[] } {
  const includeTags: string[] = []
  const excludeTags: string[] = []
  const keywords = String(input ?? '')
    .replace(/-#([\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af.-]+)/gu, (_, tag: string) => {
      const normalized = normalizeTag(tag)
      if (normalized) excludeTags.push(normalized)
      return ' '
    })
    .replace(/#([\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af.-]+)/gu, (_, tag: string) => {
      const normalized = normalizeTag(tag)
      if (normalized) includeTags.push(normalized)
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { keywords, includeTags: normalizeTags(includeTags), excludeTags: normalizeTags(excludeTags) }
}

export interface ImgbedPart {
  index: number
  fileId?: string
  messageId?: string
  size: number
}

export interface ImgbedFile {
  id: string
  objectKey: string
  fileName: string
  fileType: string
  sizeBytes: number
  width: number | null
  height: number | null
  uploadIp: string | null
  uploadAddress: string | null
  listType: ImgbedListType
  label: ImgbedLabel
  directory: string
  source: ImgbedSource
  externalLink: string | null
  channel: string
  channelName: string
  isChunked: boolean
  parts: ImgbedPart[] | null
  uploaderId: string | null
  favorite: boolean
  pinned: boolean
  createdAt: number
  updatedAt: number
  tags: string[]
}

export interface ImgbedChannelQuota {
  enabled: boolean
  limitGB: number | null
  threshold: number
}

export interface ImgbedChannel {
  id: string
  type: ImgbedChannelType
  name: string
  config: Record<string, unknown>
  enabled: boolean
  fixed: boolean
  quota: ImgbedChannelQuota
  hasCredentials: boolean
}

export interface ImgbedListQuery {
  dir?: string
  start?: number
  count?: number
  search?: string
  includeTags?: string[]
  excludeTags?: string[]
  listType?: string[]
  accessStatus?: string[]
  label?: string[]
  fileType?: string[]
  channel?: string[]
  channelName?: string[]
  favorite?: boolean
  pinned?: boolean
  tagPrefix?: string
  createdFrom?: number
  createdTo?: number
  recursive?: boolean
  sort?: 'time' | 'size' | 'rawName' | 'fileName'
  sortOrder?: 'asc' | 'desc'
}

export interface ImgbedListResult {
  files: ImgbedFile[]
  directories: string[]
  totalCount: number
  directFileCount: number
  directFolderCount: number
  returnedCount: number
}

export function fileIdentity(file: Pick<ImgbedFile,
  'createdAt' | 'fileName' | 'fileType' | 'sizeBytes' | 'channel' | 'channelName' |
  'source' | 'externalLink' | 'objectKey'>): Promise<string> {
  const fields = [
    file.createdAt, file.fileName, file.fileType, file.sizeBytes, file.channel,
    file.channelName, file.source, file.externalLink, file.objectKey,
  ]
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fields)))
    .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''))
}

export function linkFor(file: ImgbedFile, format: ImgbedLinkFormat, base: string): string {
  const url = file.source === 'external'
    ? file.externalLink ?? ''
    : `${base.replace(/\/+$/, '')}/${file.id}`
  const name = file.fileName || baseNameOf(file.id)
  switch (format) {
    case 'mdUrl': return `![${name}](${url})`
    case 'htmlUrl': return `<img src="${url}" alt="${name}" width=100% />`
    case 'bbUrl': return `[img]${url}[/img]`
    default: return url
  }
}

export const IMGBED_LINK_CONTENT_GROUPS = {
  originUrl: 'originUrl',
  tgId: 'tgId',
  s3Location: 's3Location',
  s3CdnFileUrl: 's3CdnFileUrl',
  webdavPublicUrl: 'webdavPublicUrl',
} as const

export type ImgbedLinkContent = keyof typeof IMGBED_LINK_CONTENT_GROUPS

export function linkContentsFor(channel: string): ImgbedLinkContent[] {
  if (channel === 'Telegram' || channel === 'TelegramNew') return ['originUrl', 'tgId']
  if (channel === 'S3') return ['originUrl', 's3Location', 's3CdnFileUrl']
  if (channel === 'WebDAV') return ['originUrl', 'webdavPublicUrl']
  return ['originUrl']
}
