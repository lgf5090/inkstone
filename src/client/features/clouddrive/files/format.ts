import { formatBytes } from '@shared/byte-format'
import type { CloudDriveCategory, CloudDriveEntry } from '@shared/clouddrive/model'
import type { MessageKey } from '@shared/locales/en-US'
import { getLocale, t } from '../../../lib/i18n'

const KIND_KEYS: Record<CloudDriveCategory | 'folder', MessageKey> = {
  folder: 'clouddrive.kind.folder',
  txt: 'clouddrive.kind.txt',
  images: 'clouddrive.kind.images',
  videos: 'clouddrive.kind.videos',
  audios: 'clouddrive.kind.audios',
  documents: 'clouddrive.kind.documents',
  sheets: 'clouddrive.kind.sheets',
  slides: 'clouddrive.kind.slides',
  archives: 'clouddrive.kind.archives',
  code: 'clouddrive.kind.code',
  ebooks: 'clouddrive.kind.ebooks',
  other: 'clouddrive.kind.other',
}

export function entryKindLabel(entry: CloudDriveEntry): string {
  return t(KIND_KEYS[entry.kind === 'folder' ? 'folder' : entry.category])
}

export function formatEntrySize(entry: CloudDriveEntry): string {
  return entry.kind === 'folder' ? '—' : formatBytes(entry.size)
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

/** One formatter per locale; the list can draw hundreds of dates in one render. */
function dateFormatter(locale: string): Intl.DateTimeFormat {
  const cached = dateFormatters.get(locale)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  dateFormatters.set(locale, formatter)
  return formatter
}

export function formatEntryDate(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return dateFormatter(getLocale()).format(timestamp)
}

export function totalEntryBytes(entries: readonly CloudDriveEntry[]): number {
  let total = 0
  for (const entry of entries) {
    if (entry.kind === 'file') total += entry.size
  }
  return total
}
