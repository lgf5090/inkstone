import type { Context } from 'hono'
import type { ApiErrorCode } from '@shared/types'

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'bad_request', message, details)
  }
  static unauthenticated(message = "Please sign in first") {
    return new ApiError(401, 'unauthenticated', message)
  }
  static forbidden(message = 'Permission denied') {
    return new ApiError(403, 'forbidden', message)
  }
  static notFound(message = 'Content not found', details?: unknown) {
    return new ApiError(404, 'not_found', message, details)
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, 'conflict', message, details)
  }
  static tooLarge(message: string) {
    return new ApiError(413, 'payload_too_large', message)
  }
}

/** A bounded, credential-free description for logs; never pass the original Error to the console. */
export function errorLogContext(err: unknown): { name: string; message: string } {
  const name = err instanceof Error ? err.name : 'Error'
  const raw = err instanceof Error ? err.message : String(err)
  const message = raw
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/((?:api[-_]?key|token|secret|password|authorization|sendkey)\s*[=:]\s*)[^\s,;&"'<>]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[\w.-]+/gi, '$1[redacted]')
    .replace(/\b(?:select|insert|update|delete|drop|alter|create|pragma|with)\b[\s\S]*/gi, '[sql]')
    .slice(0, 500)
  return { name: name.slice(0, 80), message }
}

export function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof ApiError) {
    return c.json(
      { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
      err.status,
    )
  }
  console.error('[inkstone] Unhandled error:', c.req.method, c.req.path, errorLogContext(err))

  return c.json({ error: { code: 'internal', message: "Internal server error" } }, 500)
}
