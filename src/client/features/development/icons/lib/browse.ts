import type { IconFormat, IconSmartView, IconSort } from '@shared/development/icons/types'

export type IconViewMode = 'grid' | 'list' | 'table'
export type IconDensity = 'small' | 'medium' | 'large'
export type IconStyleFilter = '' | 'line' | 'fill' | 'duotone' | 'brand'
export type IconColorFilter = '' | 'mono' | 'multi'

export interface BrowseState {
  q: string
  sort: IconSort
  state: IconSmartView
  view: IconViewMode
  density: IconDensity
  pageSize: number
  collections: string[]
  formats: IconFormat[]
  tags: string[]
  style: IconStyleFilter
  colorMode: IconColorFilter
  sizeMin: string
  sizeMax: string
  from: string
  to: string
}

export const DEFAULT_BROWSE: BrowseState = {
  q: '',
  sort: 'created',
  state: 'all',
  view: 'grid',
  density: 'medium',
  pageSize: 60,
  collections: [],
  formats: [],
  tags: [],
  style: '',
  colorMode: '',
  sizeMin: '',
  sizeMax: '',
  from: '',
  to: '',
}

const STORAGE_KEY = 'inkstone.icons.browse.v2'
const VIEWS: readonly IconViewMode[] = ['grid', 'list', 'table']
const DENSITIES: readonly IconDensity[] = ['small', 'medium', 'large']
const SORTS: readonly IconSort[] = ['created', 'updated', 'name', 'used']
const STATES: readonly IconSmartView[] = ['all', 'favorites', 'pinned', 'recent', 'uncategorized']
const FORMATS: readonly IconFormat[] = ['svg', 'png', 'jpg', 'webp']
const STYLES: readonly IconStyleFilter[] = ['', 'line', 'fill', 'duotone', 'brand']
const COLORS: readonly IconColorFilter[] = ['', 'mono', 'multi']

function pick<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function list(value: string | null | undefined): string[] {
  return value ? value.split(',').map((part) => part.trim()).filter(Boolean) : []
}

function dayStart(value: string): number | undefined {
  if (!value) return undefined
  const time = Date.parse(`${value}T00:00:00`)
  return Number.isFinite(time) ? time : undefined
}

export function readBrowseState(): BrowseState {
  if (typeof window === 'undefined') return DEFAULT_BROWSE
  let stored: Partial<BrowseState> = {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) stored = JSON.parse(raw) as Partial<BrowseState>
  } catch {
    stored = {}
  }
  const params = new URLSearchParams(window.location.search)
  const has = (key: string): boolean => params.has(key)
  const value = (key: string, fallback: string): string => (has(key) ? params.get(key) ?? '' : fallback)
  return {
    q: value('q', stored.q ?? ''),
    sort: pick(value('sort', stored.sort ?? 'created'), SORTS, 'created'),
    state: pick(value('state', stored.state ?? 'all'), STATES, 'all'),
    view: pick(value('view', stored.view ?? 'grid'), VIEWS, 'grid'),
    density: pick(value('density', stored.density ?? 'medium'), DENSITIES, 'medium'),
    pageSize: Number(value('page', String(stored.pageSize ?? 60))) === 120 ? 120 : 60,
    collections: has('collections') ? list(params.get('collections')) : stored.collections ?? [],
    formats: (has('formats') ? list(params.get('formats')) : stored.formats ?? []).filter((format) => FORMATS.includes(format as IconFormat)) as IconFormat[],
    tags: has('tags') ? list(params.get('tags')) : stored.tags ?? [],
    style: pick(value('style', stored.style ?? ''), STYLES, ''),
    colorMode: pick(value('color', stored.colorMode ?? ''), COLORS, ''),
    sizeMin: value('smin', stored.sizeMin ?? ''),
    sizeMax: value('smax', stored.sizeMax ?? ''),
    from: value('from', stored.from ?? ''),
    to: value('to', stored.to ?? ''),
  }
}

export function writeBrowseState(state: BrowseState): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  const set = (key: string, value: string): void => {
    if (value) params.set(key, value)
    else params.delete(key)
  }
  set('q', state.q)
  set('view', state.view)
  set('density', state.density)
  set('sort', state.sort)
  set('state', state.state === 'all' ? '' : state.state)
  set('collections', state.collections.join(','))
  set('formats', state.formats.join(','))
  set('tags', state.tags.join(','))
  set('style', state.style)
  set('color', state.colorMode)
  set('smin', state.sizeMin)
  set('smax', state.sizeMax)
  set('from', state.from)
  set('to', state.to)
  set('page', state.pageSize === 60 ? '' : String(state.pageSize))
  const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`
  window.history.replaceState(window.history.state, '', next)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Private modes can refuse storage; the URL still carries the same selection.
  }
}

/** The API names a comma list for every multi-select and keeps the single-value keys for old links. */
export function browseQuery(state: BrowseState): Record<string, string | number | undefined> {
  return {
    limit: state.pageSize,
    q: state.q || undefined,
    sort: state.sort,
    state: state.state,
    collections: state.collections.length ? state.collections.join(',') : undefined,
    formats: state.formats.length ? state.formats.join(',') : undefined,
    tags: state.tags.length ? state.tags.join(',') : undefined,
    style: state.style || undefined,
    colorMode: state.colorMode || undefined,
    sizeMin: state.sizeMin ? Number(state.sizeMin) : undefined,
    sizeMax: state.sizeMax ? Number(state.sizeMax) : undefined,
    from: dayStart(state.from),
    to: state.to ? (dayStart(state.to) ?? 0) + 24 * 60 * 60 * 1000 - 1 : undefined,
  }
}

export function activeFilterCount(state: BrowseState): number {
  return (
    state.collections.length +
    state.formats.length +
    state.tags.length +
    (state.style ? 1 : 0) +
    (state.colorMode ? 1 : 0) +
    (state.sizeMin ? 1 : 0) +
    (state.sizeMax ? 1 : 0) +
    (state.from ? 1 : 0) +
    (state.to ? 1 : 0)
  )
}

export function clearFilters(state: BrowseState): BrowseState {
  return {
    ...state,
    collections: [],
    formats: [],
    tags: [],
    style: '',
    colorMode: '',
    sizeMin: '',
    sizeMax: '',
    from: '',
    to: '',
  }
}
