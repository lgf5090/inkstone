import type { IdPhotoSpec } from '@shared/tools/id-photo/types'

export const MIN_COMPARE = 2
export const MAX_COMPARE = 4
export const COMPARE_MAX_EDGE = 300

export interface CompareSize {
  width: number
  height: number
}

export function compareSize(spec: IdPhotoSpec, maxEdge = COMPARE_MAX_EDGE): CompareSize {
  const longest = Math.max(spec.widthPx, spec.heightPx)
  if (!(longest > 0)) return { width: 1, height: 1 }
  const ratio = Math.min(1, maxEdge / longest)
  return {
    width: Math.max(1, Math.round(spec.widthPx * ratio)),
    height: Math.max(1, Math.round(spec.heightPx * ratio)),
  }
}

/** The strip always holds at least two frames, so the active spec is joined by its neighbours. */
export function defaultCompareIds(activeId: string, specs: readonly IdPhotoSpec[]): string[] {
  const ids: string[] = []
  if (specs.some((spec) => spec.id === activeId)) ids.push(activeId)
  for (const spec of specs) {
    if (ids.length >= Math.min(MIN_COMPARE, specs.length)) break
    if (!ids.includes(spec.id)) ids.push(spec.id)
  }
  return ids
}

export function toggleCompareId(ids: string[], id: string): { ids: string[]; refused: 'none' | 'min' | 'max' } {
  if (ids.includes(id)) {
    if (ids.length <= MIN_COMPARE) return { ids, refused: 'min' }
    return { ids: ids.filter((entry) => entry !== id), refused: 'none' }
  }
  if (ids.length >= MAX_COMPARE) return { ids, refused: 'max' }
  return { ids: [...ids, id], refused: 'none' }
}
