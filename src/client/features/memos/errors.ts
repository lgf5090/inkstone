import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'

export function memoErrorMessage(error: unknown): string {
  return error instanceof ApiError && error.message ? error.message : t('api.error.unknown')
}

export function memoIsAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
