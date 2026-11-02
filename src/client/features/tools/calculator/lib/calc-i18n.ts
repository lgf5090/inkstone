import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../../../lib/i18n'

export function calcT(key: string, params?: Record<string, string | number | boolean | null | undefined>): string {
  return t(key as MessageKey, params)
}
