import type { ComponentType } from 'react'
import {
  AlertCircle,
  Bookmark,
  Calendar,
  CheckCircle,
  Clock,
  FileText,
  Flag,
  Folder,
  Layers,
  Sparkles,
  Star,
  Tag,
  User,
} from 'lucide-react'
import type { MessageKey } from '../../../i18n'

export interface KanbanIconOption {
  /** The identifier the fence stores, as `lucide:<name>`. */
  name: string
  icon: ComponentType<{ size?: number; className?: string }>
  labelKey: MessageKey
}

/**
 * The icons a board may use — one list for the picker that offers them and the badge that draws
 * them, so a name for a reader and the stored identifier cannot drift apart between the two.
 */
export const KANBAN_ICONS: readonly KanbanIconOption[] = [
  { name: 'CheckCircle', icon: CheckCircle, labelKey: 'preview.kanban_icon_check_circle' },
  { name: 'Clock', icon: Clock, labelKey: 'preview.kanban_icon_clock' },
  { name: 'AlertCircle', icon: AlertCircle, labelKey: 'preview.kanban_icon_alert_circle' },
  { name: 'FileText', icon: FileText, labelKey: 'preview.kanban_icon_file_text' },
  { name: 'Calendar', icon: Calendar, labelKey: 'preview.kanban_icon_calendar' },
  { name: 'Star', icon: Star, labelKey: 'preview.kanban_icon_star' },
  { name: 'Flag', icon: Flag, labelKey: 'preview.kanban_icon_flag' },
  { name: 'Bookmark', icon: Bookmark, labelKey: 'preview.kanban_icon_bookmark' },
  { name: 'Tag', icon: Tag, labelKey: 'preview.kanban_icon_tag' },
  { name: 'User', icon: User, labelKey: 'preview.kanban_icon_user' },
  { name: 'Folder', icon: Folder, labelKey: 'preview.kanban_icon_folder' },
  { name: 'Layers', icon: Layers, labelKey: 'preview.kanban_icon_layers' },
  { name: 'Sparkles', icon: Sparkles, labelKey: 'preview.kanban_icon_sparkles' },
]

/** A freeform icon value is usually one grapheme — an emoji the author picked — so anything
 *  longer than a few clusters is noise a hand-written fence let in, and unbounded it stretches
 *  the card that hosts the badge. */
const KANBAN_ICON_MAX_GRAPHEMES = 3
/** Where `Intl.Segmenter` is missing, code points are the closest safe cut, generous enough to
 *  keep the common single-emoji values whole. */
const KANBAN_ICON_FALLBACK_MAX_CODEPOINTS = 8

export function clampIconText(value: string): string {
  const Segmenter = globalThis.Intl?.Segmenter
  if (Segmenter) {
    const segments = [...new Segmenter().segment(value)]
    return segments.length <= KANBAN_ICON_MAX_GRAPHEMES
      ? value
      : segments.slice(0, KANBAN_ICON_MAX_GRAPHEMES).map((part) => part.segment).join('')
  }
  const points = Array.from(value)
  return points.length <= KANBAN_ICON_FALLBACK_MAX_CODEPOINTS
    ? value
    : points.slice(0, KANBAN_ICON_FALLBACK_MAX_CODEPOINTS).join('')
}

export function KanbanIconBadge({ icon, size = 14 }: { icon?: string | null; size?: number }) {
  if (!icon) return null
  if (icon.startsWith('lucide:')) {
    const option = KANBAN_ICONS.find((entry) => entry.name === icon.slice(7))
    if (option) {
      const Component = option.icon
      return <Component size={size} className='shrink-0 text-[var(--accent)]' />
    }
    // An unknown name stays as its raw value — that is how the author sees the
    // misspelling — clipped in place rather than cut, so the full name survives
    // in the tooltip, to a screen reader and to the tests that read the text.
    return (
      <span title={icon} className='inline-block max-w-[var(--sp-16)] truncate align-middle leading-none'>
        {icon}
      </span>
    )
  }
  return <span className='shrink-0 leading-none'>{clampIconText(icon)}</span>
}
