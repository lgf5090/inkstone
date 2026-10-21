import { ApiError } from '../../../../lib/api'
import { memoErrorMessage } from '../../errors'

export function settingsErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.serverMessage ?? error.message
  return memoErrorMessage(error)
}
