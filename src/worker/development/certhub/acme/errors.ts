import { ApiError } from '../../../lib/errors'

export type AcmeFailureKind =
  | 'rate_limited'
  | 'bad_nonce'
  | 'unauthorized'
  | 'rejected_identifier'
  | 'order_not_ready'
  | 'dns'
  | 'dns_auth'
  | 'connection'
  | 'server'
  | 'invalid'
  | 'unknown'

export class AcmeFailure extends Error {
  constructor(
    readonly kind: AcmeFailureKind,
    readonly retryable: boolean,
    readonly retryAfterMs: number,
    readonly detail: string,
    readonly httpStatus: number,
  ) {
    super(detail)
    this.name = 'AcmeFailure'
  }
}

interface ProblemDetails {
  type?: string
  detail?: string
  status?: number
  subproblems?: Array<{ type?: string; detail?: string; identifier?: { value?: string } }>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function problemFrom(value: unknown): ProblemDetails | null {
  const record = asRecord(value)
  if (!record) return null
  return {
    type: typeof record.type === 'string' ? record.type : undefined,
    detail: typeof record.detail === 'string' ? record.detail : undefined,
    status: typeof record.status === 'number' ? record.status : undefined,
    subproblems: Array.isArray(record.subproblems)
      ? record.subproblems.filter((entry): entry is { type?: string; detail?: string; identifier?: { value?: string } } => Boolean(asRecord(entry)))
      : undefined,
  }
}

function retryAfterMs(raw: unknown): number {
  if (typeof raw !== 'string' || !raw.trim()) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3600_000, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.min(3600_000, Math.max(0, at - Date.now())) : 0
}

export function sanitizeAcmeDetail(value: string): string {
  return value
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

export function parseAcmeFailure(error: unknown): AcmeFailure {
  if (error instanceof AcmeFailure) return error
  // An ApiError is the app's own verdict, not an ACME problem document: it carries `code` and
  // `status` directly and has no `response`. Reading it as an axios error turned every DNS refusal
  // into "unknown, retry in 30 seconds", which is what made a permanent token problem repeat every
  // cron tick.
  if (error instanceof ApiError) {
    const detail = sanitizeAcmeDetail(error.message)
    if (error.code === 'dns_token_invalid' || error.code === 'dns_zone_forbidden' || error.code === 'dns_zone_mismatch') {
      return new AcmeFailure('dns_auth', false, 0, detail, error.status)
    }
    if (error.code === 'dns_network' || error.code === 'dns_rate_limited') {
      return new AcmeFailure('dns', true, 0, detail, error.status)
    }
    if (error.code === 'dns_error') {
      // Anything the DNS layer could not pin to a token/zone verdict is retryable unless its text is
      // one of the permanent refusals, preserving the old behaviour that only auth-like text was final.
      const permanent = /authentication error|unauthorized|forbidden|permission|invalid request headers|cannot access/i
        .test(detail)
      return new AcmeFailure(permanent ? 'dns_auth' : 'dns', !permanent, 0, detail, error.status)
    }
    if (error.status === 503) return new AcmeFailure('connection', true, 0, detail, error.status)
    return new AcmeFailure('invalid', false, 0, detail, error.status)
  }
  const record = asRecord(error)
  const response = asRecord(record?.response)
  const status = typeof response?.status === 'number' ? response.status : 0
  const headers = asRecord(response?.headers)
  const problem = problemFrom(response?.data)
  const type = problem?.type ?? ''
  const suffix = type.split(':').pop() ?? ''
  const detail = sanitizeAcmeDetail(problem?.detail ?? (typeof record?.message === 'string' ? record.message : '') ?? '')
  const retryAfter = retryAfterMs(headers?.['retry-after'] ?? headers?.['Retry-After'])
  const base = { retryAfterMs: retryAfter, detail: detail || 'acme request failed', httpStatus: status }
  if (status === 429 || suffix === 'rateLimited') {
    return new AcmeFailure('rate_limited', true, retryAfter || 60_000, base.detail, status)
  }
  if (suffix === 'badNonce') return new AcmeFailure('bad_nonce', true, retryAfter, base.detail, status)
  if (status === 401 || suffix === 'unauthorized') return new AcmeFailure('unauthorized', false, retryAfter, base.detail, status)
  if (suffix === 'rejectedIdentifier' || suffix === 'invalidIdentifier') {
    return new AcmeFailure('rejected_identifier', false, retryAfter, base.detail, status)
  }
  if (suffix === 'orderNotReady') return new AcmeFailure('order_not_ready', true, retryAfter, base.detail, status)
  if (suffix === 'dns' || suffix === 'connection') return new AcmeFailure('dns', true, retryAfter, base.detail, status)
  if (/forbidden by policy|rejected|not permitted|not allowed/.test(detail.toLowerCase())) {
    return new AcmeFailure('rejected_identifier', false, retryAfter, base.detail, status)
  }
  if (status >= 500) return new AcmeFailure('server', true, retryAfter || 30_000, base.detail, status)
  if (status > 0) return new AcmeFailure('invalid', false, retryAfter, base.detail, status)
  return new AcmeFailure('unknown', true, retryAfter || 30_000, base.detail, status)
}

export function acmeFailureToApi(error: unknown): ApiError {
  const failure = error instanceof AcmeFailure ? error : parseAcmeFailure(error)
  if (failure.kind === 'rate_limited') {
    return new ApiError(429, 'ca_rate_limited', 'The certificate authority asked this account to slow down')
  }
  if (failure.kind === 'rejected_identifier') {
    return new ApiError(422, 'acme_error', 'The certificate authority rejected one of the domains')
  }
  return new ApiError(502, 'ca_unavailable', 'The certificate authority request failed')
}
