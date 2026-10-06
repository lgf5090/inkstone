import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import type { MessageKey } from './i18n'

export type GroupBy = 'none' | 'folder' | 'tag'

export type GraphLinkDirection = 'both' | 'incoming' | 'outgoing'

export interface GraphColorGroup {
  id: string
  query: string
  color: string
}

export interface GraphPreferences {
  mode: 'global' | 'local'
  depth: number
  limit: number
  includeOrphans: boolean
  includeUnresolved: boolean
  showTagNodes: boolean
  arrows: boolean
  labels: boolean
  groupBy: GroupBy
  colorGroups: GraphColorGroup[]
  folderId: string
  tags: string[]
  tagsMatch: 'any' | 'all'
  pinnedNodeIds: string[]
  excludedNoteIds: string[]
  direction: GraphLinkDirection
  exportWithoutTitles: boolean
  exportTransparentBackground: boolean
  repulsion: number
  linkDistance: number
  nodeScale: number
}

export const GRAPH_PREFS_KEY = 'inkstone.graph.preferences.v1'

export const GRAPH_DEPTHS: number[] = Array.from(
  { length: LIMITS.graphDepthMax - LIMITS.graphDepthMin + 1 },
  (_unused, index) => LIMITS.graphDepthMin + index,
)

export const GRAPH_LINK_DIRECTIONS: ReadonlyArray<{ value: GraphLinkDirection; labelKey: MessageKey }> = [
  { value: 'both', labelKey: 'graph.direction_both' },
  { value: 'incoming', labelKey: 'graph.direction_incoming' },
  { value: 'outgoing', labelKey: 'graph.direction_outgoing' },
]

export const GRAPH_COLOR_GROUP_LIMIT = LIMITS.graphColorGroupMax

export const GRAPH_PINNED_MAX = 200

export const GRAPH_LIMIT_STEP = 50

interface GraphToggleControl {
  prefKey: 'includeOrphans' | 'includeUnresolved' | 'showTagNodes' | 'arrows' | 'labels'
    | 'exportWithoutTitles' | 'exportTransparentBackground'
  labelKey: MessageKey
  hintKey?: MessageKey
  default: boolean
}

export const GRAPH_SETTINGS_TOGGLES: ReadonlyArray<GraphToggleControl> = [
  { prefKey: 'includeOrphans', labelKey: 'graph.show_orphans', default: true },
  { prefKey: 'includeUnresolved', labelKey: 'graph.show_unresolved', default: true },
  { prefKey: 'showTagNodes', labelKey: 'graph.show_tags', default: false },
  { prefKey: 'arrows', labelKey: 'graph.show_arrows', default: true },
  { prefKey: 'labels', labelKey: 'graph.show_labels', default: true },
  { prefKey: 'exportWithoutTitles', labelKey: 'graph.export_without_titles', hintKey: 'graph.export_without_titles_hint', default: false },
  { prefKey: 'exportTransparentBackground', labelKey: 'graph.export_transparent_background', hintKey: 'graph.export_transparent_background_hint', default: false },
]

export const GRAPH_TOGGLE_DEFAULTS = Object.fromEntries(
  GRAPH_SETTINGS_TOGGLES.map((control) => [control.prefKey, control.default]),
) as Record<GraphToggleControl['prefKey'], boolean>

export const GRAPH_SHOW_TOGGLES = GRAPH_SETTINGS_TOGGLES.filter(
  (control) => control.prefKey === 'includeOrphans' || control.prefKey === 'includeUnresolved' || control.prefKey === 'showTagNodes',
)

export const GRAPH_APPEARANCE_TOGGLES = GRAPH_SETTINGS_TOGGLES.filter(
  (control) => control.prefKey === 'arrows' || control.prefKey === 'labels',
)

export const GRAPH_EXPORT_TOGGLES = GRAPH_SETTINGS_TOGGLES.filter(
  (control) => control.prefKey === 'exportWithoutTitles' || control.prefKey === 'exportTransparentBackground',
)

export interface GraphRangeControl {
  prefKey: 'repulsion' | 'linkDistance' | 'nodeScale'
  labelKey: MessageKey
  min: number
  max: number
  step: number
  default: number
}

export const GRAPH_FORCE_RANGES: ReadonlyArray<GraphRangeControl> = [
  { prefKey: 'repulsion', labelKey: 'graph.repulsion', min: 300, max: 1800, step: 50, default: 900 },
  { prefKey: 'linkDistance', labelKey: 'graph.link_distance', min: 40, max: 150, step: 5, default: 76 },
  { prefKey: 'nodeScale', labelKey: 'graph.node_size', min: 0.7, max: 1.8, step: 0.1, default: 1 },
]

export const GRAPH_FORCE_RANGE = Object.fromEntries(
  GRAPH_FORCE_RANGES.map((control) => [control.prefKey, control]),
) as Record<GraphRangeControl['prefKey'], GraphRangeControl>

export const DEFAULT_PREFERENCES: GraphPreferences = {
  mode: 'global',
  depth: LIMITS.graphDepthDefault,
  limit: LIMITS.graphNodeLimitDefault,
  groupBy: 'none',
  colorGroups: [],
  folderId: '',
  tags: [],
  tagsMatch: 'any',
  pinnedNodeIds: [],
  excludedNoteIds: [],
  direction: 'both',
  ...GRAPH_TOGGLE_DEFAULTS,
  repulsion: GRAPH_FORCE_RANGE.repulsion.default,
  linkDistance: GRAPH_FORCE_RANGE.linkDistance.default,
  nodeScale: GRAPH_FORCE_RANGE.nodeScale.default,
}

const NOTE_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/

function boundedPreference(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function booleanPreference(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringList(value: unknown, limit: number, keep: (item: string) => string): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const kept = keep(item)
    if (kept) seen.add(kept)
  }
  return [...seen].slice(0, limit)
}

function idList(value: unknown, limit: number): string[] {
  return stringList(value, limit, (item) => (NOTE_ID_PATTERN.test(item) ? item : ''))
}

export function loadPreferences(storage?: Pick<Storage, 'getItem'>): GraphPreferences {
  const source = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  if (!source) return DEFAULT_PREFERENCES
  let stored: Record<string, unknown>
  try {
    const raw = source.getItem(GRAPH_PREFS_KEY)
    if (!raw) return DEFAULT_PREFERENCES
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_PREFERENCES
    stored = parsed as Record<string, unknown>
  } catch {
    return DEFAULT_PREFERENCES
  }
  return {
    mode: stored.mode === 'local' ? 'local' : 'global',
    depth: boundedPreference(stored.depth, DEFAULT_PREFERENCES.depth, LIMITS.graphDepthMin, LIMITS.graphDepthMax),
    limit: boundedPreference(stored.limit, DEFAULT_PREFERENCES.limit, LIMITS.graphNodeLimitMin, LIMITS.graphNodeLimitMax),
    includeOrphans: booleanPreference(stored.includeOrphans, DEFAULT_PREFERENCES.includeOrphans),
    includeUnresolved: booleanPreference(stored.includeUnresolved, DEFAULT_PREFERENCES.includeUnresolved),
    showTagNodes: booleanPreference(stored.showTagNodes, DEFAULT_PREFERENCES.showTagNodes),
    arrows: booleanPreference(stored.arrows, DEFAULT_PREFERENCES.arrows),
    labels: booleanPreference(stored.labels, DEFAULT_PREFERENCES.labels),
    groupBy: stored.groupBy === 'folder' || stored.groupBy === 'tag' ? stored.groupBy : 'none',
    colorGroups: readColorGroups(stored.colorGroups),
    folderId: typeof stored.folderId === 'string' && NOTE_ID_PATTERN.test(stored.folderId) ? stored.folderId : '',
    tags: readLegacyTags(stored),
    tagsMatch: stored.tagsMatch === 'all' ? 'all' : 'any',
    pinnedNodeIds: idList(stored.pinnedNodeIds, GRAPH_PINNED_MAX),
    excludedNoteIds: idList(stored.excludedNoteIds, LIMITS.graphExcludedMax),
    direction: stored.direction === 'incoming' || stored.direction === 'outgoing' ? stored.direction : 'both',
    exportWithoutTitles: booleanPreference(stored.exportWithoutTitles, DEFAULT_PREFERENCES.exportWithoutTitles),
    exportTransparentBackground: booleanPreference(
      stored.exportTransparentBackground, DEFAULT_PREFERENCES.exportTransparentBackground,
    ),
    repulsion: boundedPreference(stored.repulsion, DEFAULT_PREFERENCES.repulsion, GRAPH_FORCE_RANGE.repulsion.min, GRAPH_FORCE_RANGE.repulsion.max),
    linkDistance: boundedPreference(stored.linkDistance, DEFAULT_PREFERENCES.linkDistance, GRAPH_FORCE_RANGE.linkDistance.min, GRAPH_FORCE_RANGE.linkDistance.max),
    nodeScale: boundedPreference(stored.nodeScale, DEFAULT_PREFERENCES.nodeScale, GRAPH_FORCE_RANGE.nodeScale.min, GRAPH_FORCE_RANGE.nodeScale.max),
  }
}

function readLegacyTags(stored: Record<string, unknown>): string[] {
  const names = stringList(stored.tags, LIMITS.graphTagsMax, (item) => truncateText(item.trim(), LIMITS.tagNameMaxLength))
  const legacy = typeof stored.tag === 'string'
    ? truncateText(stored.tag.trim(), LIMITS.tagNameMaxLength)
    : ''
  if (legacy) names.push(legacy)
  const seen = new Set<string>()
  return names.filter((name) => {
    const key = name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, LIMITS.graphTagsMax)
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function readColorGroups(value: unknown): GraphColorGroup[] {
  if (!Array.isArray(value)) return []
  const groups: GraphColorGroup[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const query = typeof record.query === 'string' ? record.query.trim().slice(0, 120) : ''
    const color = typeof record.color === 'string' && HEX_COLOR.test(record.color) ? record.color : ''
    if (!query || !color) continue
    groups.push({
      id: typeof record.id === 'string' && record.id ? record.id.slice(0, 40) : `group-${groups.length}`,
      query,
      color,
    })
    if (groups.length >= GRAPH_COLOR_GROUP_LIMIT) break
  }
  return groups
}

export function persistPreferences(prefs: GraphPreferences, storage?: Pick<Storage, 'setItem'>): string | null {
  const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  const serialized = JSON.stringify(prefs)
  if (!target) return null
  try {
    target.setItem(GRAPH_PREFS_KEY, serialized)
  } catch {
    return null
  }
  return serialized
}

export function toggleListItem(list: readonly string[], value: string): string[] {
  const key = value.toLowerCase()
  return list.some((item) => item.toLowerCase() === key)
    ? list.filter((item) => item.toLowerCase() !== key)
    : [...list, value]
}
