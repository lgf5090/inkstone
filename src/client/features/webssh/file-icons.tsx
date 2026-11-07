// Extension-to-icon mapping for the SFTP list (W5-03). Icons are lucide components chosen by suffix
// rather than MIME: an SFTP listing carries a name and permissions, and the name is what the user
// recognises. Unknown suffixes fall back to a plain file glyph.

import type { LucideIcon } from 'lucide-react'
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Link,
} from 'lucide-react'
import type { WebsshSftpEntry } from '@shared/webssh/types'
import { cn } from '../../lib/cn'

interface Glyph {
  Icon: LucideIcon
  tone: string
}

const CODE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp',
  'java', 'kt', 'swift', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'lua', 'sql', 'html', 'htm',
  'css', 'scss', 'less', 'vue', 'svelte', 'toml', 'yaml', 'yml', 'xml', 'ini', 'conf', 'env',
])
const TEXT = new Set(['txt', 'md', 'markdown', 'rst', 'log', 'license', 'readme', 'nfo'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'avif'])
const ARCHIVE = new Set(['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'zst'])
const AUDIO = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'])
const VIDEO = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'])
const SHEET = new Set(['csv', 'tsv', 'xls', 'xlsx', 'ods'])
const KEY = new Set(['pem', 'key', 'pub', 'crt', 'cer', 'asc', 'gpg', 'ppk'])
const CONFIG = new Set(['service', 'socket', 'timer', 'desktop', 'plist'])

const TEXT_EXTENSIONS = new Set([...CODE, ...TEXT, ...SHEET, 'json', 'jsonc'])

function extensionOf(name: string): string {
  const base = name.toLowerCase()
  if (base === 'readme' || base === 'license' || base === 'makefile' || base === 'dockerfile') return base
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1) : ''
}

function glyphFor(entry: Pick<WebsshSftpEntry, 'name' | 'kind'>): Glyph {
  if (entry.kind === 'directory') return { Icon: Folder, tone: 'text-[var(--accent)]' }
  if (entry.kind === 'symlink') return { Icon: Link, tone: 'text-[var(--accent)]' }
  const extension = extensionOf(entry.name)
  if (extension === 'json' || extension === 'jsonc') return { Icon: FileJson, tone: 'text-[var(--warning)]' }
  if (CODE.has(extension)) return { Icon: FileCode, tone: 'text-[var(--accent)]' }
  if (TEXT.has(extension)) return { Icon: FileText, tone: 'text-[var(--text-secondary)]' }
  if (IMAGE.has(extension)) return { Icon: FileImage, tone: 'text-[var(--accent)]' }
  if (ARCHIVE.has(extension)) return { Icon: FileArchive, tone: 'text-[var(--warning)]' }
  if (AUDIO.has(extension)) return { Icon: FileAudio, tone: 'text-[var(--accent)]' }
  if (VIDEO.has(extension)) return { Icon: FileVideo, tone: 'text-[var(--accent)]' }
  if (SHEET.has(extension)) return { Icon: FileSpreadsheet, tone: 'text-[var(--success)]' }
  if (KEY.has(extension)) return { Icon: FileKey, tone: 'text-[var(--danger)]' }
  if (CONFIG.has(extension)) return { Icon: FileCog, tone: 'text-[var(--text-secondary)]' }
  return { Icon: File, tone: 'text-[var(--text-tertiary)]' }
}

/** Whether the editor should offer this entry: a regular, text-shaped file, by name alone. */
export function isEditableTextEntry(entry: Pick<WebsshSftpEntry, 'name' | 'kind'>): boolean {
  if (entry.kind !== 'file') return false
  const extension = extensionOf(entry.name)
  return extension === '' || TEXT_EXTENSIONS.has(extension)
}

export function FileGlyph({ entry, size = 15 }: { entry: Pick<WebsshSftpEntry, 'name' | 'kind'>; size?: number }) {
  const { Icon, tone } = glyphFor(entry)
  return <Icon size={size} aria-hidden="true" className={cn('shrink-0', tone)} />
}
