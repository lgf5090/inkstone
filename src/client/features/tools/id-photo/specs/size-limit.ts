import type { IdPhotoSpec } from '@shared/tools/id-photo/types'

export const KB = 'KB'

/** A locale-neutral description of the file-size window a specification publishes, or null. */
export function describeSizeLimit(spec: Pick<IdPhotoSpec, 'fileSizeMinKb' | 'fileSizeMaxKb'>): string | null {
  const { fileSizeMinKb: min, fileSizeMaxKb: max } = spec
  if (min && max) return min === max ? `${min} ${KB}` : `${min}–${max} ${KB}`
  if (max) return `≤ ${max} ${KB}`
  if (min) return `≥ ${min} ${KB}`
  return null
}
