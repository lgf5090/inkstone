/** One place where a driver's failure becomes the API's status and code. */
import type { ApiErrorCode } from '@shared/types'
import { ApiError } from '../../lib/errors'
import { DriverError } from './contract'

export function driverApiError(error: unknown): ApiError {
  if (error instanceof DriverError) {
    switch (error.kind) {
      case 'auth':
        return new ApiError(502, 'clouddrive_driver_auth', error.message)
      case 'rate_limit':
        return new ApiError(429, 'clouddrive_driver_rate_limit', error.message)
      case 'not_found':
        return new ApiError(404, 'clouddrive_driver_not_found', error.message)
      case 'unsupported':
        return new ApiError(400, 'clouddrive_driver_unsupported', error.message)
      case 'invalid':
        return new ApiError(400, 'clouddrive_driver_invalid', error.message)
      case 'upstream':
      default:
        return new ApiError(502, 'clouddrive_mount_unavailable' as ApiErrorCode, error.message)
    }
  }
  return new ApiError(502, 'clouddrive_mount_unavailable' as ApiErrorCode, error instanceof Error ? error.message : 'The storage driver failed')
}

/** Re-throws a non-driver failure untouched so bugs keep their original stack. */
export function rethrowDriver(error: unknown): never {
  if (error instanceof DriverError) throw driverApiError(error)
  throw error
}
