import type { Memo } from '@shared/memos/types'
import { isImageAttachment } from './media'
import { formatCoordinate, memoPlaceLabel, normalizeMemoLocation } from './location'
import { memoFilterExpression, readMemoUrlState } from './url-state'

export const MEMO_MAP_FETCH_LIMIT = 100
export const MEMO_MAP_MAX_MEMOS = 5_000
export const MEMO_MAP_MAX_PAGES = MEMO_MAP_MAX_MEMOS / MEMO_MAP_FETCH_LIMIT
export const MEMO_MAP_MIN_ZOOM = 1
export const MEMO_MAP_MAX_ZOOM = 19
export const MEMO_MAP_DEFAULT_ZOOM = 2
export const MEMO_MAP_FOCUS_ZOOM = 14
export const MEMO_MAP_GROUP_PRECISION = 5
export const MEMO_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
export const MEMO_MAP_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
export const MEMO_MAP_WORLD_VIEW = {
  latitude: 20,
  longitude: 0,
  zoom: MEMO_MAP_DEFAULT_ZOOM,
} as const

export interface MemoMapView {
  latitude: number
  longitude: number
  zoom: number
}

export interface MemoMapUrlState {
  view: MemoMapView | null
  memoId: string | null
}

export interface MemoMapPointSelection {
  latitude: number
  longitude: number
  memoIds: string[]
}

export interface MemoMapPage {
  items: readonly Memo[]
  nextCursor: string | null
}

export interface MemoMapCollection {
  memos: Memo[]
  capped: boolean
}

export type MemoMapPinKind = 'photo' | 'initial' | 'dot'

export interface MemoMapPinGroup {
  key: string
  latitude: number
  longitude: number
  label: string
  memoIds: string[]
  count: number
  photoUrl: string | null
  initial: string | null
}

function roundToPrecision(value: number, precision: number): number {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function groupKey(latitude: number, longitude: number): string {
  return `${roundToPrecision(latitude, MEMO_MAP_GROUP_PRECISION)},${roundToPrecision(longitude, MEMO_MAP_GROUP_PRECISION)}`
}

function groupInitial(memo: Memo): string | null {
  const creator = memo.creator
  const name = creator?.name?.trim() || creator?.login?.trim() || creator?.username?.trim()
  if (!name) return null
  const first = Array.from(name)[0]
  return first ? first.toLocaleUpperCase() : null
}

function groupPhoto(memo: Memo): string | null {
  const attachment = memo.attachments.find(isImageAttachment)
  if (!attachment) return null
  return attachment.thumbnailUrl || attachment.url
}

export function memoMapPinKind(group: Pick<MemoMapPinGroup, 'photoUrl' | 'initial'>): MemoMapPinKind {
  if (group.photoUrl) return 'photo'
  if (group.initial) return 'initial'
  return 'dot'
}

export function buildMemoMapGroups(memos: readonly Memo[]): MemoMapPinGroup[] {
  const groups = new Map<string, MemoMapPinGroup>()
  for (const memo of memos) {
    const location = normalizeMemoLocation(memo.location)
    if (!location) continue
    const key = groupKey(location.latitude, location.longitude)
    const existing = groups.get(key)
    if (existing) {
      existing.memoIds.push(memo.id)
      existing.count += 1
      existing.photoUrl ??= groupPhoto(memo)
      existing.initial ??= groupInitial(memo)
      continue
    }
    groups.set(key, {
      key,
      latitude: location.latitude,
      longitude: location.longitude,
      label: memoPlaceLabel(location),
      memoIds: [memo.id],
      count: 1,
      photoUrl: groupPhoto(memo),
      initial: groupInitial(memo),
    })
  }
  return [...groups.values()]
}

export function memoMapGroupContaining(
  groups: readonly MemoMapPinGroup[],
  memoId: string,
): MemoMapPinGroup | null {
  return groups.find((group) => group.memoIds.includes(memoId)) ?? null
}

function urlNumber(raw: string | null): number {
  if (raw === null || raw.trim() === '') return Number.NaN
  return Number(raw)
}

export function readMemoMapUrl(search: string): MemoMapUrlState {
  const params = new URLSearchParams(search)
  const latitude = urlNumber(params.get('lat'))
  const longitude = urlNumber(params.get('lng'))
  const rawZoom = params.get('zoom')
  const zoom = rawZoom === null || rawZoom.trim() === '' ? MEMO_MAP_DEFAULT_ZOOM : Number(rawZoom)
  const view = Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180
    ? {
        latitude,
        longitude,
        zoom: Number.isInteger(zoom)
          ? Math.min(MEMO_MAP_MAX_ZOOM, Math.max(MEMO_MAP_MIN_ZOOM, zoom))
          : MEMO_MAP_DEFAULT_ZOOM,
      }
    : null
  const memoId = params.get('memo')?.trim() || null
  return { view, memoId }
}

export interface MemoMapSearchPatch {
  view?: MemoMapView | null
  memoId?: string | null
}

export function updateMemoMapSearch(search: string, patch: MemoMapSearchPatch): string {
  const params = new URLSearchParams(search)
  if (patch.view !== undefined) {
    if (patch.view === null) {
      params.delete('lat')
      params.delete('lng')
      params.delete('zoom')
    } else {
      params.set('lat', formatCoordinate(patch.view.latitude))
      params.set('lng', formatCoordinate(patch.view.longitude))
      params.set('zoom', String(patch.view.zoom))
    }
  }
  if (patch.memoId !== undefined) {
    if (patch.memoId) params.set('memo', patch.memoId)
    else params.delete('memo')
  }
  return params.toString()
}

export function hasMemoMapFilters(search: string): boolean {
  const state = readMemoUrlState(search)
  return state.q !== '' || state.tag !== null || state.filter.trim() !== ''
}

export function clearMemoMapFilters(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('q')
  params.delete('tag')
  params.delete('filter')
  return params.toString()
}

export function memoMapFilter(search: string): string {
  const state = readMemoUrlState(search)
  const clauses = ['has_location']
  const expression = memoFilterExpression(state.q, state.filter)
  if (expression) clauses.push(expression)
  if (state.tag) clauses.push(`tag == ${JSON.stringify(state.tag)}`)
  return clauses.join(' && ')
}

export async function collectMemoMapMemos(
  fetchPage: (cursor: string | null) => Promise<MemoMapPage>,
  max = MEMO_MAP_MAX_MEMOS,
): Promise<MemoMapCollection> {
  const memos: Memo[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  let hasMore = true
  let pages = 0
  while (hasMore && memos.length < max && pages < MEMO_MAP_MAX_PAGES) {
    const page = await fetchPage(cursor)
    pages += 1
    memos.push(...page.items)
    hasMore = Boolean(page.nextCursor)
    if (page.nextCursor) {
      if (seen.has(page.nextCursor)) {
        throw new Error('Memo map pagination returned the same cursor twice')
      }
      seen.add(page.nextCursor)
      cursor = page.nextCursor
    }
  }
  const truncated = memos.length > max
  if (truncated) memos.length = max
  return {
    memos,
    capped: truncated || (hasMore && (memos.length >= max || pages >= MEMO_MAP_MAX_PAGES)),
  }
}
