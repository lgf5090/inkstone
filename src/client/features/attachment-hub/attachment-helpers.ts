import { LIMITS } from '@shared/constants'
import type {
  HubAttachmentListParams,
  HubAttachmentSizeRange,
  HubAttachmentWithUsage,
  HubFolder,
  HubTag,
} from '@shared/attachment-hub'
import type { Folder, Tag } from '@shared/types'
import { t } from '../../lib/i18n'

export const DEFAULT_QUOTA_BYTES = LIMITS.attachmentQuotaBytes

/** One page of the hub's own list; the server caps the page at the same size. */
export const HUB_LIST_LIMIT = 500

/**
 * Written by a dragged card, read by a folder row. It has to be one constant: the reference shipped
 * two spellings, so the drop never landed.
 */
export const HUB_ATTACHMENT_DRAG_TYPE = 'application/x-inkstone-attachments'

export const HUB_BADGE_CLASS = 'bg-[var(--bg-sunken)] text-[var(--text-secondary)]'

export type HubCategory =
  | 'dashboard'
  | 'all'
  | 'image'
  | 'document'
  | 'media'
  | 'archive'
  | 'starred'
  | 'pinned'
  | 'unreferenced'

export type HubSizeFilter = 'all' | HubAttachmentSizeRange

export type HubFileKind = 'image' | 'document' | 'media' | 'archive' | 'other'

/**
 * The sidebar's categories as the list request reads them. 'unreferenced' is a server-side filter,
 * because filtering a page-sized result client-side reports fewer orphans than there are.
 */
export function categoryFilters(category: HubCategory): HubAttachmentListParams {
  switch (category) {
    case 'image':
      return { type: 'image' }
    case 'document':
      return { type: 'document' }
    case 'media':
      return { type: 'media' }
    case 'archive':
      return { type: 'archive' }
    case 'starred':
      return { starred: true }
    case 'pinned':
      return { pinned: true }
    case 'unreferenced':
      return { unreferenced: true }
    default:
      return {}
  }
}

export function fileExtensionOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

export function getFileCategory(mime: string, filename: string): HubFileKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf' || mime.startsWith('text/')
    || mime.includes('document') || mime.includes('sheet') || mime.includes('presentation')
    || mime.includes('word') || mime.includes('excel')) {
    return 'document'
  }
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'media'
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('rar')
    || mime.includes('7z') || mime.includes('gzip')) {
    return 'archive'
  }
  const ext = fileExtensionOf(filename)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image'
  if (['pdf', 'txt', 'md', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'document'
  if (['mp3', 'wav', 'm4a', 'flac', 'mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) return 'media'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive'
  return 'other'
}

export function badgeLabelOf(ext: string): string {
  return ext.toUpperCase().slice(0, 4) || 'FILE'
}

/** A card's id payload arrives as text a third party could have written, so anything odd reads as "nothing dropped". */
export function parseDroppedFileIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  }
  catch {
    return []
  }
}

export interface HubTimelineGroup {
  label: string
  files: HubAttachmentWithUsage[]
}

export function groupAttachmentsByDate(files: HubAttachmentWithUsage[]): HubTimelineGroup[] {
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const todayTime = dayStart.getTime()
  const dayMs = 24 * 60 * 60 * 1000
  const groups = new Map<string, HubAttachmentWithUsage[]>()

  for (const file of files) {
    const fileDate = new Date(file.createdAt)
    const fileDayTime = new Date(
      fileDate.getFullYear(),
      fileDate.getMonth(),
      fileDate.getDate(),
    ).getTime()
    let key: string
    if (fileDayTime === todayTime) key = t('attachments.today')
    else if (fileDayTime === todayTime - dayMs) key = t('attachments.yesterday')
    else {
      const month = String(fileDate.getMonth() + 1).padStart(2, '0')
      key = `${fileDate.getFullYear()}-${month}`
    }
    const list = groups.get(key)
    if (list) list.push(file)
    else groups.set(key, [file])
  }

  return Array.from(groups.entries()).map(([label, groupFiles]) => ({ label, files: groupFiles }))
}

/** The hub's folders are the same tree shape the note explorer draws, so its helpers read them as `Folder`s. */
export function hubFolderToNoteFolder(folder: HubFolder): Folder {
  return {
    id: folder.id,
    parentId: folder.parentId,
    name: folder.name,
    icon: folder.icon ?? null,
    color: folder.color ?? null,
    position: folder.position ?? 0,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  }
}

/** `count` stays zero: the hub tags files, and the file list is what carries how many. */
export function hubTagToNoteTag(tag: HubTag): Tag {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color ?? null,
    isPinned: Boolean(tag.isPinned),
    count: 0,
    createdAt: tag.createdAt,
  }
}
