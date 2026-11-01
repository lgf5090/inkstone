import type { IdPhotoCategory, IdPhotoSpec } from '@shared/tools/id-photo/types'
import { compileQuery, queryKeeps } from '../../../../lib/query-match'

export const SPEC_CATEGORIES = [
  { id: 'all', labelKey: 'tools.id_photo.spec.category_all' },
  { id: 'cn_standard', labelKey: 'tools.id_photo.spec.category_cn' },
  { id: 'exam_cert', labelKey: 'tools.id_photo.spec.category_exam' },
  { id: 'intl_passport', labelKey: 'tools.id_photo.spec.category_intl' },
  { id: 'visa', labelKey: 'tools.id_photo.spec.category_visa' },
  { id: 'custom', labelKey: 'tools.id_photo.spec.category_custom' },
] as const

export type SpecCategoryFilter = IdPhotoCategory | 'all'

export function specSearchTerms(spec: IdPhotoSpec, label: string): string[] {
  return [
    label,
    spec.name,
    spec.countryCode,
    spec.aspectRatioLabel ?? '',
    `${spec.widthMm}x${spec.heightMm}`,
    `${spec.widthPx}x${spec.heightPx}`,
  ].filter(Boolean)
}

export function filterSpecs(
  specs: readonly IdPhotoSpec[],
  search: string,
  category: SpecCategoryFilter,
  labelOf: (spec: IdPhotoSpec) => string,
): IdPhotoSpec[] {
  const query = compileQuery(search.trim())
  const inCategory = (spec: IdPhotoSpec) => category === 'all' || spec.category === category

  return specs.filter(
    (spec) => inCategory(spec) && specSearchTerms(spec, labelOf(spec)).some((term) => queryKeeps(query, term)),
  )
}
