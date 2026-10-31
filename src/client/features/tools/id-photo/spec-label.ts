import type { IdPhotoSpec } from '@shared/tools/id-photo/types'
import { t, type MessageKey } from '../../../lib/i18n'

export function specLabel(spec: IdPhotoSpec): string {
  return spec.nameKey ? t(spec.nameKey as MessageKey) : spec.name
}
