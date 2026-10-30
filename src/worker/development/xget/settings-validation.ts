import { XGET_KNOWN_METHODS } from '@shared/development/xget/constants'
import { ApiError } from '../../lib/errors'

export function normalizeMethods(value: string[]): string[] {
  const known = new Set<string>(XGET_KNOWN_METHODS)
  const methods = [...new Set(value.map((entry) => entry.trim().toUpperCase()).filter(Boolean))]
  if (!methods.length) throw new ApiError(400, 'xget_methods_required', 'At least one method is required')
  const unsupported = methods.find((method) => !known.has(method))
  if (unsupported) {
    throw new ApiError(400, 'xget_unsupported_method', `Unsupported method: ${unsupported}`, {
      method: unsupported,
    })
  }
  return methods
}

export function normalizeOrigins(value: string[]): string[] {
  const entries = value.map((entry) => entry.trim()).filter(Boolean)
  if (entries.includes('*')) return ['*']

  const origins: string[] = []
  for (const entry of entries) {
    let parsed: URL
    try {
      parsed = new URL(entry)
    } catch {
      throw new ApiError(400, 'xget_invalid_origin', `Invalid CORS origin: ${entry}`, { origin: entry })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(400, 'xget_invalid_origin', `Invalid CORS origin: ${entry}`, { origin: entry })
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new ApiError(400, 'xget_invalid_origin', `Invalid CORS origin: ${entry}`, { origin: entry })
    }
    const origin = parsed.origin
    if (!origins.includes(origin)) origins.push(origin)
  }
  return origins
}
