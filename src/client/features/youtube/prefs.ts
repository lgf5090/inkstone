/** UI preferences for the YouTube tab. They belong to this browser, not to the account. */
import { DEFAULT_YOUTUBE_PREFS, isSortKey, isTimeRange, type SortKey, type TimeRange } from '@shared/youtube/model'
import { IS_DEMO_MODE } from '../../lib/runtime'

export type YouTubeSection = 'channels' | 'playlists'

export interface YouTubeUiPrefs {
  sort: SortKey
  range: TimeRange
  sidebarWidth: number
  sidebarCollapsed: boolean
  splitRatio: number
  showComments: boolean
  expandedSections: YouTubeSection[]
  expandedTags: string[]
}

export const YOUTUBE_SIDEBAR_WIDTH = { min: 200, max: 360, default: 260, collapsed: 48 } as const
export const YOUTUBE_SPLIT_RATIO = { min: 0.28, max: 0.6, default: 0.4 } as const

const STORAGE_KEY = IS_DEMO_MODE ? 'inkstone.demo.youtube.ui.v1' : 'inkstone.youtube.ui.v1'

export function defaultYouTubeUiPrefs(): YouTubeUiPrefs {
  return {
    ...DEFAULT_YOUTUBE_PREFS,
    sidebarWidth: YOUTUBE_SIDEBAR_WIDTH.default,
    sidebarCollapsed: false,
    splitRatio: YOUTUBE_SPLIT_RATIO.default,
    showComments: true,
    expandedSections: ['channels', 'playlists'],
    expandedTags: [],
  }
}

export function loadYouTubeUiPrefs(storage: Storage | null = readStorage()): YouTubeUiPrefs {
  const base = defaultYouTubeUiPrefs()
  if (!storage) return base
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return base
    return normalize(JSON.parse(raw) as Partial<YouTubeUiPrefs>, base)
  } catch {
    return base
  }
}

export function saveYouTubeUiPrefs(prefs: YouTubeUiPrefs, storage: Storage | null = readStorage()): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // A refused write costs the next load its remembered layout, not the layout in force now.
  }
}

function normalize(value: Partial<YouTubeUiPrefs>, base: YouTubeUiPrefs): YouTubeUiPrefs {
  const sections = Array.isArray(value.expandedSections)
    ? value.expandedSections.filter((entry): entry is YouTubeSection => entry === 'channels' || entry === 'playlists')
    : base.expandedSections
  const tags = Array.isArray(value.expandedTags)
    ? value.expandedTags.filter((entry): entry is string => typeof entry === 'string')
    : base.expandedTags
  return {
    sort: typeof value.sort === 'string' && isSortKey(value.sort) ? value.sort : base.sort,
    range: typeof value.range === 'string' && isTimeRange(value.range) ? value.range : base.range,
    sidebarWidth: clamp(numberOr(value.sidebarWidth, base.sidebarWidth), YOUTUBE_SIDEBAR_WIDTH.min, YOUTUBE_SIDEBAR_WIDTH.max),
    sidebarCollapsed: typeof value.sidebarCollapsed === 'boolean' ? value.sidebarCollapsed : base.sidebarCollapsed,
    splitRatio: clamp(numberOr(value.splitRatio, base.splitRatio), YOUTUBE_SPLIT_RATIO.min, YOUTUBE_SPLIT_RATIO.max),
    showComments: typeof value.showComments === 'boolean' ? value.showComments : base.showComments,
    expandedSections: sections,
    expandedTags: tags.slice(0, 200),
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}
