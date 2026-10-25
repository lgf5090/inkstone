/**
 * Ordering rules shared by the library tables.
 *
 * The all-music shelf and the favourites shelf offer the same three-state sort headers and the same
 * drag behaviour while a search hides some rows. Keeping the comparison, source vocabulary and the
 * visible-slice merge here means the two pages cannot disagree about what "source" means or where a
 * dragged row lands.
 */
import type { MusicTrack } from '@shared/music/model'

export type MusicTrackSortKey = 'title' | 'album' | 'duration' | 'source' | 'size'

export interface MusicTrackSort {
  key: MusicTrackSortKey
  direction: 'asc' | 'desc'
}

export type MusicTrackSource = 'upload' | 'webdav' | 'alist'

/** A downloaded online track is an R2 file even though its snapshot keeps the provider identity. */
export function trackSource(track: MusicTrack): MusicTrackSource {
  if (track.r2Key) return 'upload'
  if (track.provider === 'webdav' || track.provider === 'alist') return track.provider
  return 'upload'
}

export function compareTracks(
  left: MusicTrack,
  right: MusicTrack,
  key: MusicTrackSortKey,
  locale?: string,
): number {
  switch (key) {
    case 'title': return left.title.localeCompare(right.title, locale)
    case 'album': return left.album.localeCompare(right.album, locale)
    case 'duration': return left.durationMs - right.durationMs
    case 'size': return (left.size ?? 0) - (right.size ?? 0)
    case 'source': {
      const rank: Record<string, number> = { upload: 0, webdav: 1, alist: 2 }
      return (rank[trackSource(left)] ?? 3) - (rank[trackSource(right)] ?? 3)
    }
  }
}

/** Header clicks cycle ascending, descending, then back to the page's own default order. */
export function nextTrackSort(
  current: MusicTrackSort | null,
  key: MusicTrackSortKey,
): MusicTrackSort | null {
  if (!current || current.key !== key) return { key, direction: 'asc' }
  if (current.direction === 'asc') return { key, direction: 'desc' }
  return null
}

export function sortTracks<T extends MusicTrack>(
  tracks: readonly T[],
  sort: MusicTrackSort,
  locale?: string,
): T[] {
  const direction = sort.direction === 'asc' ? 1 : -1
  return [...tracks].sort((left, right) => direction * compareTracks(left, right, sort.key, locale))
}

/** A stored drag order; unknown ids keep the server's relative order after the known ones. */
export function orderByManualIds<T extends MusicTrack>(
  tracks: readonly T[],
  ids: readonly string[],
): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]))
  return tracks
    .map((track, index) => ({ track, index }))
    .sort((left, right) => {
      const leftRank = rank.get(left.track.id) ?? Number.MAX_SAFE_INTEGER
      const rightRank = rank.get(right.track.id) ?? Number.MAX_SAFE_INTEGER
      return leftRank - rightRank || left.index - right.index
    })
    .map((entry) => entry.track)
}

/**
 * Put a reordered visible slice back into the full order.
 *
 * Hidden rows keep their slots, so a search does not move the rows the reader cannot see. A slice
 * that is not a permutation of the visible ids is ignored rather than corrupting the saved order.
 */
export function mergeVisibleOrder(
  baseIds: readonly string[],
  visibleIds: readonly string[],
  reorderedVisibleIds: readonly string[],
): string[] {
  const visible = new Set(visibleIds)
  if (
    visibleIds.length !== reorderedVisibleIds.length
    || reorderedVisibleIds.some((id) => !visible.has(id))
    || new Set(reorderedVisibleIds).size !== reorderedVisibleIds.length
  ) {
    return [...baseIds]
  }
  let cursor = 0
  return baseIds.map((id) => (visible.has(id) ? reorderedVisibleIds[cursor++]! : id))
}

export const TRACK_ORDER_MAX_IDS = 10_000

export function readTrackOrder(storageKey: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, TRACK_ORDER_MAX_IDS)
      : []
  } catch {
    // A corrupted or unavailable local preference falls back to the server order.
    return []
  }
}

export function saveTrackOrder(storageKey: string, ids: readonly string[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(ids.slice(0, TRACK_ORDER_MAX_IDS)))
  } catch {
    // The order is a per-device convenience; a full or unavailable storage keeps the in-memory list.
  }
}
