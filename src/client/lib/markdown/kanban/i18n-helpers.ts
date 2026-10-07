import { t, getLocale, type MessageKey } from '../../i18n'
import type { KanbanColorName, KanbanOption, KanbanProperty, KanbanView, KanbanViewType } from './types'

const VIEW_NAME_MAP: Record<string, MessageKey> = {
  board: 'preview.kanban_view_board',
  table: 'preview.kanban_view_table',
  calendar: 'preview.kanban_view_calendar',
  timeline: 'preview.kanban_view_timeline',
  gantt: 'preview.kanban_view_gantt',
  list: 'preview.kanban_view_list',
  gallery: 'preview.kanban_view_gallery',
  chart: 'preview.kanban_view_chart',
}

// Only `<type> <n>`, the shape the view switcher generates, is taken apart for translating; a name
// a reader typed that merely looks numbered stays exactly as they wrote it.
const GENERATED_VIEW_NAME = /^(.*?)\s(\d+)$/

export function formatKanbanViewName(view: KanbanView): string {
  const byTypeKey = VIEW_NAME_MAP[view.type]
  const isDefaultName = !view.name || view.name.toLowerCase() === view.type.toLowerCase()
  if (isDefaultName && byTypeKey) {
    return t(byTypeKey)
  }
  const numbered = GENERATED_VIEW_NAME.exec(view.name)
  const byNameKey = VIEW_NAME_MAP[numbered ? numbered[1]!.toLowerCase() : view.name.toLowerCase()]
  if (byNameKey) {
    return numbered ? `${t(byNameKey)} ${numbered[2]}` : t(byNameKey)
  }
  return view.name
}

/** The name of a view kind on its own, for lists of kinds rather than of the board's views. */
export function formatKanbanViewTypeLabel(type: KanbanViewType): string {
  const key = VIEW_NAME_MAP[type]
  return key ? t(key) : type
}

const PROPERTY_NAME_MAP: Record<string, MessageKey> = {
  title: 'preview.kanban_prop_title',
  status: 'preview.kanban_prop_status',
  priority: 'preview.kanban_prop_priority',
  assignee: 'preview.kanban_prop_assignee',
  startdate: 'preview.kanban_prop_start_date',
  start_date: 'preview.kanban_prop_start_date',
  enddate: 'preview.kanban_prop_end_date',
  end_date: 'preview.kanban_prop_end_date',
  progress: 'preview.kanban_prop_progress',
  tags: 'preview.kanban_prop_tags',
  files: 'preview.kanban_files',
  subtasks: 'preview.kanban_subtasks',
}

// The id is what the fence stores values under, so it is also what names a built-in column — but only
// while the column still carries that name. A reader who renamed it wrote the phrase they want shown,
// and no locale may replace it.
function normalizedName(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, '')
}

export function formatKanbanPropertyName(prop: KanbanProperty | string): string {
  const fallback = typeof prop === 'string' ? prop : prop.name
  const normalized = normalizedName(typeof prop === 'string' ? prop : prop.id || prop.name)
  const key = PROPERTY_NAME_MAP[normalized]
  if (!key) return fallback
  if (typeof prop === 'string') return t(key)
  const typed = prop.name.trim()
  if (typed && normalizedName(typed) !== normalized) return prop.name
  return t(key)
}

const OPTION_LABEL_MAP: Record<string, MessageKey> = {
  todo: 'preview.kanban_status_todo',
  'to do': 'preview.kanban_status_todo',
  in_progress: 'preview.kanban_status_in_progress',
  'in progress': 'preview.kanban_status_in_progress',
  done: 'preview.kanban_status_done',
  low: 'preview.kanban_priority_low',
  medium: 'preview.kanban_priority_medium',
  high: 'preview.kanban_priority_high',
  feat: 'preview.kanban_tag_feat',
  feature: 'preview.kanban_tag_feat',
  improve: 'preview.kanban_tag_improve',
  improvement: 'preview.kanban_tag_improve',
  bug: 'preview.kanban_tag_bug',
}

const COLOR_NAME_MAP: Record<KanbanColorName, MessageKey> = {
  gray: 'preview.kanban_color_gray',
  brown: 'preview.kanban_color_brown',
  orange: 'preview.kanban_color_orange',
  yellow: 'preview.kanban_color_yellow',
  green: 'preview.kanban_color_green',
  blue: 'preview.kanban_color_blue',
  purple: 'preview.kanban_color_purple',
  pink: 'preview.kanban_color_pink',
  red: 'preview.kanban_color_red',
  coral: 'preview.kanban_color_coral',
  teal: 'preview.kanban_color_teal',
  slate: 'preview.kanban_color_slate',
}

/** The colour's name for a reader, since the token (`slate`) is what the fence stores. */
export function formatKanbanColorName(color: KanbanColorName): string {
  return t(COLOR_NAME_MAP[color])
}

export function formatKanbanOptionLabel(optionOrLabel: KanbanOption | string, propId?: string): string {
  const id = typeof optionOrLabel === 'string' ? optionOrLabel : optionOrLabel.id
  const label = typeof optionOrLabel === 'string' ? optionOrLabel : optionOrLabel.label
  const idKey = OPTION_LABEL_MAP[id.toLowerCase()]
  if (idKey) return t(idKey)
  const labelKey = OPTION_LABEL_MAP[label.toLowerCase()]
  if (labelKey) return t(labelKey)
  if (propId === 'status') {
    const statusKey = OPTION_LABEL_MAP[label.toLowerCase().replace(/\s+/g, '_')]
    if (statusKey) return t(statusKey)
  }
  return label
}

export function formatKanbanGroupLabel(groupKey: string, fallbackLabel: string): string {
  if (groupKey === '__none__' || fallbackLabel === 'No Status') {
    return t('preview.kanban_no_status')
  }
  return formatKanbanOptionLabel(fallbackLabel)
}

/** A number read back the way the reader's locale writes numbers, for the column header's sum pill. */
export function formatKanbanSum(value: number): string {
  return new Intl.NumberFormat(getLocale()).format(value)
}
