import { readMethods, readOrigins } from '@shared/development/xget/config-values'
import { ApiError } from '../../lib/errors'

export function normalizeMethods(value: string[]): string[] {
  const { methods, unknown } = readMethods(value)
  if (unknown.length) {
    throw new ApiError(400, 'xget_unsupported_method', `Unsupported method: ${unknown[0]}`, {
      method: unknown[0],
    })
  }
  if (!methods.length) {
    throw new ApiError(400, 'xget_methods_required', 'At least one method is required')
  }
  return methods
}

export function normalizeOrigins(value: string[]): string[] {
  const { origins, invalid } = readOrigins(value)
  if (invalid.length) {
    throw new ApiError(400, 'xget_invalid_origin', `Invalid CORS origin: ${invalid[0]}`, {
      origin: invalid[0],
    })
  }
  return origins
}
