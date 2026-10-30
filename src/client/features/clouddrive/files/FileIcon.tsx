import {
  BookOpen,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import type { CloudDriveCategory, CloudDriveEntry } from '@shared/clouddrive/model'
import { cn } from '../../../lib/cn'

const ICONS: Record<CloudDriveCategory | 'folder', LucideIcon> = {
  folder: Folder,
  txt: FileText,
  images: FileImage,
  videos: FileVideo,
  audios: FileAudio,
  documents: FileText,
  sheets: FileSpreadsheet,
  slides: Presentation,
  archives: FileArchive,
  code: FileCode2,
  ebooks: BookOpen,
  other: File,
}

/**
 * Category tints are CSS custom properties declared on the feature root, so the palette is
 * the theme's own tokens rather than a second set of hexes. The folder tint comes from the
 * entry (`ORGANIZER_COLORS` or a guarded custom hex) and falls back to the same token.
 */
const CATEGORY_CLASSES: Record<CloudDriveCategory, string> = {
  txt: 'cd-cat-txt',
  images: 'cd-cat-images',
  videos: 'cd-cat-videos',
  audios: 'cd-cat-audios',
  documents: 'cd-cat-documents',
  sheets: 'cd-cat-sheets',
  slides: 'cd-cat-slides',
  archives: 'cd-cat-archives',
  code: 'cd-cat-code',
  ebooks: 'cd-cat-ebooks',
  other: 'cd-cat-other',
}

export function FileIcon({
  entry,
  size = 18,
  fluid = false,
  className,
}: {
  entry: CloudDriveEntry
  /** Pixel size for list rows, headers and inspector thumbnails. */
  size?: number
  /** Icon-view sizing: the size comes from `--cd-icon-size` instead of a number. */
  fluid?: boolean
  className?: string
}) {
  const folder = entry.kind === 'folder'
  const Icon = ICONS[folder ? 'folder' : entry.category]
  const colorClass = folder ? 'cd-folder-icon' : CATEGORY_CLASSES[entry.category]
  return (
    <Icon
      aria-hidden="true"
      focusable="false"
      strokeWidth={1.6}
      size={fluid ? undefined : size}
      className={cn(colorClass, fluid && 'cd-icon-fluid', className)}
      style={folder && entry.color ? { color: entry.color } : undefined}
    />
  )
}
